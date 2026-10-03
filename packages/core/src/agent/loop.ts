/**
 * The agent loop.
 *
 * One turn = one assistant response plus every tool it asked for. The loop keeps turning
 * while the model emits tool calls, and drains a steering queue between turns so the user
 * can redirect a running agent without cancelling it.
 *
 * Why each recovery and stopping path is shaped the way it is: docs/architecture/agent-loop.md.
 */

import { compactStep } from "./compact-step.ts";
import { originalInView, REPEAT_WARN, repeatNotice, RepetitionWatch } from "./repetition.ts";
import type { AgentModelContext, AgentRunConfig, AgentRunResult } from "./run-config.ts";
import { rejectedContent, streamTurn, type TurnResult } from "./stream-turn.ts";
import { failTruncatedCalls, runTools } from "./tool-run.ts";
import { isContextOverflow } from "../ai/failure.ts";
import { stripOversizedToolResults } from "../runtime/prune.ts";
import { AgedToolPruner } from "../runtime/aged-prune.ts";
import { stripStaleHandles } from "../runtime/model-switch.ts";
import { withEnvironment } from "../prompt/environment.ts";
import { clearActiveSkill, syncSkillContext } from "../skills/tool.ts";
import type { AssistantContent, AssistantMessage, LlmContext, Message, ToolResultMessage } from "../types.ts";
import type { AgentEventSink } from "./events.ts";

export type {
	AfterToolCall,
	AgentControlContext,
	AgentModelContext,
	AgentRunConfig,
	AgentRunResult,
	AgentSessionContext,
	AgentToolContext,
	BeforeToolCall,
	LiveModel,
	PermissionRequestHook,
	StopHook,
	StreamFn,
	StreamRequest,
	ToolEnvironment,
} from "./run-config.ts";

const DEFAULT_MAX_TURNS = 200;
/** Empty-response retries per run; tool calls must not replenish this budget. */
const MAX_NUDGES = 3;
/** Consecutive replies cut off by the output limit before the run stops and says so. */
const MAX_TRUNCATED_REPLIES = 3;
const TRUNCATED_CALL_REASON =
	"the response hit the output token limit before this call's arguments were complete. Re-issue it with less in one call: " +
	"write a large file in parts (create it with the first part, then add the rest with edit), and send fewer calls per reply";
const CONTINUE_AFTER_LENGTH = "（自动继续）上一条回复达到了输出长度上限，在中途被截断。请从断开的地方直接接着写，不要重复已经写出的内容。";
const EMPTY_REPLY_NUDGE = "（自动继续）上一条回复没有正文。请给出回答；如果需要用户补充信息，请直接提问并等待回复。";

/** Appended to a lone todo_write's result. The wording names the cost, not just the rule. */
export const SOLO_TODO_NOTE =
	"（这一轮只调了 todo_write，没有做任何实际工作。从下一轮起，把清单更新和真正的下一步——读文件、改代码、跑命令——放在同一次回复里；单独更新清单是浪费一次往返。）";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
type Ending = { reason: AgentRunResult["reason"]; error?: string; retryable?: boolean };

/** What one run carries from turn to turn. */
interface Run {
	readonly config: AgentRunConfig;
	readonly emit: AgentEventSink;
	/** The model's view of the history. Mutated in place: compaction and pruning replace its contents. */
	readonly messages: Message[];
	/** Messages produced by this run, so the caller can append them to the persisted session. */
	readonly produced: Message[];
	readonly state: Map<string, unknown>;
	readonly repetition: RepetitionWatch;
	readonly pruner: AgedToolPruner;
	/** The model group as of the current model; differs from `config.model` only after a live switch. */
	active: AgentModelContext;
	/**
	 * Steering drained at the end of a turn, injected at the start of the next. `drainSteering`
	 * empties the queue, so what it returned must be held here or the person's message is lost.
	 */
	carried: Message[];
	/** Empty-response retries spent in this run. */
	nudges: number;
	/** Consecutive replies that hit the output limit; reset by one that did not. */
	truncations: number;
}

export async function runAgent(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult> {
	const run: Run = {
		config,
		emit,
		messages: [...config.session.messages],
		produced: [],
		state: config.session.state ?? new Map<string, unknown>(),
		repetition: config.control.repetition ?? new RepetitionWatch(),
		pruner: config.session.pruner ?? new AgedToolPruner(),
		active: config.model,
		carried: [],
		nudges: 0,
		truncations: 0,
	};
	const maxTurns = config.control.maxTurns ?? DEFAULT_MAX_TURNS;
	await emit({ type: "agent_start", sessionId: config.session.sessionId });

	let turn = 0;
	while (true) {
		if (config.control.signal?.aborted) return finish(run, { reason: "aborted" });
		if (turn >= maxTurns) return finish(run, { reason: "max_turns" });
		turn += 1;
		await emit({ type: "turn_start", turn });

		await takeSteering(run, turn === 1);
		if (!(await prepareHistory(run))) return finish(run, { reason: "aborted" });

		const assistant = await requestReply(run);
		if (assistant === "aborted") return finish(run, { reason: "aborted" });
		// A request let go for a model switch did nothing; it is not charged as a turn.
		if (assistant === "switched") {
			turn -= 1;
			continue;
		}

		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
			await closeUnansweredCalls(run, assistant);
			if (assistant.stopReason === "aborted") return finish(run, { reason: "aborted" });
			return finish(run, { reason: "error", error: assistant.errorMessage, retryable: assistant.errorRetryable });
		}

		const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
		const ending = toolCalls.length === 0
			? await endWithoutTools(run, assistant, turn < maxTurns)
			: await runToolTurn(run, assistant, toolCalls);
		if (ending) return finish(run, ending);
	}
}

async function finish(run: Run, { reason, error, retryable }: Ending): Promise<AgentRunResult> {
	await run.emit({ type: "agent_end", reason, error });
	return { messages: run.produced, view: [...run.messages], reason, error, ...(retryable ? { retryable } : {}) };
}

/** Add a message the window has not seen yet: the runtime or the person speaking between replies. */
async function inject(run: Run, message: Message): Promise<void> {
	keep(run, message);
	await run.emit({ type: "message_start", message });
	await run.emit({ type: "message_end", message });
}

/** Add messages whose events were already emitted where they were produced. */
function keep(run: Run, ...messages: Message[]): void {
	run.messages.push(...messages);
	run.produced.push(...messages);
}

/**
 * The runtime speaking in the user role — the only role a model takes instructions in — marked so
 * the window does not draw it in the person's bubble as something they typed.
 */
function synthetic(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now(), synthetic: true };
}

function replaceHistory(run: Run, next: Message[]): void {
	if (next === run.messages) return;
	run.messages.length = 0;
	run.messages.push(...next);
}

/** Earlier originals went into the summary; reading them again is retrieval, not repetition. */
function adoptCompaction(run: Run, messages: Message[]): void {
	replaceHistory(run, messages);
	run.repetition.reset();
}

function requestMessages(run: Run): Message[] {
	return run.config.session.environment ? withEnvironment(run.messages) : run.messages;
}

/** Written by the person, as opposed to the runtime speaking in the user role. */
function fromPerson(message: Message): boolean {
	return message.role === "user" && !message.synthetic;
}

/**
 * Whether the person said something after the model last spoke. Looks at the whole trailing run of
 * user messages: synthetic ones (a prompt update, a date block) can land after the prompt.
 */
function humanSinceLastReply(messages: readonly Message[]): boolean {
	for (let at = messages.length - 1; at >= 0 && messages[at].role === "user"; at--) {
		if (fromPerson(messages[at])) return true;
	}
	return false;
}

async function takeSteering(run: Run, first: boolean): Promise<void> {
	const steering = [...run.carried, ...(run.config.control.drainSteering?.() ?? [])];
	run.carried = [];
	/*
	 * A new instruction from the person ends the previous skill's tool restriction, or it would
	 * silently refuse work they just asked for. On the first turn that includes the prompt that
	 * started this run — the state map outlives the run. Checking only fresh steering missed both.
	 */
	if ((first && humanSinceLastReply(run.config.session.messages)) || steering.some(fromPerson)) clearActiveSkill(run.state);
	for (const message of steering) await inject(run, message);
}

/** Model switch, pruning, compaction — everything that reshapes history before a request. False when stopped. */
async function prepareHistory(run: Run): Promise<boolean> {
	const { session, model, control } = run.config;
	/*
	 * Switch at the top of the loop. Strip every provider handle before this point rather than
	 * comparing each message's `model`: providers report names that do not match the config
	 * (dates, aliases), and a per-message compare strips the same model's own thinking signatures.
	 */
	const wanted = model.liveModel?.current();
	if (wanted && wanted.model.id !== run.active.model.id) {
		replaceHistory(run, stripStaleHandles(run.messages, run.messages.length));
		run.active = { ...model, provider: wanted.provider, model: wanted.model };
		model.liveModel?.adopted?.(wanted.model);
	}

	// Decide how new results look the first time they are sent; resend sent ones as they were.
	replaceHistory(run, run.pruner.prepare(run.messages, session.artifacts));

	if (session.compact) {
		const compaction = await compactStep(session, control.signal, run.messages, run.active.model, run.emit, { provider: run.active.provider });
		if (control.signal?.aborted) return false;
		if (compaction) adoptCompaction(run, compaction.messages);
	}
	// Compaction can wait on a model; cancellation during that await must prevent a new request.
	return !control.signal?.aborted;
}

/**
 * One request, with at most one recovery for each way the far end can refuse it.
 *
 * Rejected payload: drop oversized tool results and ask once more. Context overflow: force one
 * compaction and ask once more. Neither loops — the resend never comes back through here — and a
 * failed recovery surfaces the original error.
 */
async function requestReply(run: Run): Promise<AssistantMessage | "switched" | "aborted"> {
	const { config: { session, tools, control }, emit } = run;
	const context: LlmContext = {
		systemPrompt: session.systemPrompt,
		messages: requestMessages(run),
		tools: tools.available.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
	};
	// The session's own map, not the run's fallback: only a session that keeps one compares prefixes.
	const scope = { signal: control.signal, state: session.state };
	let reply = await streamTurn(run.active, context, scope, emit);
	if (reply.switched) return "switched";
	const resend = async (previous: TurnResult): Promise<TurnResult> => {
		await previous.held?.discard();
		return streamTurn(run.active, { ...context, messages: requestMessages(run) }, scope, emit);
	};

	if (rejectedContent(reply.message)) {
		const stripped = stripOversizedToolResults(run.messages);
		if (stripped !== run.messages) {
			await emit({
				type: "notice",
				level: "warn",
				message: "模型服务拒收了这次请求。已把其中过大的工具输出压成一行，正在重试。",
			});
			replaceHistory(run, stripped);
			reply = await resend(reply);
		}
	}
	if (!reply.switched && reply.message.stopReason === "error" && isContextOverflow(reply.message.failure) && session.compact) {
		await emit({ type: "notice", level: "warn", message: "上下文超出了模型的上限，正在压缩历史后重试。" });
		const held = reply.held;
		const compaction = await compactStep(session, control.signal, run.messages, run.active.model, emit, { force: true, provider: run.active.provider }).catch(async (cause: unknown) => {
			// Commit the rejected reply before rethrowing: the transcript must say why the turn stopped.
			await held?.commit();
			throw cause;
		});
		if (control.signal?.aborted) {
			await held?.discard();
			return "aborted";
		}
		if (compaction) {
			adoptCompaction(run, compaction.messages);
			reply = await resend(reply);
		}
	}
	if (reply.switched) return "switched";
	await reply.held?.commit();
	keep(run, reply.message);
	return reply.message;
}

/**
 * Answer every call a cut-off reply had opened. Anthropic rejects a `tool_use` with no result after
 * it, so one orphan seals the conversation. The calls are failed, not run: arguments that stopped
 * arriving halfway are not arguments.
 */
async function closeUnansweredCalls(run: Run, assistant: AssistantMessage): Promise<void> {
	const unanswered = assistant.content.filter((c) => c.type === "toolCall");
	if (unanswered.length === 0) return;
	const why =
		assistant.stopReason === "aborted"
			? "the turn was stopped before it could run"
			: "the connection dropped while the call was still arriving, so its arguments are incomplete";
	keep(run, ...(await failTruncatedCalls(unanswered, run.emit, why)));
}

/** A reply with no tool calls: the run ends unless something still deserves another turn. */
async function endWithoutTools(run: Run, assistant: AssistantMessage, turnsLeft: boolean): Promise<Ending | undefined> {
	const { config: { control }, emit } = run;
	await emit({ type: "turn_end", message: assistant, toolResults: [] });
	/*
	 * Steering that arrived during the final stream still deserves an answer. At the turn cap it is
	 * left queued instead: taken here, the cap check at the top would drop it from both the
	 * transcript and the queue, while the host sends whatever is left in the queue.
	 */
	run.carried = turnsLeft ? control.drainSteering?.() ?? [] : [];
	if (run.carried.length > 0) return undefined;

	// Cut off by the output limit is not finished: let it continue from the break, a bounded number of times.
	if (assistant.stopReason === "length") {
		run.truncations += 1;
		if (run.truncations <= MAX_TRUNCATED_REPLIES && turnsLeft) {
			await inject(run, synthetic(CONTINUE_AFTER_LENGTH));
			return undefined;
		}
		await emit({ type: "notice", level: "warn", message: "回复连续多次达到输出长度上限，已停下。最后一段回答可能不完整。" });
	} else run.truncations = 0;

	// A checklist cannot tell a question from abandoned work. Text yields to the person; only an
	// actually empty response earns a bounded retry.
	const saidNothing = assistant.content.every((part) => part.type !== "text" || !part.text.trim());
	if (saidNothing) {
		if (run.nudges >= MAX_NUDGES) return { reason: "error", error: "模型连续返回空回复，请重试或更换模型。" };
		run.nudges += 1;
		await inject(run, synthetic(EMPTY_REPLY_NUDGE));
		return undefined;
	}

	if (control.onStop && !control.signal?.aborted) {
		const responseText = assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		const toolCallCount = run.produced.filter((message) => message.role === "toolResult").length;
		const resume = await control.onStop({ responseText, toolCallCount }).catch(() => undefined);
		if (resume && !control.signal?.aborted) {
			await inject(run, resume);
			return undefined;
		}
	}
	return { reason: "done" };
}

/** Run the calls a reply asked for, then decide whether the run can go on. */
async function runToolTurn(run: Run, assistant: AssistantMessage, toolCalls: ToolCall[]): Promise<Ending | undefined> {
	const { config: { session, tools, control }, state, emit } = run;
	syncSkillContext(state, run.messages);
	const truncated = assistant.stopReason === "length";
	run.truncations = truncated ? run.truncations + 1 : 0;
	/*
	 * A reply that only updated the list did nothing else. Said in that call's own result, where the
	 * model reads next. Measured before this: nearly half the tool turns on a three-step task were a
	 * lone todo_write.
	 */
	const soloTodo = toolCalls.length === 1 && toolCalls[0].name === "todo_write" && tools.available.length > 1;
	const toolResults = truncated
		? await failTruncatedCalls(toolCalls, emit, TRUNCATED_CALL_REASON)
		: await runTools(toolCalls, tools, { sessionId: session.sessionId, signal: control.signal, state }, emit, soloTodo ? SOLO_TODO_NOTE : undefined);
	keep(run, ...toolResults);
	await emit({ type: "turn_end", message: assistant, toolResults });

	/*
	 * A tool said "that's it" (`yield`): the result is already in `state`, and nobody reads another
	 * reply. Asking anyway once retried an empty answer 222 times over 34 minutes.
	 */
	if (toolResults.some((result) => result.terminate === true)) return { reason: "done" };

	if (truncated && run.truncations > MAX_TRUNCATED_REPLIES) {
		return { reason: "error", error: "回复连续多次在工具参数写到一半时达到输出长度上限，已停下。可以让它把内容拆小，或换一个输出上限更大的模型。" };
	}
	return answerRepeats(run, toolCalls, toolResults);
}

/**
 * Same call, same arguments, same answer — again. Correct first, stop only when correction failed.
 *
 * From the third identical answer on, the model sees "this is the Nth time" instead of the same
 * text again. Replaced after commit, so the log keeps the original; the cost is one prefix break
 * after a restart. See docs/architecture/agent-loop.md.
 */
async function answerRepeats(run: Run, toolCalls: ToolCall[], toolResults: ToolResultMessage[]): Promise<Ending | undefined> {
	const { warn: repeated, kind, repeats } = run.repetition.observe(toolCalls, toolResults);
	if (run.repetition.exhausted()) return { reason: "stalled" };

	for (const [index, seen] of repeats.entries()) {
		if (seen < REPEAT_WARN) continue;
		const result = toolResults[index];
		if (!result) continue;
		// Pruning may have replaced the earlier copies with pointers; then this one is the original.
		if (!originalInView(run.messages, toolCalls[index], result)) continue;
		result.content = [{ type: "text", text: repeatNotice(seen, toolCalls[index].name) }];
	}
	if (repeated) await inject(run, synthetic(repeatHint(kind, repeated)));
	return undefined;
}

/**
 * One wording per line of detection: telling a call that changes `offset` every time that it used
 * "the same arguments" is visibly false, and the model then distrusts the half that mattered.
 */
function repeatHint(kind: "exact" | "intent" | "probe" | undefined, tool: string): string {
	if (kind === "probe") {
		return `（自动提示）你已经连续多次切图、读切片或做像素测距。` +
			`这类探测回答不了「为什么间距是这样」——去读对应的 CSS 和组件结构，基于已有证据下结论。` +
			`不要再写新的测距脚本，也不要再切图。`;
	}
	if (kind === "intent") {
		return `（自动提示）你已经用不同的翻页参数把 \`${tool}\` 的同一个问题问了很多遍。` +
			`翻页不会把答案翻出来——要么它本来就不在这里，要么该换个问法。` +
			`换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`;
	}
	return `（自动提示）你已经用同样的参数调用 \`${tool}\` 多次，每次得到的结果都一样。` +
		`再问一次不会有新信息。换一个思路：换个工具、换个假设，或者直接说明当前卡在哪里、需要什么。`;
}
