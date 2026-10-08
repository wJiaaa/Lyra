/**
 * 写给回来的人看的会话回顾：做到哪了、还剩什么、要不要他动手。
 *
 * 和压缩摘要是两回事。那份写给模型，长、结构化，只在上下文快满时才有；这份写给人，一句话，
 * 不进模型的上下文——混进去既花 token，又让模型把自己写的概括当成事实。
 *
 * 增量地写，做法照 synara 的 thread recap：上一版回顾加上那之后新增的对话，让模型改写成新的
 * 一版。不是每次把整条转录重读一遍——一个跑了几百轮的会话，回顾的输入仍然只有几千字。
 *
 * 只认人说的和模型答的正文。工具调用不进素材：几百次 grep 是噪音，真正改了什么由 `filesSeen`
 * 列成一行状态交给它。
 */

import { streamAssistant } from "../ai/index.ts";
import { resolveModel } from "../config/models.ts";
import { resolveModelRef } from "../config/model-roles.ts";
import type { Settings } from "../config/settings.ts";
import type { SessionRecap, SessionRecordInput } from "../session/types.ts";
import type { Message } from "../types.ts";
import { filesSeen } from "./compaction.ts";
import { taskContextFromHistory } from "./task-context.ts";

const RECAP_TIMEOUT_MS = 20_000;
/** 提示词要 120 字以内；硬上限留些余量，模型数字数和我们数码点不总是一致，差几个字不该被截断。 */
const RECAP_CHARS = 160;
/** 第一版要有足够的来龙去脉；之后只看新增的那几条。 */
const FIRST_MESSAGES = 8;
const DELTA_MESSAGES = 6;
const MESSAGE_CHARS = 600;
const MATERIAL_CHARS = 6000;
const CHANGED_FILES = 8;

const RECAP_SYSTEM = [
	"你在为一段编程助手的对话写回顾，读者是离开一阵后回来的用户。他要一眼知道：在做什么、做到哪了、接下来要他做什么。",
	"规则：",
	"1. 只写一句话，不超过 120 个字，不换行；",
	"2. 先说最近完成的具体工作，有没做完的、卡住的，或需要用户决定的事，接在同一句里；",
	"3. 只写素材里有的事实，不编造完成的工作、文件、测试或决定；",
	"4. 使用与对话相同的语言；",
	"5. 只输出回顾正文：不加标题、前缀、编号、项目符号或 Markdown；",
	"6. 新素材里没有值得更新的内容时，原样返回上一版回顾。",
].join("\n");

type RecapRecord = Extract<SessionRecordInput, { type: "recap" }>;

/** 回顾写在什么上，就拿什么来比——见 `SessionRecap`。 */
export function recapCovers(recap: SessionRecap | undefined, messages: readonly Message[]): boolean {
	if (!recap) return false;
	return recap.covered === messages.length && recap.coveredAt === (messages.at(-1)?.timestamp ?? 0);
}

function squeeze(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const points = [...flat];
	return points.length <= max ? flat : `${points.slice(0, max).join("")}…`;
}

function spoken(message: Message): string | null {
	if (message.role === "user") {
		if (message.synthetic) return null;
		const text = message.displayText ?? message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		return text.trim() ? `用户：${squeeze(text, MESSAGE_CHARS)}` : null;
	}
	if (message.role === "assistant") {
		const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		return text.trim() ? `助手：${squeeze(text, MESSAGE_CHARS)}` : null;
	}
	return null;
}

/**
 * 这一次要交给模型的东西；没有新内容时为 null。
 *
 * 上一版只在它确实是这条转录的前缀时才拿来续写：撤回、编辑过之后，旧回顾说的可能是一段已经
 * 不存在的对话，那时从头写一版。
 */
export function recapSource(messages: readonly Message[], previous?: SessionRecap): { material: string; state: string; previous?: string } | null {
	const continues = previous !== undefined && previous.covered <= messages.length && messages[previous.covered - 1]?.timestamp === previous.coveredAt;
	const fresh = continues ? messages.slice(previous.covered) : messages;
	const lines = fresh.map(spoken).filter((line): line is string => line !== null).slice(-(continues ? DELTA_MESSAGES : FIRST_MESSAGES));
	if (lines.length === 0) return null;
	let material = lines.join("\n");
	if (material.length > MATERIAL_CHARS) material = material.slice(material.length - MATERIAL_CHARS);

	const state: string[] = [];
	const todos = taskContextFromHistory([...messages]).todos;
	if (todos?.length) {
		const open = todos.filter((todo) => todo.status !== "completed");
		state.push(`计划：${todos.length - open.length}/${todos.length} 完成${open.length ? `；未完成：${open.map((todo) => squeeze(todo.content, 60)).join("；")}` : ""}`);
	}
	const changed = filesSeen([...fresh]).changed.slice(-CHANGED_FILES);
	if (changed.length) state.push(`改过的文件：${changed.join("、")}`);
	const last = messages.at(-1);
	if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
		state.push(last.stopReason === "error" ? "最后一轮出错停下" : "最后一轮被中断");
	}
	return { material, state: state.join("\n"), ...(continues ? { previous: previous.text } : {}) };
}

/** 模型偶尔还是会加编号、符号或前缀，或者不听话写成几行；按行剥掉，只留第一句。 */
export function cleanRecap(raw: string): string {
	const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^```[a-z]*\n?([\s\S]*?)```$/i, "$1");
	const first = text
		.split("\n")
		.map((line) => line.trim().replace(/^(?:[-*•·]|\d+[.、)])\s*/, "").replace(/^(?:回顾|Recap)\s*[:：]\s*/i, "").trim())
		.find(Boolean);
	return first ? squeeze(first, RECAP_CHARS) : "";
}

export type RecapOutcome =
	| { record: RecapRecord }
	/** `empty`：没有可写的内容；`model`：没有可用的模型。都没有发请求。 */
	| { skipped: "empty" | "model" };

/**
 * 写一版回顾，交回要追加的那条记录。
 *
 * 不自己写日志：活着的会话要经它自己的日志写，否则它手里那份 meta 会落后；没活的直接写存储。
 * 哪一种由调用方知道。
 */
export async function writeRecap(options: {
	messages: readonly Message[];
	previous?: SessionRecap;
	settings: Settings;
	/** 会话自己的模型，空串表示跟默认。优先用 `@fast`。 */
	modelId: string;
	stream?: typeof streamAssistant;
	signal?: AbortSignal;
}): Promise<RecapOutcome> {
	const source = recapSource(options.messages, options.previous);
	if (!source) return { skipped: "empty" };
	const resolved = resolveModel(options.settings, options.modelId || options.settings.defaultModelId);
	if (!resolved) return { skipped: "model" };
	const chosen = resolveModelRef(options.settings, "@fast", resolved);
	const input = [
		`上一版回顾：\n${source.previous ?? "（无）"}`,
		`新增的对话：\n${source.material}`,
		`当前状态：\n${source.state || "（无）"}`,
	].join("\n\n");
	const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(RECAP_TIMEOUT_MS)]) : AbortSignal.timeout(RECAP_TIMEOUT_MS);
	const stream = (options.stream ?? streamAssistant)(
		chosen.provider,
		chosen.model,
		{ systemPrompt: RECAP_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }], tools: [] },
		{ thinking: "off", maxTokens: Math.min(400, chosen.model.maxOutputTokens), retryPolicy: () => options.settings.retryPolicy, signal },
	);
	let final: Awaited<ReturnType<typeof stream.next>>;
	do final = await stream.next();
	while (!final.done);
	const reply = final.value;
	const last = options.messages.at(-1);
	const record: RecapRecord = {
		type: "recap",
		covered: options.messages.length,
		coveredAt: last?.timestamp ?? 0,
		providerId: chosen.provider.id,
		modelId: chosen.model.modelId,
		usage: reply.usage,
	};
	// 中断或出错也照样交回记录：服务商已经收了钱，用量要记；没有 `text`，旧回顾保持原样。
	if (reply.stopReason === "error" || reply.stopReason === "aborted") return { record };
	const text = cleanRecap(reply.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join(""));
	return { record: text ? { ...record, text } : record };
}
