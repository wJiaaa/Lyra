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
import { lineageFrom } from "./lineage.ts";
import { RepetitionWatch } from "./repetition.ts";
import { PlanWatch } from "./plan-watch.ts";
import type { AgentModelContext, AgentRunConfig, AgentRunResult } from "./run-config.ts";
import { rejectedContent, streamTurn, type TurnResult } from "./stream-turn.ts";
import { failTruncatedCalls, runTools } from "./tool-run.ts";
import { askAfterProse, askAfterTools, turnChecks, type Ending, type TurnChecks } from "./turn-checks.ts";
import { isContextOverflow } from "../ai/failure.ts";
import { stripOversizedToolResults } from "./prune.ts";
import { AgedToolPruner } from "./aged-prune.ts";
import { stripStaleHandles } from "./model-switch.ts";
import { withEnvironment } from "../prompt/environment.ts";
import { withInterfaceNotes } from "../ui-language/notes.ts";
import { withSteeringNote } from "../prompt/steering.ts";
import { clearActiveSkill, syncSkillContext } from "../skills/tool.ts";
import { toolTable } from "../tools/mcp-search.ts";
import type { AssistantContent, AssistantMessage, LlmContext, Message } from "../types.ts";
import type { AgentEventSink } from "./events.ts";

export type { AgentRunConfig, AgentRunResult, LiveModel, StreamRequest } from "./run-config.ts";

const DEFAULT_MAX_TURNS = 200;
const TRUNCATED_CALL_REASON =
	"the response hit the output token limit before this call's arguments were complete. Re-issue it with less in one call: " +
	"write a large file in parts (create it with the first part, then add the rest with edit), and send fewer calls per reply";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

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
	/** 清单相关的三句话：单独调清单、跑久了问进度、收尾时清单没勾完。 */
	readonly plan: PlanWatch;
	/** 回复处理完以后还要不要再来一轮，按顺序问的两张表。 */
	readonly checks: TurnChecks;
}

export async function runAgent(config: AgentRunConfig, emit: AgentEventSink): Promise<AgentRunResult> {
	const state = config.session.state ?? new Map<string, unknown>();
	const repetition = config.control.repetition ?? new RepetitionWatch();
	const plan = new PlanWatch(state, config.tools.available);
	const run: Run = {
		config,
		emit,
		messages: [...config.session.messages],
		produced: [],
		state,
		repetition,
		pruner: config.session.pruner ?? new AgedToolPruner(),
		active: config.model,
		carried: [],
		plan,
		checks: turnChecks(config.control, emit, plan, repetition),
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
			return finish(run, { reason: "error", error: assistant.errorMessage });
		}

		const toolCalls = assistant.content.filter((c) => c.type === "toolCall");
		const ending = toolCalls.length === 0
			? await endWithoutTools(run, assistant, turn < maxTurns)
			: await runToolTurn(run, assistant, toolCalls);
		if (ending) return finish(run, ending);
	}
}

async function finish(run: Run, { reason, error }: Ending): Promise<AgentRunResult> {
	await run.emit({ type: "agent_end", reason, error });
	return { messages: run.produced, view: [...run.messages], reason, error };
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
	return requestView(run.messages, run.config.session.environment);
}

/**
 * 历史在发出去时的样子：日期块、插话说明、界面提示都在这里接上。
 *
 * 导出是因为循环外的压缩（`/compact`、一轮收尾后的压缩）也要从上一次请求分叉，消息必须和循环
 * 下一次要发的逐字节相同——照这一个函数算，而不是各自再拼一遍。
 */
export function requestView(messages: Message[], environment: boolean): Message[] {
	return withInterfaceNotes(withSteeringNote(environment ? withEnvironment(messages) : messages));
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
	for (const message of steering) {
		// 原地打标记而不是复制：子代理的插话在说出口时已经按身份登记过一次（`steerSubAgent`），换一个对象会再登记一遍。
		if (message.role === "user") message.steered = true;
		await inject(run, message);
	}
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
		// 摘要请求从上一次请求分叉，消息就是下一次要发的那份（`requestMessages`），见 `lineage.ts`。
		const lineage = lineageFrom(session.state, requestMessages(run));
		const compaction = await compactStep(session, control.signal, run.messages, run.active.model, run.emit, { provider: run.active.provider, lineage });
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
		// 被延迟的不发，换成两个入口：见 `tools/mcp-search.ts`。
		tools: toolTable(tools.available).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
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
				code: "request-rejected",
			});
			replaceHistory(run, stripped);
			reply = await resend(reply);
		}
	}
	if (!reply.switched && reply.message.stopReason === "error" && isContextOverflow(reply.message.failure) && session.compact) {
		await emit({ type: "notice", level: "warn", message: "上下文超出了模型的上限，正在压缩历史后重试。", code: "context-overflow" });
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
	run.plan.replied();
	await emit({ type: "turn_end", message: assistant, toolResults: [] });
	/*
	 * Steering that arrived during the final stream still deserves an answer. At the turn cap it is
	 * left queued instead: taken here, the cap check at the top would drop it from both the
	 * transcript and the queue, while the host sends whatever is left in the queue.
	 */
	run.carried = turnsLeft ? control.drainSteering?.() ?? [] : [];
	if (run.carried.length > 0) return undefined;

	return askAfterProse(run.checks, { assistant, turnsLeft, produced: run.produced }, (message) => inject(run, message));
}

/** Run the calls a reply asked for, then decide whether the run can go on. */
async function runToolTurn(run: Run, assistant: AssistantMessage, toolCalls: ToolCall[]): Promise<Ending | undefined> {
	const { config: { session, tools, control }, state, emit } = run;
	syncSkillContext(state, run.messages);
	const note = run.plan.beforeTools(toolCalls);
	const toolResults = assistant.stopReason === "length"
		? await failTruncatedCalls(toolCalls, emit, TRUNCATED_CALL_REASON)
		: await runTools(toolCalls, tools, { sessionId: session.sessionId, signal: control.signal, state }, emit, note);
	keep(run, ...toolResults);
	await emit({ type: "turn_end", message: assistant, toolResults });

	return askAfterTools(run.checks, { assistant, toolCalls, toolResults, messages: run.messages }, (message) => inject(run, message));
}
