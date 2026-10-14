/**
 * 下一步建议：一轮做完后，猜人下一句要说什么，交给窗口放在输入框里当灰字。
 *
 * 请求从刚发出去的那次主请求分叉（`compaction-fork.ts` 的 `forkContext`）：工具、系统提示词、
 * thinking、缓存键和消息都和上一次一样，只在末尾多一条指令。前缀几秒前刚写进缓存，这次请求基本
 * 只付缓存读和几十个输出 token；单独拼一份短请求反而要按原价读一遍对话，还猜不准。
 *
 * 只在三件事都成立时发：
 *
 * - 宿主点名打开（`AgentSessionOptions.suggestNextPrompt`）且设置里开着。命令行跑完一个任务就
 *   退出，侧边聊天另有输入框，都不该付这笔钱。
 * - 上一次主请求读过或写过缓存。服务商不报告缓存时，分叉等于整段上下文按原价再读一遍。
 * - 能热分叉（`hotFork`）：同一个模型、缓存还热。
 *
 * thinking 照主请求带：改了它消息部分的缓存就作废。代价是开着推理的模型会先想一会儿，那部分输出
 * 省不掉，记在 `usage` 里（`source: "next-prompt"`），在设置页能看到。
 *
 * 结果作废的规矩和标题摘要一样（`session-title.ts`）：轮次是取消的凭据。下一轮开始、历史被改写、
 * 设置关掉，回来的结果都丢掉。用量照记——服务商已经收过钱了。
 */

import type { AssistantMessage, Message } from "../types.ts";
import { contextMaxTokens } from "../tokens.ts";
import { forkContext, prefixGuard } from "./compaction/compaction-fork.ts";
import { hotFork } from "./compaction/idle-compaction.ts";
import type { CompactionParts } from "./compaction/manual-compaction.ts";
import { summaryStream } from "./session-turn.ts";

/** 一句建议等多久。人这时多半已经在看回复了，晚到的建议只会在他开始打字之后冒出来。 */
const NEXT_PROMPT_TIMEOUT_MS = 20_000;

/** 对话太短时猜不出人的习惯和去向，猜出来的多半是万能句（qwen-code 同样从第二条回复起才猜）。 */
const MIN_ASSISTANT_REPLIES = 2;

/**
 * 输出上限按主循环的算法折算后低于这个数就不发：thinking 的预算跟着上限走，太小的话推理会把它
 * 吃光，什么也写不出来。
 */
const MIN_OUTPUT_TOKENS = 256;

/*
 * 结构照 Claude Code / qwen-code 的那一份（`followup/suggestionGenerator.ts`）。第一版只说「猜下一句，
 * 比如检查结果、提交」，那两个例子把模型引向和眼前这件事无关的万能句。要紧的是三处：先看回复末尾
 * （下一步、选项、提示都在那里），以人原本要的为准而不是模型觉得该做什么，以及什么时候闭嘴。
 */
export const NEXT_PROMPT_INSTRUCTION = `[SUGGESTION MODE] Do not continue the task. Instead, guess the next message the user will type into this chat.

FIRST read the last few lines of your most recent reply: that is where next steps, options and hints usually are. Then look at the user's recent messages and what they originally asked for.

Predict what THEY would type, not what you think they should do. The test: would they think "I was just about to type that"?

- Your last reply tells them to type or run something specific ("type /review to start") → suggest exactly that.
- You offered options → the one they would most likely pick, judging by the conversation.
- You asked whether to go on → a plain yes in their words, such as "继续" or "go ahead".
- They asked for several things and some are not done → the next one. They asked to fix a bug and run the tests, the bug is fixed → "跑一下测试" / "run the tests".
- The task is complete and a follow-up is obvious → name it, such as "提交一下" / "commit this".
- Something just failed, or you misunderstood them → stay silent and let them assess it.

Be specific: "跑一下登录页的测试" beats "继续".

Never suggest:
- evaluations or thanks ("看起来不错", "谢谢", "looks good")
- questions
- your own voice ("我来…", "Let me…", "I'll…")
- new ideas they did not ask about
- more than one sentence

Match how the user writes: their language, length and tone. 2 to 12 words, or at most 20 characters in Chinese or Japanese.

Do not call tools. Reply with the suggestion alone: no quotes, no label, no explanation. If the next step is not obvious from what they said, reply with nothing.`;

export interface NextPromptDeps {
	enabled: () => boolean;
	parts: () => CompactionParts;
	/** 会话此刻的历史。和出发时不是同一份、或长度变了，这条建议就过时了。 */
	history: () => readonly Message[];
	emit: (text: string) => Promise<void>;
}

export class NextPrompt {
	private readonly deps: NextPromptDeps;
	private abort: AbortController | null = null;
	private task: Promise<void> | null = null;
	/** 取消的凭据，不是计数器：回来的那次拿出发时的号码比一下。 */
	private epoch = 0;

	constructor(deps: NextPromptDeps) {
		this.deps = deps;
	}

	cancel(): void {
		this.epoch++;
		this.abort?.abort();
		this.abort = null;
	}

	/** 还在跑的那次，`dispose` 要等它：宿主处置完可能立刻删日志，而它还要写一条用量。 */
	pending(): Promise<void> | null {
		return this.task;
	}

	/** 一轮干净收尾、会话闲下来以后调。 */
	suggest(): void {
		this.cancel();
		if (!this.deps.enabled()) return;
		const epoch = this.epoch;
		const history = this.deps.history();
		const length = history.length;
		const controller = new AbortController();
		this.abort = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(NEXT_PROMPT_TIMEOUT_MS)]);
		const current = () =>
			epoch === this.epoch && !signal.aborted && this.deps.enabled() && this.deps.history() === history && history.length === length;
		const task = this.run(history, signal, current).catch(() => {
			// 建议没拿到不影响任何东西，输入框照旧显示默认的占位文字。
		});
		this.task = task;
		void task.finally(() => {
			if (this.task === task) this.task = null;
			if (this.abort === controller) this.abort = null;
		});
	}

	private async run(history: readonly Message[], signal: AbortSignal, current: () => boolean): Promise<void> {
		if (history.filter((message) => message.role === "assistant").length < MIN_ASSISTANT_REPLIES) return;
		const last = history.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (!last || last.usage.cacheRead + last.usage.cacheWrite === 0) return;
		const parts = this.deps.parts();
		const fork = await hotFork(parts);
		if (!fork || !current()) return;
		const { provider, model, lineage } = fork;
		const context = forkContext(lineage, NEXT_PROMPT_INSTRUCTION);
		const maxTokens = contextMaxTokens(model, context, lineage.sent.maxTokens);
		if (maxTokens < MIN_OUTPUT_TOKENS) return;
		const guard = prefixGuard(lineage, signal);
		const { log } = parts;
		const stream = summaryStream(parts.streamFn, { signal: guard.signal }, (spent) => log.append({ type: "usage", source: "next-prompt", ...spent }));
		const replies = stream(provider, model, context, {
			thinking: lineage.sent.thinking, temperature: lineage.sent.temperature, maxTokens, cacheKey: lineage.sent.cacheKey,
			signal: guard.signal, onPayload: guard.onPayload,
			// 一句建议不值得重试：等重试回来，人多半已经开始打字了。
			retryAttempts: 0,
		});
		let next: IteratorResult<unknown, AssistantMessage>;
		do { next = await replies.next(); } while (!next.done);
		if (!current() || guard.prefix()?.change) return;
		const text = nextPromptText(next.value);
		if (text) await this.deps.emit(text);
	}
}

/** 单个英文词通常是半句话；这几个是人真会单独打的。 */
const SINGLE_WORDS = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "continue", "commit", "push", "deploy", "stop", "check", "no"]);

/** 中日韩文字：没有空格分词，长度按字算。 */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** 模型回的那句能不能当建议用；不能就是 null。过滤规则对照 qwen-code 的 `getFilterReason`。 */
export function nextPromptText(reply: AssistantMessage): string | null {
	if (reply.stopReason !== "stop") return null;
	if (reply.content.some((part) => part.type === "toolCall")) return null;
	const text = reply.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.trim()
		.replace(/^["“'‘`「]+|["”'’`」]+$/g, "")
		.trim();
	if (!text) return null;
	// 换行和控制字符：它会原样进占位文字和输入框。
	// oxlint-disable-next-line no-control-regex -- 要拦的正是控制字符
	if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return null;
	// 说了「猜不出就什么也别写」，还是有模型写一句「无」「（没有建议）」「建议：…」。
	if (/^(none|null|n\/a|nothing( to suggest)?|no suggestion|silence|无|没有|无建议|没有建议|暂无)\W*$/i.test(text)) return null;
	if (/^[(（[【].*[)）\]】]$/.test(text)) return null;
	if (/^(建议|下一步|用户|suggestion|next( step)?|user)\s*[:：]/i.test(text)) return null;
	if (/\*\*|^[-*#>]\s/.test(text)) return null;
	if (CJK.test(text)) {
		const length = [...text].length;
		if (length < 2 || length > 30) return null;
	} else {
		const words = text.split(/\s+/).length;
		if (words < 2 && !text.startsWith("/") && !SINGLE_WORDS.has(text.toLowerCase().replace(/[.!]$/, ""))) return null;
		if (words > 12) return null;
	}
	if (text.length >= 100) return null;
	// 不止一句：句末标点后面还有话。
	if (/[.!?]\s+[A-Z]|[。！？；].+/.test(text)) return null;
	if (/\b(thanks|thank you|looks good|sounds good|that works|perfect|great|nice|awesome|makes sense)\b|谢谢|感谢|辛苦|看起来不错|没问题了|完美|太棒/i.test(text)) return null;
	// 助手口吻：它在接着干活，不是在替人说话。
	if (/^(let me|i'll|i've|i'm|i can|i would|i think|here's|here is|here are|you can|you should|you could|sure,|of course|certainly)\b/i.test(text)) return null;
	if (/^(我来|我将|我已经|以下是|你可以|您可以|好的[，,]|当然)/.test(text)) return null;
	return text;
}
