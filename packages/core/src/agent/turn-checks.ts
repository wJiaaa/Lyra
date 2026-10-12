/**
 * 一条回复处理完以后，还要不要再来一轮。
 *
 * 出错、中断、步数上限和插话由循环自己处理；回复正常落定之后，让循环续跑、追问或停下的规则都登记在
 * 这两张表里，表里的顺序就是规则之间的优先级（比如 Stop 钩子排在清单收尾前面，钩子看到的才是真正的
 * 回答）。循环只按表问下去；加一条规则是写一个函数、在 `turnChecks` 里登记一行。每条线的值和来历见
 * docs/architecture/agent-loop.md 的「停止与续跑总表」。
 */

import { originalInView, REPEAT_WARN, repeatHint, repeatNotice, type RepetitionWatch } from "./repetition.ts";
import type { PlanWatch } from "./plan-watch.ts";
import type { AgentControlContext, AgentRunResult } from "./run-config.ts";
import type { AgentEventSink } from "./events.ts";
import type { AssistantContent, AssistantMessage, Message, ToolResultMessage } from "../types.ts";

/** Empty-response retries per run; tool calls must not replenish this budget. */
const MAX_NUDGES = 3;
/** Consecutive replies cut off by the output limit before the run stops and says so. */
const MAX_TRUNCATED_REPLIES = 3;
const CONTINUE_AFTER_LENGTH = "（自动继续）上一条回复达到了输出长度上限，在中途被截断。请从断开的地方直接接着写，不要重复已经写出的内容。";
const EMPTY_REPLY_NUDGE = "（自动继续）上一条回复没有正文。请给出回答；如果需要用户补充信息，请直接提问并等待回复。";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
export type Ending = { reason: AgentRunResult["reason"]; error?: string };

/** `say`：以用户角色说这句话，再来一轮；`end`：收场；`undefined`：这条规则没有意见。 */
type Verdict = { say: Message } | { end: Ending } | undefined;

/** 一条只有正文的回复，插话已经确认没有。 */
export interface ProseTurn {
	assistant: AssistantMessage;
	/** 还没到步数上限。到了就不该再要一轮。 */
	turnsLeft: boolean;
	/** 这次运行产生的全部消息，含这条回复。 */
	produced: readonly Message[];
}

/** 一条带工具调用的回复，工具已经跑完、结果已经进了历史。 */
interface ToolTurn {
	assistant: AssistantMessage;
	toolCalls: ToolCall[];
	toolResults: ToolResultMessage[];
	/** 模型眼里的整段历史：换掉重复结果前要确认原文还在眼前。 */
	messages: readonly Message[];
}

type Check<T> = (turn: T) => Verdict | Promise<Verdict>;

/** 两张表怎么问见 `askAfterProse` 与 `askAfterTools`。 */
export interface TurnChecks {
	afterProse: Check<ProseTurn>[];
	afterTools: Check<ToolTurn>[];
}

type Inject = (message: Message) => Promise<void>;

/**
 * 回复只有正文，本该收场：第一条有意见的规则说了算，后面的不再问——它们的计数只算真正问到的那次。
 * 返回 `undefined` 是再来一轮。
 */
export async function askAfterProse(checks: TurnChecks, turn: ProseTurn, inject: Inject): Promise<Ending | undefined> {
	for (const check of checks.afterProse) {
		const verdict = await check(turn);
		if (!verdict) continue;
		if ("end" in verdict) return verdict.end;
		await inject(verdict.say);
		return undefined;
	}
	return { reason: "done" };
}

/**
 * 跑完了工具，本该接着做：`end` 立刻收场；`say` 照说，后面的照问——按轮计数的规则要看到每一轮。
 * 返回 `undefined` 是再来一轮。
 */
export async function askAfterTools(checks: TurnChecks, turn: ToolTurn, inject: Inject): Promise<Ending | undefined> {
	for (const check of checks.afterTools) {
		const verdict = await check(turn);
		if (!verdict) continue;
		if ("end" in verdict) return verdict.end;
		await inject(verdict.say);
	}
	return undefined;
}

/** 一次运行一份：计数跟着运行走，`repetition` 由调用方给，跨整条续跑链共用。 */
export function turnChecks(control: AgentControlContext, emit: AgentEventSink, plan: PlanWatch, repetition: RepetitionWatch): TurnChecks {
	const limit = outputLimit(emit);
	return {
		afterProse: [
			limit.prose,
			emptyReply(),
			stopHook(control),
			({ turnsLeft }) => say(plan.closing(turnsLeft)),
		],
		afterTools: [
			delivered,
			({ toolCalls, toolResults }) => (plan.settled(toolCalls, toolResults) ? { end: { reason: "done" } } : undefined),
			limit.tools,
			repeats(repetition),
			({ assistant, toolCalls }) => say(plan.progress(assistant, toolCalls)),
		],
	};
}

/**
 * The runtime speaking in the user role — the only role a model takes instructions in — marked so
 * the window does not draw it in the person's bubble as something they typed.
 */
function synthetic(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), synthetic: true };
}

function say(text: string | undefined): Verdict {
	return text === undefined ? undefined : { say: synthetic(text) };
}

/**
 * 撞上输出上限，两条路共用一个连续计数：一条没被截断的回复，不管带不带工具，都清零。
 *
 * Cut off by the output limit is not finished: let it continue from the break, a bounded number of
 * times. Tool calls with cut-off arguments were already failed when the tools ran; here they are
 * only counted.
 */
function outputLimit(emit: AgentEventSink): { prose: Check<ProseTurn>; tools: Check<ToolTurn> } {
	let streak = 0;
	return {
		prose: async ({ assistant, turnsLeft }) => {
			if (assistant.stopReason !== "length") {
				streak = 0;
				return undefined;
			}
			streak += 1;
			if (streak <= MAX_TRUNCATED_REPLIES && turnsLeft) return say(CONTINUE_AFTER_LENGTH);
			await emit({ type: "notice", level: "warn", message: "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。", code: "output-limit" });
			return undefined;
		},
		tools: ({ assistant }) => {
			const truncated = assistant.stopReason === "length";
			streak = truncated ? streak + 1 : 0;
			if (!truncated || streak <= MAX_TRUNCATED_REPLIES) return undefined;
			return { end: { reason: "error", error: "回复连续多次在工具参数写到一半时达到输出长度上限，已停下。可以让它把内容拆小，或换一个输出上限更大的模型。" } };
		},
	};
}

/**
 * A checklist cannot tell a question from abandoned work. Text yields to the person; only an
 * actually empty response earns a bounded retry.
 */
function emptyReply(): Check<ProseTurn> {
	let nudges = 0;
	return ({ assistant }) => {
		const saidNothing = assistant.content.every((part) => part.type !== "text" || !part.text.trim());
		if (!saidNothing) return undefined;
		if (nudges >= MAX_NUDGES) return { end: { reason: "error", error: "模型连续返回空回复，请重试或更换模型。" } };
		nudges += 1;
		return say(EMPTY_REPLY_NUDGE);
	};
}

function stopHook(control: AgentControlContext): Check<ProseTurn> {
	return async ({ assistant, produced }) => {
		if (!control.onStop || control.signal?.aborted) return undefined;
		const responseText = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		const toolCallCount = produced.filter((message) => message.role === "toolResult").length;
		const resume = await control.onStop({ responseText, toolCallCount }).catch(() => undefined);
		return resume && !control.signal?.aborted ? { say: resume } : undefined;
	};
}

/**
 * A tool said "that's it" (`yield`): the result is already in `state`, and nobody reads another
 * reply. Asking anyway once retried an empty answer 222 times over 34 minutes.
 */
const delivered: Check<ToolTurn> = ({ toolResults }) =>
	toolResults.some((result) => result.terminate === true) ? { end: { reason: "done" } } : undefined;

/**
 * Same call, same arguments, same answer — again. Correct first, stop only when correction failed.
 *
 * From the third identical answer on, the model sees "this is the Nth time" instead of the same
 * text again. Replaced after commit, so the log keeps the original; the cost is one prefix break
 * after a restart. See docs/architecture/agent-loop.md.
 */
function repeats(watch: RepetitionWatch): Check<ToolTurn> {
	return ({ toolCalls, toolResults, messages }) => {
		const { warn: repeated, kind, repeats: seenCounts } = watch.observe(toolCalls, toolResults);
		if (watch.exhausted()) return { end: { reason: "stalled" } };

		for (const [index, seen] of seenCounts.entries()) {
			if (seen < REPEAT_WARN) continue;
			const result = toolResults[index];
			if (!result) continue;
			// Pruning may have replaced the earlier copies with pointers; then this one is the original.
			if (!originalInView(messages, toolCalls[index], result)) continue;
			result.content = [{ type: "text", text: repeatNotice(seen, toolCalls[index].name) }];
		}
		return repeated ? say(repeatHint(kind, repeated)) : undefined;
	};
}
