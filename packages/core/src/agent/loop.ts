import { compactStep, type CompactHistory } from "./compact-step.ts";
import type { RetryPolicySource } from "../config/retry-policy.ts";
/**
 * The agent loop.
 *
 * One turn = one assistant response plus every tool it asked for. The loop keeps turning
 * while the model emits tool calls, and drains a steering queue between turns so the user
 * can redirect a running agent without cancelling it.
 */

import { originalInView, REPEAT_WARN, repeatNotice, RepetitionWatch } from "./repetition.ts";
import type { RuleMatch } from "../rules/stream.ts";
import { extractPaths } from "../rules/stream.ts";
import { failTruncatedCalls, runTools } from "./tool-run.ts";
import { streamAssistant } from "../ai/index.ts";
import { comparePrefix, payloadSegments, type PrefixSegment } from "../ai/prefix-fingerprint.ts";
import { isContextOverflow } from "../ai/failure.ts";
import { stripOversizedToolResults } from "../runtime/prune.ts";
import type { ArtifactSink } from "../runtime/prune.ts";
import { AgedToolPruner } from "../runtime/aged-prune.ts";
import { requestPrompt } from "../runtime/cache-diagnostics.ts";
import { contextMaxTokens } from "../runtime/context.ts";
import { stripStaleHandles } from "../runtime/model-switch.ts";
import { withEnvironment } from "../prompt/environment.ts";
import { clearActiveSkill, syncSkillContext } from "../skills/tool.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	AssistantMessage,
	LlmContext,
	Message,
	ModelConfig,
	ProviderConfig,
	ThinkingLevel,
	Tool,
	ToolContext,
	ToolResult,
} from "../types.ts";
import type { AgentEventSink } from "./events.ts";

export interface AgentRunConfig {
	sessionId: string;
	cwd: string;
	provider: ProviderConfig;
	model: ModelConfig;
	/**
	 * 这场对话此刻该用哪个模型——由会话给，一轮之内也能变。
	 *
	 * `provider` / `model` 是这一轮开始时的那个。从前整轮都用它：人在一轮中途换了模型，剩下的
	 * 几十个请求照旧发给旧的；旧的上游坏了、正在一刻不停地重试时，换模型等于没换——界面上写着
	 * 「Model B」，服务器收到的一直是 a（`e2e/edit-resend-model-probe.ts` 量出来的）。重试策略早就
	 * 是每次重试前现读的（`retry-policy.ts` 的 `RetryPolicySource`），模型是同一个道理。
	 *
	 * 省略就是整轮不变：子代理、侧聊、评测、测试都是这样。
	 */
	liveModel?: LiveModel;
	systemPrompt: string;
	tools: Tool[];
	messages: Message[];
	thinking?: ThinkingLevel;
	/** Attempts per request, including the first; see `Settings.retryAttempts`. */
	retryAttempts?: number;
	retryPolicy?: RetryPolicySource;
	maxTokens?: number;
	temperature?: number;
	maxTurns?: number;
	/**
	 * 盯着「这一轮有没有在原地打转」的那只表，由调用方给，**跨整条续跑链共用一只**。
	 *
	 * 不在这里 `new` 的原因是这个函数会被续跑反复调用（`runtime/continuation.ts`）：每次新建一只，
	 * 计数就清零，于是跑满两百轮换来的全部观察在续跑的瞬间归零，看门狗永远攒不够。真实日志里那个
	 * 会话跑了 588 轮、agent 起停五次，而每一段都以为自己是第一段。
	 *
	 * 省略时自己建一只——单次调用（子代理、评测、测试）本来就没有「上一段」。
	 */
	repetition?: RepetitionWatch;
	pruner?: AgedToolPruner;
	artifacts?: ArtifactSink;
	signal?: AbortSignal;
	/** Session-scoped scratch space shared by every tool. */
	state?: Map<string, unknown>;
	requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	/** Passed through to the tools; see `ToolContext.sandboxMode`. */
	sandboxMode?: ToolContext["sandboxMode"];
	/** Passed through to the tools; see `ToolContext.sandboxNetwork`. */
	sandboxNetwork?: ToolContext["sandboxNetwork"];
	/** Passed through to the tools; see `ToolContext.allowedHosts`. */
	allowedHosts?: ToolContext["allowedHosts"];
	/** Passed through to the tools; see `ToolContext.searchProviderId`. */
	searchProviderId?: ToolContext["searchProviderId"];
	/** Passed through to the tools; see `ToolContext.allowedPaths`. */
	allowedPaths?: ToolContext["allowedPaths"];
	/** Passed through to the tools; see `ToolContext.projectRoots`. */
	projectRoots?: ToolContext["projectRoots"];
	/** Passed through to the tools; see `ToolContext.writePreview`. */
	writePreview?: ToolContext["writePreview"];
	spawnSubAgent?: ToolContext["spawnSubAgent"];
	/** The session's address space; see `ToolContext.resources`. */
	resources?: ToolContext["resources"];
	/** Where `scratch://` writes; see `ToolContext.scratchDir`. */
	scratchDir?: string;
	/** Messages the user typed while the agent was mid-turn. Drained between turns. */
	drainSteering?: () => Message[];
	/**
	 * Called before each request. Return a replacement history to compact it when the conversation
	 * approaches the context window, along with what to record so the compaction outlives this run.
	 */
	compact?: CompactHistory;
	/**
	 * Replaces the provider call. Tests script turns through this so loop behaviour can be
	 * checked without a network round trip.
	 */
	streamFn?: (context: LlmContext, config: AgentRunConfig) => Promise<AssistantMessage>;
	/** Observe the effective request after pruning, compaction and overflow recovery. */
	onContext?: (context: LlmContext, model: ModelConfig) => void;
	/**
	 * 每次请求都按历史渲染 `<env>` 日期块，跟在它所属的用户消息后面，不放进 `messages`。
	 *
	 * 给主会话用：它的历史每轮从日志重建，而日志里没有这条。渲染只看消息自己的时间戳，同一份历史
	 * 每次得到同样的字节，前缀接得上（见 `prompt/environment.ts`）。子代理不开：它把带日期块的
	 * `view` 原样存下来续跑，前缀本来就一致（见 `runtime/sub-agent.ts`）。
	 */
	environment?: boolean;
	/**
	 * 这条对话前缀的稳定标识，每次模型请求都带上，协议层据此发 `prompt_cache_key` / 会话亲和头。
	 *
	 * 同一个 key 下的请求应当共享前缀：主会话用会话 id，子代理用它自己的运行 id（续跑沿用，才接得上
	 * 上一段的缓存），侧聊单独一个。一次性请求（摘要、标题）不走循环，也不带。省略就不带。
	 */
	cacheKey?: string;
	/**
	 * Runs before a tool executes. Returning `block` turns the call into an error result the
	 * model can react to, without ending the turn.
	 */
	/**
	 * Watching the stream for rule violations, and what to inject when one fires.
	 *
	 * Optional because the loop must stay usable without it — tests, subagents and the CLI all
	 * construct a run directly. When absent nothing is buffered and nothing is matched.
	 */
	rules?: {
		/** Fed every delta; returns the rules that just became eligible. */
		observe(chunk: { source: "text" | "thinking" | "tool"; delta: string; key: string; toolName?: string; paths?: string[] }): RuleMatch[];
		/** Turn boundary, for buffers and repeat accounting. */
		startTurn(): void;
		/** Called once a correction has actually been delivered. */
		markFired(matches: RuleMatch[]): void;
		/** The hidden message injected before the retry. */
		render(matches: RuleMatch[]): Message;
		/** The hidden message delivered at the end of a turn, for rules that did not interrupt. */
		renderReminder(matches: RuleMatch[]): Message;
	};

	beforeToolCall?: (call: {
		toolName: string;
		args: Record<string, unknown>;
		toolCallId: string;
	}) => Promise<{
		block?: boolean;
		reason?: string;
		/** Replacement arguments the call runs with instead. */
		args?: Record<string, unknown>;
		/** `allow` answers the tool's own approval prompt in advance; `ask` asks even when the tool would not. */
		approval?: "allow" | "ask";
		approvalReason?: string;
		/** Hook context for the model, appended to this call's result. */
		contexts?: string[];
	} | void>;
	/** Runs after a tool executes; may replace the result the model sees. */
	afterToolCall?: (call: {
		toolName: string;
		args: Record<string, unknown>;
		result: ToolResult;
		toolCallId: string;
		contexts?: string[];
	}) => Promise<{ result?: ToolResult } | void>;
	/**
	 * Answers a tool's approval prompt before a person is asked. `undefined` leaves it to the person.
	 * Never consulted for `interactive` requests: those are questions, not permissions.
	 */
	permissionRequest?: (
		call: { toolName: string; args: Record<string, unknown>; toolCallId: string },
		request: ApprovalRequest,
	) => Promise<ApprovalDecision | undefined>;
	/**
	 * Asked when the model is about to finish. A message returned is injected and the loop goes on —
	 * the Stop hook saying the work is not done yet, and why.
	 */
	onStop?: (info: { responseText: string; toolCallCount: number }) => Promise<Message | undefined>;
}

/**
 * 会话此刻设定的模型，和它什么时候变。见 `AgentRunConfig.liveModel`。
 */
export interface LiveModel {
	/** 现在该用哪个。解析不出来（模型被删了）就是 null，循环接着用手上那个。 */
	current(): { provider: ProviderConfig; model: ModelConfig } | null;
	/**
	 * 它变了的时候通知一声，返回取消订阅。
	 *
	 * 光靠每轮开头读一次不够：一个正在重试的请求可能要等很久才轮到下一轮，而人换模型恰恰是因为
	 * 那个请求在等一个坏掉的上游。
	 */
	onChange(listener: () => void): () => void;
	/**
	 * 循环真的换过去了：从下一个请求起用 `model`，在这之前的历史都出自别的模型。
	 *
	 * 会话据此把「换模型的位置」挪到此刻——人按下切换和循环真正换过去之间，旧模型可能又说完了
	 * 一句，那一句的供应商句柄同样不能交给新模型。
	 */
	adopted?(model: ModelConfig): void;
}

export interface AgentRunResult {
	messages: Message[];
	/**
	 * 这一轮结束时，模型眼里的整段历史——压缩、裁剪之后的那一份，末尾接着这一轮产出的消息。
	 *
	 * `messages` 只有这一轮新产出的部分，而压缩发生在循环内部，调用方从外面看不见。要在同一段
	 * 上下文上接着跑（子代理续跑就是），拿这一份原样往后接：前缀跟上一次请求逐字相同，供应商的
	 * 前缀缓存才接得上。从转录重建会丢掉压缩边界，也会把日期块挪位置，缓存从第二条起全部作废。
	 *
	 * 可选：换进来的别的循环（`useAgentLoop`）不一定给，调用方要有退路。
	 */
	view?: Message[];
	reason: "done" | "aborted" | "error" | "max_turns" | "stalled";
	error?: string;
	/**
	 * The run died on the connection, not on anything it asked for.
	 *
	 * Only meaningful with `reason: "error"`. It is what tells a caller whether going back is worth
	 * anything: a dropped socket will likely be gone in ten seconds, a rejected key will not.
	 */
	retryable?: boolean;
}

/**
 * Whether a reply failed because the far end would not accept the request as posted.
 *
 * Narrow on purpose. A 401 is a key, a 404 is a URL, a 429 is a queue — none of them get better
 * because the history got smaller, and retrying them would spend a request to learn what the
 * status code already said. What is worth one more attempt is the range that means "this payload
 * is not something I can process": a plain 400, a body that is too large, an entity that failed
 * validation.
 */
function rejectedContent(assistant: AssistantMessage): boolean {
	if (assistant.stopReason !== "error" || assistant.errorRetryable) return false;
	/*
	 * 问分类的结果，而不是对着一行字做模式匹配。
	 *
	 * 从前这里读的是 `errorMessage` 的开头像不像 `HTTP 400`——而那行字是给人看的，措辞一变这条
	 * 判断就悄悄失效。`check-request` 是同一件事被写下来的样子：请求体本身不被接受，值得裁掉历史
	 * 再试一次。三条协议链出错时都带 `failure`（`ai/endpoint.ts` 的 `failedStreamEvent`）；没带的
	 * 不是从它们来的，不猜。
	 */
	return assistant.failure?.hint === "check-request";
}

const DEFAULT_MAX_TURNS = 200;
/** Empty-response retries per run; tool calls must not replenish this budget. */
const MAX_NUDGES = 3;
/**
 * 连续几次回复撞上输出上限还接着来。
 *
 * 输出上限已经取到模型允许的最大值（`contextMaxTokens`），没有更大的可调；能做的是让它从断处接着写，
 * 或把一次写不完的内容拆开。连续这么多次还在撞，说明拆不动或卡住了，停下来说清楚，而不是空耗轮数。
 */
const MAX_TRUNCATED_REPLIES = 3;
const TRUNCATED_CALL_REASON =
	"the response hit the output token limit before this call's arguments were complete. Re-issue it with less in one call: " +
	"write a large file in parts (create it with the first part, then add the rest with edit), and send fewer calls per reply";

/** Appended to a lone todo_write's result. The wording names the cost, not just the rule. */
export const SOLO_TODO_NOTE =
	"（这一轮只调了 todo_write，没有做任何实际工作。从下一轮起，把清单更新和真正的下一步——读文件、改代码、跑命令——放在同一次回复里；单独更新清单是浪费一次往返。）";

/** Written by the person, as opposed to the runtime speaking in the user role. */
function fromPerson(message: Message): boolean {
	return message.role === "user" && !message.synthetic;
}

/**
 * Whether the person said something after the model last spoke.
 *
 * Looks at the whole trailing run of user messages rather than the last one: synthetic messages
 * (a prompt update, a date block) can land after the prompt, and a run that resumes after tool
 * results or a nudge has no new instruction at all.
 */
function humanSinceLastReply(messages: readonly Message[]): boolean {
	for (let at = messages.length - 1; at >= 0 && messages[at].role === "user"; at--) {
		if (fromPerson(messages[at])) return true;
	}
	return false;
}

export async function runAgent(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult> {
	const messages = [...config.messages];
	/** Messages produced by this run, so the caller can append them to the persisted session. */
	const produced: Message[] = [];
	const state = config.state ?? new Map<string, unknown>();
	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	/** Empty-response retries spent in this run. */
	let nudges = 0;
	/** 连续撞上输出上限的回复数；一条没撞的就清零。 */
	let truncations = 0;
	/** Watches for a turn that has stopped learning anything; see `repetition.ts`. */
	const repetition = config.repetition ?? new RepetitionWatch();
	const pruner = config.pruner ?? new AgedToolPruner();
	const requestMessages = (history: Message[]): Message[] => (config.environment ? withEnvironment(history) : history);
	await emit({ type: "agent_start", sessionId: config.sessionId });

	let turn = 0;
	/**
	 * Steering messages drained at the end of a turn, waiting to be injected at the start of
	 * the next one. `drainSteering` empties the queue, so whatever it returns must be held
	 * here — reading only its length would discard the user's message and leave the loop
	 * prompting the model with no new input.
	 */
	let carried: Message[] = [];
	/**
	 * Reminders from rules that matched without interrupting.
	 *
	 * Delivered at the start of the next turn rather than folded into the tool result that tripped
	 * them. That is later than it could be, and it is the honest place for it: `interrupt: never`
	 * means "this is not urgent enough to stop for", and a message that arrives with the next turn
	 * says exactly that. It also leaves tool results the shape every renderer expects.
	 */
	let reminders: Message[] = [];

	/*
	 * 这一轮此刻用的模型。起点是调用方给的那个，人中途换了就跟着换——见 `liveModel`。
	 *
	 * 只在循环顶上换：一个请求发出去之后它就是它，换人发生在两个请求之间。唯一的例外是一个还
	 * 什么都没说出口的请求（在连、在重试），那个会被放手，见 `streamTurn`。
	 */
	let active: AgentRunConfig = config;

	while (true) {
		if (config.signal?.aborted) return finish("aborted");
		if (turn >= maxTurns) return finish("max_turns");
		turn += 1;
		await emit({ type: "turn_start", turn });

		const drained = config.drainSteering?.() ?? [];
		const steering = [...reminders, ...carried, ...drained];
		/*
		 * Something the person just said ends the previous skill's tool restriction.
		 *
		 * Their message is a new instruction, and a restriction left standing across it would
		 * silently refuse work they had just asked for — with an explanation naming a skill they
		 * may not remember loading. On the first turn that includes the prompt that started this
		 * run: the state map outlives the run, so a skill loaded for the previous request is still
		 * in it. Checking only `drained` once missed both that and `carried`.
		 */
		if ((turn === 1 && humanSinceLastReply(config.messages)) || steering.some(fromPerson)) clearActiveSkill(state);

		reminders = [];
		carried = [];
		for (const steered of steering) {
			messages.push(steered);
			produced.push(steered);
			await emit({ type: "message_start", message: steered });
			await emit({ type: "message_end", message: steered });
		}

		/*
		 * 人换了模型：从这个请求起换过去。
		 *
		 * 手上这份历史全出自旧模型，它的供应商句柄交给新模型只会被整条拒掉（见 `model-switch.ts`），
		 * 所以先摘掉。按「切换那一刻之前的都剥」来，不按每条消息的 `model` 字段比：有的供应商回报的
		 * 模型名跟配置里的对不上（带日期、带别名），逐条比会把同一个模型自己的思考签名也剥掉。
		 */
		const wanted = config.liveModel?.current();
		if (wanted && wanted.model.id !== active.model.id) {
			const cleaned = stripStaleHandles(messages, messages.length);
			if (cleaned !== messages) {
				messages.length = 0;
				messages.push(...cleaned);
			}
			active = { ...config, provider: wanted.provider, model: wanted.model };
			config.liveModel?.adopted?.(wanted.model);
		}

		/*
		 * 新结果第一次发出前定下它发给模型的样子；已经发出去的原样重发。见 `AgedToolPruner`。
		 */
		const tidied = pruner.prepare(messages, config.artifacts);
		if (tidied !== messages) {
			messages.length = 0;
			messages.push(...tidied);
		}

		if (config.compact) {
			const compaction = await compactStep(config, messages, active.model, emit, { provider: active.provider });
			if (config.signal?.aborted) return finish("aborted");
			if (compaction) {
				messages.length = 0;
				messages.push(...compaction.messages);
				// 早先的原文进了摘要，再读一次是在拿回来，不是在打转。见 `RepetitionWatch.reset`。
				repetition.reset();
			}
		}

		// Compaction can wait on a model; cancellation during that await must prevent a new request.
		if (config.signal?.aborted) return finish("aborted");
		const context: LlmContext = {
			systemPrompt: config.systemPrompt,
			messages: requestMessages(messages),
			tools: config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		};

		let { message: assistant, ruleMatches, deferredMatches, switched, held } = await streamTurn(active, context, emit);
		/*
		 * 还没说出一个字就被换下的请求：什么都不留，回到顶上用新模型从同一处重来。
		 *
		 * 不算一轮——它什么都没做，算进去等于让人为换模型付一轮的检查点额度。
		 */
		if (switched) {
			turn -= 1;
			continue;
		}
		/** 拒收恢复里的重发：被拒的那条放掉，换一份历史再问。 */
		const resend = async () => {
			await held?.discard();
			({ message: assistant, ruleMatches, deferredMatches, switched, held } = await streamTurn(active, { ...context, messages: requestMessages(messages) }, emit));
		};

		/*
		 * The far end refused the request itself. Try once more without the biggest thing in it.
		 *
		 * A 4xx is not a transport failure, so nothing retries it — correctly, because asking the
		 * same question again gets the same answer. The trouble is that the question is the
		 * *history*, and history does not change on its own: every later request carries the same
		 * rejected payload, so the conversation is not merely failing, it is sealed. Retry fails.
		 * Continue fails. Opening it tomorrow fails.
		 *
		 * One tool result is very often the whole of it — a `gh api` dump, a 2,000-line file, a
		 * grep across a build directory — and gateways translating between formats have limits and
		 * bugs that no client can enumerate. So rather than guessing which, this drops the oversized
		 * results to a line each and asks once more. It costs one request in the case that was
		 * already lost, and nothing at all in every case that was not.
		 */
		if (rejectedContent(assistant)) {
			const stripped = stripOversizedToolResults(messages);
			if (stripped !== messages) {
				await emit({
					type: "notice",
					level: "warn",
					message: "模型服务拒收了这次请求。已把其中过大的工具输出压成一行，正在重试。",
				});
				messages.length = 0;
				messages.push(...stripped);
				await resend();
			}
		}
		/*
		 * 上下文超出了模型窗口：强制压缩一次，再发一次。
		 *
		 * 80% 的自动压缩线挡住的是大多数，挡不住的是估算偏低（中文、密集 JSON）和一次涨太多（一个巨大
		 * 的工具结果）。剪掉过大的工具输出是便宜的第一步，已经在上面试过；还是超长、或者没东西可剪，
		 * 就只剩压缩——不压，这段历史下一轮原样再发，会话就卡死在这里。
		 *
		 * 每轮最多一次，由结构保证：这一段不在循环里，重发的结果不会再回到这里。压缩失败、没压小、压完
		 * 还是超长，都照原错误收场——如实报错，不再往下试。压缩走的是顶上那条通道（`compactStep`），剪枝
		 * 视图的持久化、边界事件、界面的进度都是同一套；重复计数清零的理由也相同。
		 */
		if (!switched && assistant.stopReason === "error" && isContextOverflow(assistant.failure) && config.compact) {
			await emit({ type: "notice", level: "warn", message: "上下文超出了模型的上限，正在压缩历史后重试。" });
			const compaction = await compactStep(config, messages, active.model, emit, { force: true, provider: active.provider }).catch(async (cause: unknown) => {
				// 压缩自己抛了：被拒的那条照实提交再往上抛，转录里要留得下这一轮为什么停。
				await held?.commit();
				throw cause;
			});
			if (config.signal?.aborted) {
				await held?.discard();
				return finish("aborted");
			}
			if (compaction) {
				messages.length = 0;
				messages.push(...compaction.messages);
				repetition.reset();
				await resend();
			}
		}
		if (switched) {
			turn -= 1;
			continue;
		}
		await held?.commit();
		/*
		 * A rule interrupted this turn: drop what was said and say it again, better informed.
		 *
		 * The partial output is discarded rather than kept. Leaving half a violation in the
		 * history invites the model to continue it, and the whole point of interrupting mid-
		 * sentence was to stop that sentence from existing. `streamTurn` already withheld its
		 * `message_end` (the commit point) — which is why "was it interrupted, or did the user
		 * win" is decided there, once, and not re-checked here: a stop landing in between would
		 * otherwise send an uncommitted reply down the aborted path below.
		 */
		if (ruleMatches.length > 0 && config.rules) {
			const injection = config.rules.render(ruleMatches);
			config.rules.markFired(ruleMatches);
			messages.push(injection);
			produced.push(injection);
			await emit({ type: "message_start", message: injection });
			await emit({ type: "message_end", message: injection });
			await emit({
				type: "rule_triggered",
				rules: ruleMatches.map((m) => ({
					name: m.rule.name,
					path: m.rule.path,
					excerpt: m.excerpt,
					source: m.source,
					toolName: m.toolName,
				})),
			});
			continue;
		}

		if (deferredMatches.length > 0 && config.rules && assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
			config.rules.markFired(deferredMatches);
			reminders.push(config.rules.renderReminder(deferredMatches));
			await emit({
				type: "rule_triggered",
				rules: deferredMatches.map((m) => ({
					name: m.rule.name,
					path: m.rule.path,
					excerpt: m.excerpt,
					source: m.source,
					toolName: m.toolName,
					deferred: true,
				})),
			});
		}

		messages.push(assistant);
		produced.push(assistant);

		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
			/*
			 * A call the model never finished saying still has to be answered.
			 *
			 * A reply cut off mid-stream keeps whatever it had emitted, and that can include an
			 * opened tool call. Anthropic rejects any request carrying a `tool_use` with no result
			 * after it — so the orphan does not end one turn, it ends the conversation: every later
			 * request fails on the same 400, including the one sent to pick the work back up. The
			 * call is failed rather than run, because arguments that stopped arriving halfway are
			 * not arguments.
			 */
			const unanswered = assistant.content.filter((c) => c.type === "toolCall");
			if (unanswered.length > 0) {
				const why =
					assistant.stopReason === "aborted"
						? "the turn was stopped before it could run"
						: "the connection dropped while the call was still arriving, so its arguments are incomplete";
				for (const result of await failTruncatedCalls(unanswered, emit, why)) {
					messages.push(result);
					produced.push(result);
				}
			}
			if (assistant.stopReason === "aborted") return finish("aborted");
			return finish("error", assistant.errorMessage, assistant.errorRetryable);
		}

		const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
		if (toolCalls.length === 0) {
			await emit({ type: "turn_end", message: assistant, toolResults: [] });
			/*
			 * A steering message that arrived during the final stream still deserves an answer.
			 *
			 * 到了步数上限就不在这里取：取走之后 `continue`，循环顶上先判上限、直接收场，这句话就
			 * 既不在转录里、也不在队列里了。留在队列里，由宿主按「没人接走的插话」接着发——会话的
			 * `drainPending`、子代理的 `runSubAgent` 都认这条路。
			 */
			carried = turn < maxTurns ? config.drainSteering?.() ?? [] : [];
			if (carried.length > 0) continue;

			/*
			 * 写到一半撞上了输出上限：不当作答完了。
			 *
			 * 从前这里直接 `finish("done")`，界面上是一段戛然而止的回答，看不出是被截断的。让它从断处接着
			 * 写；连续撞满 `MAX_TRUNCATED_REPLIES` 次就停，并说出来。
			 */
			if (assistant.stopReason === "length") {
				truncations += 1;
				if (truncations <= MAX_TRUNCATED_REPLIES && turn < maxTurns) {
					const resume: Message = {
						role: "user",
						content: [{ type: "text", text: "（自动继续）上一条回复达到了输出长度上限，在中途被截断。请从断开的地方直接接着写，不要重复已经写出的内容。" }],
						timestamp: Date.now(),
						// 运行时在说话，不是人：同上面的空回复催促。
						synthetic: true,
					};
					messages.push(resume);
					produced.push(resume);
					await emit({ type: "message_start", message: resume });
					await emit({ type: "message_end", message: resume });
					continue;
				}
				await emit({ type: "notice", level: "warn", message: "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。" });
			} else truncations = 0;

			// A checklist cannot distinguish a question from abandoned work. Text yields to the
			// person; only an actually empty response earns a bounded retry.
			const saidNothing = assistant.content.every((part) => part.type !== "text" || !part.text.trim());
			if (saidNothing && nudges < MAX_NUDGES) {
				nudges += 1;
				const nudgeText = "（自动继续）上一条回复没有正文。请给出回答；如果需要用户补充信息，请直接提问并等待回复。";

				const nudge: Message = {
					role: "user",
					content: [
						{
							type: "text",
							text: nudgeText,
						},
					],
					timestamp: Date.now(),
					/*
					 * The runtime is speaking, not the person.
					 *
					 * It has to be a user message because that is the only role the model will take
					 * an instruction in — but the window must not draw it as one. Rendered in the
					 * human's own bubble it reads as something they typed, and the transcript then
					 * shows them asking for things they never asked for.
					 */
					synthetic: true,
				};
				messages.push(nudge);
				produced.push(nudge);
				await emit({ type: "message_start", message: nudge });
				await emit({ type: "message_end", message: nudge });
				continue;
			}
			if (saidNothing) return finish("error", "模型连续返回空回复，请重试或更换模型。");
			if (config.onStop && !config.signal?.aborted) {
				const responseText = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
				const toolCallCount = produced.filter((message) => message.role === "toolResult").length;
				const resume = await config.onStop({ responseText, toolCallCount }).catch(() => undefined);
				if (resume && !config.signal?.aborted) {
					messages.push(resume);
					produced.push(resume);
					await emit({ type: "message_start", message: resume });
					await emit({ type: "message_end", message: resume });
					continue;
				}
			}
			return finish("done");
		}

		syncSkillContext(state, messages);
		const truncated = assistant.stopReason === "length";
		truncations = truncated ? truncations + 1 : 0;
		/*
		 * A reply that only updated the list did nothing else, and will spend another round trip
		 * doing it. Said in the result of that very call — where the model reads next, about the
		 * thing it just did — rather than in a prompt it has already skimmed past. Measured before
		 * this: nearly half the tool turns on a three-step task were a lone todo_write (06 §6.3).
		 */
		const soloTodo = toolCalls.length === 1 && toolCalls[0].name === "todo_write" && config.tools.length > 1;
		const toolResults = truncated
			? await failTruncatedCalls(toolCalls, emit, TRUNCATED_CALL_REASON)
			: await runTools(toolCalls, config, state, emit, soloTodo ? SOLO_TODO_NOTE : undefined);

		for (const result of toolResults) {
			messages.push(result);
			produced.push(result);
		}

		await emit({ type: "turn_end", message: assistant, toolResults });

		/*
		 * 一个工具说了「到此为止」，那就到此为止。
		 *
		 * `ToolResult.terminate` 这个字段一直都在，只是从来没有人写、也从来没有人读——于是唯一需要
		 * 它的那个工具只能靠模型自觉收尾。`yield` 的语义是「交付即结束」：结果已经在 `state` 里，
		 * 派它来的人拿的就是那个对象，此后再问模型一句话，答案不会被任何人读到。
		 *
		 * 那一句废话的代价不是零。顺利的时候，它是一整份上下文换回来的一句「我做完了」；不顺的
		 * 时候——模型交完货真的无话可说、服务商把它转成一个没有内容的流——它就是一次空回答，而空
		 * 回答是会被重试的。开着无限重试时，这一轮不会失败，它会永远转下去：子代理的报告早就躺在
		 * `state` 里，派它来的人却一直等不到。真实日志里量到过同一个请求重发 222 次、34 分钟。
		 *
		 * 收在 `turn_end` 之后：这一轮确实完整地发生过，工具跑了、结果进了历史，只是不再问下一句。
		 */
		const terminated = toolResults.find((result) => result.terminate === true);
		if (terminated) return finish("done");

		// 工具参数一再写到一半就被截断：拆不动了，接着跑只会一轮轮白费。
		if (truncated && truncations > MAX_TRUNCATED_REPLIES) {
			return finish("error", "回复连续多次在工具参数写到一半时达到输出长度上限，已停下。可以让它把内容拆小，或换一个输出上限更大的模型。");
		}

		/*
		 * Same call, same arguments, same answer — again.
		 *
		 * Told once, most models change approach. Told and ignored, the turn ends: an agent
		 * repeating a call that has already answered the same way nine times is not going to
		 * discover anything on the tenth, and the hours it would spend doing so belong to
		 * whoever is waiting for it.
		 */
		const { warn: repeated, kind, repeats } = repetition.observe(toolCalls, toolResults);

		/*
		 * 问到第三次的，不再把那份一模一样的结果重贴一遍。
		 *
		 * 这里原本是「问满六次就结束这一轮」。停下来解决不了任何问题：它既没告诉模型该怎么办，也没把
		 * 等结果的人放出来，只是把一次卡住变成一次中断。
		 *
		 * 换成纠正之后，模型收到的是一句具体的话——第几次、结果没变、它不会因为再问一次而改变——而
		 * 不是一段它三分钟前刚读过的原文。省下的是实打实的钱：真实日志里同一段 `read` 贴过 5 遍，同一个
		 * `skill` 注入过 4 次，每次 5,625 token。
		 *
		 * 只动给模型看的那一份，工具照常执行过：万一这次结果真的变了，指纹就不同，根本走不到这里。
		 *
		 * 换在提交之后，日志和界面留的是原文。代价是重启后重建的历史在这条上和当时发出去的不同，
		 * 前缀从这里断一次；换到提交之前要么等整批跑完才落盘（崩溃时丢掉已完成的结果），要么让
		 * 计数看到的不是原文，都不划算。
		 */
		if (repetition.exhausted()) return finish("stalled");

		for (const [index, seen] of repeats.entries()) {
			if (seen < REPEAT_WARN) continue;
			const result = toolResults[index];
			if (!result || result.role !== "toolResult") continue;
			/*
			 * 「前几次」得真的还在眼前。计数只在改动工作区、压缩时清零，而剪枝会把早先那几份换成
			 * 回查指针——那时再把这份也换掉，模型手里一份原文都没有了。这份就留着，它就是原文。
			 */
			if (!originalInView(messages, toolCalls[index], result)) continue;
			result.content = [{ type: "text", text: repeatNotice(seen, toolCalls[index].name) }];
		}
		if (repeated) {
			/*
			 * 两条线两句话，因为说错了等于没说。
			 *
			 * 对一个每轮都在改 `offset` 的调用说「你用了同样的参数」，模型对照一眼就知道这话不成立，
			 * 于是连带着后半句一起不信——而后半句才是要紧的那句。真实记录里，一次翻了 37 页的搜索
			 * 全程没有收到任何提示；等到终于收到时，那句话描述的也不是它正在做的事。
			 */
			const text =
				kind === "probe"
					? `（自动提示）你已经连续多次切图、读切片或做像素测距。` +
						`这类探测回答不了「为什么间距是这样」——去读对应的 CSS 和组件结构，基于已有证据下结论。` +
						`不要再写新的测距脚本，也不要再切图。`
					: kind === "intent"
					? `（自动提示）你已经用不同的翻页参数把 \`${repeated}\` 的同一个问题问了很多遍。` +
						`翻页不会把答案翻出来——要么它本来就不在这里，要么该换个问法。` +
						`换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`
					: `（自动提示）你已经用同样的参数调用 \`${repeated}\` 多次，每次得到的结果都一样。` +
						`再问一次不会有新信息。换一个思路：换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`;
			const notice: Message = {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
				synthetic: true,
			};
			messages.push(notice);
			produced.push(notice);
			await emit({ type: "message_start", message: notice });
			await emit({ type: "message_end", message: notice });
		}
	}

	async function finish(
		reason: AgentRunResult["reason"],
		error?: string,
		retryable?: boolean,
	): Promise<AgentRunResult> {
		/*
		 * A reminder that never got a turn to ride on still has to land somewhere.
		 *
		 * Non-interrupting matches are delivered at the start of the next turn — and when the match
		 * happens on the last turn there is no next one, so it was silently dropped. Measured: a
		 * rule with `interrupt: never` fired, was marked deferred, and the model never saw it.
		 *
		 * Persisting it into the produced messages is the right home rather than a consolation
		 * prize: the reminder is about what to do *going forward*, and the conversation continues
		 * the next time the user types. It is not pushed into `messages`, which belongs to a run
		 * that is over.
		 */
		for (const reminder of reminders) {
			produced.push(reminder);
			await emit({ type: "message_start", message: reminder });
			await emit({ type: "message_end", message: reminder });
		}
		// 提醒不进 `messages`（那是这一轮自己的），但接着跑的那一段要看得见它——见 `view`。
		const view = [...messages, ...reminders];
		reminders = [];

		await emit({ type: "agent_end", reason, error });
		return { messages: produced, view, reason, error, ...(retryable ? { retryable } : {}) };
	}
}

// ---------------------------------------------------------------------------
// Streaming one assistant turn
// ---------------------------------------------------------------------------

/**
 * One assistant turn, plus whatever rules it tripped on the way.
 *
 * `ruleMatches` is non-empty only when a rule asked to interrupt: the stream was aborted
 * deliberately, and the caller is expected to discard the partial output, inject the rule, and
 * generate again from the same point.
 */
interface TurnResult {
	message: AssistantMessage;
	/**
	 * Rules that asked to interrupt: the stream was aborted and the turn should be redone.
	 *
	 * 只在真的打断了的时候非空（人同时按了停止的不算，人赢），判定在 `streamTurn` 里做一次：那边
	 * 据此决定这条回复发不发 `message_end`，循环据此决定重来还是收场，两边不能各判各的。
	 */
	ruleMatches: RuleMatch[];
	/** Rules that matched but did not interrupt: delivered once this turn has finished. */
	deferredMatches: RuleMatch[];
	/** 人换了模型，而这个请求还什么都没说出口：它被放手了，调用方该用新模型从同一处重来。 */
	switched?: boolean;
	/**
	 * 请求本身被拒收（`rejectedContent`）的那条错误回复，还没提交（没发 `message_end`）。
	 *
	 * 调用方要么恢复后重发、`discard` 掉它，要么放弃恢复、`commit` 它。先提交再重发的话，日志里就多出
	 * 一条循环眼里没有的失败回复：压缩边界按「最后 N 条」从日志末尾数，数偏一条，下一轮重建出的
	 * 历史就和刚发出去的不一样，还可能从一对工具调用中间切开。
	 */
	held?: { commit(): Promise<void>; discard(): Promise<void> };
}

async function streamTurn(config: AgentRunConfig, context: LlmContext, emit: AgentEventSink): Promise<TurnResult> {
	config.onContext?.(context, config.model);
	// Recalculate after compaction, model switches and payload recovery, for injected streams too.
	config = { ...config, maxTokens: contextMaxTokens(config.model, context, config.maxTokens) };
	await emit({ type: "request", provider: config.provider.id, model: config.model.modelId, thinking: config.thinking, messageCount: context.messages.length });

	/*
	 * 换模型的那一下，单独一个控制器，理由和下面规则打断那个一样：它的意思不是「停」，是「换个人
	 * 重来」，所以不能跟 `config.signal`（人按了停止）混为一谈。
	 *
	 * 只放手还什么都没说出口的请求——在连、在重试。那正是人会去换模型的时候：旧的上游坏了，这个请求
	 * 在一遍遍地等它。已经在出字的不动：它在干活，说完了下一个请求自然用新的。
	 */
	const switchAbort = new AbortController();
	let said = false;
	const unsubscribe = config.liveModel?.onChange(() => {
		const wanted = config.liveModel?.current();
		if (!said && wanted && wanted.model.id !== config.model.id) switchAbort.abort();
	});
	const switched = () => switchAbort.signal.aborted && !config.signal?.aborted;

	if (config.streamFn) {
		try {
			// 替身拿到的也是带着「换人」的那根信号，行为跟真实请求一样，才测得到。
			const message = await config.streamFn(context, { ...config, signal: AbortSignal.any([...(config.signal ? [config.signal] : []), switchAbort.signal]) });
			if (switched()) return { message, ruleMatches: [], deferredMatches: [], switched: true };
			if (rejectedContent(message)) {
				const commit = async () => {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
				};
				return { message, ruleMatches: [], deferredMatches: [], held: { commit, discard: async () => {} } };
			}
			await emit({ type: "message_start", message });
			await emit({ type: "message_end", message });
			return { message, ruleMatches: [], deferredMatches: [] };
		} finally {
			unsubscribe?.();
		}
	}

	/*
	 * How many times *this request* has been retried, which is not what either retry counts.
	 *
	 * Two of them are nested: `fetchWithRetry` for getting the connection, `retryStream` for
	 * keeping it once it is open. Each has its own budget and each numbers its attempts from 1,
	 * so passing those numbers straight through made the line on screen count 1, 2, 1, 1, 2 as
	 * control moved between the layers — and call the fifth attempt of the request "第 1 次".
	 * The user is waiting on the request, so the request is what gets counted.
	 */
	let retries = 0;

	/*
	 * A separate controller for rule interrupts.
	 *
	 * It must not be `config.signal`: that one means "the user stopped this", and the loop ends
	 * the run when it fires. A rule interrupt means the opposite — keep going, but say something
	 * first — so the two are combined for the request and told apart afterwards.
	 */
	const ruleAbort = new AbortController();
	const pendingMatches: RuleMatch[] = [];
	const deferredMatches: RuleMatch[] = [];

	const signal = AbortSignal.any([...(config.signal ? [config.signal] : []), ruleAbort.signal, switchAbort.signal]);

	/*
	 * 前缀从哪里开始和上一次不同，写在这次的回复上——缓存未命中的归因证据，见 `ai/prefix-fingerprint.ts`。
	 * 重试的每一次覆盖 `sent`，比的是最后真发出去的那份；基准按会话存，跨轮接得上。基准只从诊断也算数的
	 * 请求推进（`requestPrompt`）：诊断跳过零用量的失败请求去比前后两次成功的，这里也得比那两次。
	 */
	let sent: PrefixSegment[] | undefined;
	let prefix: AssistantMessage["prefix"] | null = null;
	const stamp = (message: AssistantMessage): AssistantMessage => {
		if (prefix === null && sent && config.state) {
			const previous = config.state.get(PREFIX_KEY) as PrefixSegment[] | undefined;
			prefix = previous ? comparePrefix(previous, sent) : undefined;
			if (requestPrompt(message) > 0) config.state.set(PREFIX_KEY, sent);
		}
		if (prefix) message.prefix = prefix;
		return message;
	};
	const stream = stamped(streamAssistant(config.provider, config.model, context, {
		onPayload: config.state ? (body) => { sent = payloadSegments(body); } : undefined,
		signal,
		thinking: config.thinking,
		maxTokens: config.maxTokens,
		temperature: config.temperature,
		retryAttempts: config.retryAttempts,
		retryPolicy: config.retryPolicy,
		cacheKey: config.cacheKey,
		/*
		 * Said out loud, because the alternative is a turn that appears to hang.
		 *
		 * A retry costs seconds of silence at a moment when the user is already waiting, and
		 * silence is indistinguishable from a stall. One line naming the cause turns it into
		 * something that is visibly being handled.
		 */
		onRetry: ({ delayMs, reason, failure }) => {
			retries += 1;
			void emit({ type: "retry", attempt: retries, delayMs, reason, failure });
		},
	}), stamp);

	let started = false;

	/**
	 * 那次中断怎么收的场，说一句。
	 *
	 * 这里是唯一同时知道两件事的地方：重试了几次（数在上面），以及最后那条消息是什么样子。少了这
	 * 一句，界面上的「正在重连」就没有下文——它只能等着被下一轮清掉，于是「重连成功」和「窗口
	 * 闲着」在屏幕上长得一模一样。
	 */
	const settle = async (message: AssistantMessage) => {
		const failed = message.stopReason === "error";
		/*
		 * 一次都没重试过的成功没什么可说的，别的都要说。
		 *
		 * 尤其是一次都没重试过的**失败**——密钥不对、模型名写错，分类器判成 `fatal` 当场停下，一条
		 * retry 事件都不会有。要是这里也不说，界面上就只剩一片安静：转录里那句话没了，而它本来是
		 * 唯一说明发生过什么的东西。
		 */
		if (retries === 0 && !failed) return;
		await emit({
			type: "retry_settled",
			outcome: failed ? "gave_up" : "recovered",
			attempts: retries,
			failure: message.failure,
		});
	};

	/**
	 * 换了模型，这个请求放手。
	 *
	 * 没开始出流的，什么都不发、不进转录——它什么都没说，留一条空的「已停止」只会让人以为自己按了
	 * 停。开始了但一个字没有的（极少见），照常收尾，免得界面上留着一个永远在转的气泡。重试过的，
	 * 那行「正在重连」要收场，而且要说实话：不是重连上了，是换了人。
	 */
	const letGo = async (message: AssistantMessage): Promise<TurnResult> => {
		if (started) await emit({ type: "message_end", message });
		if (retries > 0) {
			const to = config.liveModel?.current()?.model.name;
			await emit({ type: "retry_settled", outcome: "switched", attempts: retries, ...(to ? { switchedTo: to } : {}) });
		}
		return { message, ruleMatches: [], deferredMatches: [], switched: true };
	};

	/*
	 * 规则打断的：开了头的那一截不收尾、不提交，只告诉界面把它收掉。
	 *
	 * `config.signal` 要看，因为两根信号掐的是同一个流：人在规则触发的同一刻按了停止，人赢。
	 */
	const interruptedByRule = (message: AssistantMessage) =>
		pendingMatches.length > 0 && message.stopReason === "aborted" && !config.signal?.aborted;
	const discard = async (message: AssistantMessage): Promise<TurnResult> => {
		if (started) await emit({ type: "message_discarded", message });
		await settle(message);
		return { message, ruleMatches: pendingMatches, deferredMatches };
	};

	try {
	while (true) {
		const next = await stream.next();
		if (next.done) {
			if (switched()) return await letGo(next.value);
			if (interruptedByRule(next.value)) return await discard(next.value);
			await settle(next.value);
			return { message: next.value, ruleMatches: [], deferredMatches };
		}
		const event = next.value;

		switch (event.type) {
			case "start":
				started = true;
				await emit({ type: "message_start", message: event.partial });
				break;
			case "text_delta":
			case "thinking_delta":
			case "toolcall_delta":
			case "toolcall_end":
				said = true;
				await emit({ type: "message_update", message: event.partial, delta: event });
				if (config.rules && event.type !== "toolcall_end") observeDelta(config.rules, event, pendingMatches, deferredMatches, ruleAbort);
				break;
			case "done":
			case "error": {
				const message = event.message;
				if (switched()) {
					const tail = await stream.next();
					return await letGo(tail.done ? tail.value : message);
				}
				if (interruptedByRule(message)) {
					const tail = await stream.next();
					return await discard(tail.done ? tail.value : message);
				}
				if (rejectedContent(message)) {
					const tail = await stream.next();
					const settled = tail.done ? tail.value : message;
					return {
						message: settled,
						ruleMatches: [],
						deferredMatches,
						held: {
							commit: async () => {
								if (!started) await emit({ type: "message_start", message: settled });
								await emit({ type: "message_end", message: settled });
								await settle(settled);
							},
							/*
							 * 放掉它：画出来的那一截收掉。重连过的那行「正在重连」也要收场，而这个请求确实
							 * 没救回来；一次都没重试过的就不再报一条失败——紧接着的重发才是结果。
							 */
							discard: async () => {
								if (started) await emit({ type: "message_discarded", message: settled });
								if (retries > 0) await settle(settled);
							},
						},
					};
				}
				if (!started) await emit({ type: "message_start", message });
				await emit({ type: "message_end", message });
				// Drain the generator so its `return` value is the authoritative final message.
				const tail = await stream.next();
				const settled = tail.done ? tail.value : message;
				await settle(settled);
				return { message: settled, ruleMatches: [], deferredMatches };
			}
			default:
				break;
		}
	}
	} finally {
		unsubscribe?.();
	}
}

/** 会话状态里上一次请求的切段，见 `streamTurn` 里的 `stamp`。 */
const PREFIX_KEY = "requestPrefix";

/** 收尾的消息（`done`/`error` 事件里的和最后返回的）在交出去之前过一遍 `stamp`。 */
async function* stamped(
	stream: ReturnType<typeof streamAssistant>,
	stamp: (message: AssistantMessage) => AssistantMessage,
): ReturnType<typeof streamAssistant> {
	while (true) {
		const next = await stream.next();
		if (next.done) return stamp(next.value);
		if (next.value.type === "done" || next.value.type === "error") stamp(next.value.message);
		yield next.value;
	}
}

/**
 * Route one stream delta to the rule monitor, and abort if a rule wants to interrupt.
 *
 * The tool case needs the buffer keyed per call: two tools streaming their arguments at once
 * would otherwise share one buffer, and a pattern could match across the seam between them —
 * a rule firing on text that no single call ever contained.
 */
function observeDelta(
	rules: NonNullable<AgentRunConfig["rules"]>,
	event: { type: string; delta: string; index: number; partial: AssistantMessage },
	pending: RuleMatch[],
	deferred: RuleMatch[],
	abort: AbortController,
): void {
	let chunk: Parameters<typeof rules.observe>[0];

	if (event.type === "text_delta") {
		chunk = { source: "text", delta: event.delta, key: "text" };
	} else if (event.type === "thinking_delta") {
		chunk = { source: "thinking", delta: event.delta, key: "thinking" };
	} else {
		const call = event.partial.content[event.index];
		if (call?.type !== "toolCall") return;
		const partialArgs = typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {});
		chunk = { source: "tool", delta: event.delta, key: `tool:${call.id}`, toolName: call.name, paths: extractPaths(partialArgs) };
	}

	const matches = rules.observe(chunk);
	if (matches.length === 0) return;

	/*
	 * `interrupt` decides whether this is worth stopping mid-sentence.
	 *
	 * A rule set to `never`, or scoped away from this source, still matched — it is delivered at
	 * the end of the turn instead. Dropping it would make `interrupt: never` a setting that
	 * silently disables the rule, which is the worst thing a setting can do.
	 */
	for (const match of matches) {
		const interrupts =
			match.rule.interrupt === "never"
				? false
				: match.rule.interrupt === "prose-only"
					? chunk.source !== "tool"
					: match.rule.interrupt === "tool-only"
						? chunk.source === "tool"
						: true;
		const bucket = interrupts ? pending : deferred;
		if (!bucket.some((existing) => existing.rule.name === match.rule.name)) bucket.push(match);
	}

	if (pending.length > 0 && !abort.signal.aborted) abort.abort();
}
