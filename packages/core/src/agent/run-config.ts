/**
 * What a run of the agent loop is given and what it hands back.
 *
 * Its own file because it is the contract, not the loop: the session, sub-agents, side chats, hooks
 * and the tool runner all build or read these, and a loop swapped in through `useAgentLoop` honours
 * the same shapes.
 *
 * Four groups, one per consumer: `stream-turn` reads only `model`, `tool-run` only `tools`, history
 * code only `session`, and the loop orchestrates all four. Handles more than one of them needs — the
 * stop signal, the session state map, the session id — belong to one group and are passed down by
 * the loop as arguments, never copied into a second group. Why: docs/adr/0034-run-config-groups.md.
 */

import type { CompactHistory } from "./compact-step.ts";
import type { RepetitionWatch } from "./repetition.ts";
import type { RetryPolicySource } from "../config/retry-policy.ts";
import type { AgedToolPruner } from "../runtime/aged-prune.ts";
import type { ArtifactSink } from "../runtime/prune.ts";
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

/**
 * Every key required, `undefined` allowed.
 *
 * A builder has to say what it gives, even when that is nothing: an optional field that one builder
 * forgot is how a sub-agent once ran outside the session's sandbox without a word
 * (`runtime/tool-policy.ts`). Mapped over `Required<T>` because `-?` would also strip the `undefined`.
 */
type Stated<T> = { [K in keyof Required<T>]: Required<T>[K] | undefined };

export interface AgentRunConfig {
	session: AgentSessionContext;
	model: AgentModelContext;
	tools: AgentToolContext;
	control: AgentControlContext;
}

/** Which conversation this is, what it has said so far, and everything that reshapes that history. */
export interface AgentSessionContext {
	sessionId: string;
	systemPrompt: string;
	messages: Message[];
	/** Session-scoped scratch space shared by every tool; `undefined` gives the run a fresh one. */
	state: Map<string, unknown> | undefined;
	/**
	 * Render the `<env>` date blocks into every request rather than into `messages`.
	 *
	 * For the main session, whose history is rebuilt from the log each turn and the log has none;
	 * rendering reads only message timestamps, so the bytes stay stable (`prompt/environment.ts`).
	 * Sub-agents leave it off: they store the rendered `view` and resume from it.
	 */
	environment: boolean;
	/**
	 * Called before each request. Return a replacement history to compact it when the conversation
	 * approaches the context window, along with what to record so the compaction outlives this run.
	 */
	compact: CompactHistory | undefined;
	/** Shared across a continuation chain like `control.repetition`; `undefined` gives a fresh one. */
	pruner: AgedToolPruner | undefined;
	/** Where pruned and compacted tool output is kept so `artifact://` can return it. */
	artifacts: ArtifactSink | undefined;
}

/** Which model answers and how each request to it is made. */
export interface AgentModelContext {
	provider: ProviderConfig;
	model: ModelConfig;
	/**
	 * The model this conversation should use right now; it can change mid-run (ADR-0025).
	 * `undefined` means `provider` / `model` hold for the whole run: sub-agents, side chats, evals, tests.
	 */
	liveModel: LiveModel | undefined;
	thinking: ThinkingLevel | undefined;
	/**
	 * Stable id of this conversation prefix, sent as `prompt_cache_key` / affinity header.
	 * Session id for the main session, run id for a sub-agent (kept across resumes), its own for a
	 * side chat. One-off requests (summaries, titles) do not go through the loop and carry none.
	 */
	cacheKey: string | undefined;
	retryPolicy: RetryPolicySource | undefined;
	/** Replaces the provider call: tests script turns through it, and a host can route every request. */
	streamFn: StreamFn | undefined;
	/** Observe the effective request after pruning, compaction and overflow recovery. */
	onContext: ((context: LlmContext, model: ModelConfig) => void) | undefined;
	/** Attempts per request, including the first, for a caller with no `retryPolicy` of its own. */
	retryAttempts?: number;
	maxTokens?: number;
	temperature?: number;
}

/**
 * What every tool call is handed unchanged. Derived from `ToolContext`, so a field added there fails
 * to compile in every builder until each one states what it gives. The rest of `ToolContext` is per
 * call or owned elsewhere, and the tool runner fills it in.
 */
export type ToolEnvironment = Stated<Omit<ToolContext, "cwd" | "sessionId" | "signal" | "state" | "onProgress" | "requestApproval">> & {
	cwd: string;
};

/** The tools a run offers, the world they run in, and what is asked around each call. */
export interface AgentToolContext {
	available: Tool[];
	env: ToolEnvironment;
	/** Asks a person. Wrapped per call by the tool runner so hooks can answer first. */
	requestApproval: ((request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;
	beforeToolCall: BeforeToolCall | undefined;
	afterToolCall: AfterToolCall | undefined;
	permissionRequest: PermissionRequestHook | undefined;
}

/** When the run stops, and what may keep it going. */
export interface AgentControlContext {
	signal: AbortSignal | undefined;
	/** Messages the user typed while the agent was mid-turn. Drained between turns. */
	drainSteering: (() => Message[]) | undefined;
	onStop: StopHook | undefined;
	/**
	 * Shared across a whole continuation chain (`runtime/continuation.ts`), so the count survives
	 * each restart — a fresh watch per call never accumulates enough to notice anything.
	 * `undefined` for single calls (sub-agents, evals, tests), which have no previous segment.
	 */
	repetition: RepetitionWatch | undefined;
	maxTurns?: number;
}

/*
 * Exactly four groups, and no key in two of them. Checked here because only `src/` is type-checked;
 * a field that seems to belong to two groups belongs to one, and the loop passes it to the other.
 */
type Groups = { [K in keyof AgentRunConfig]: keyof AgentRunConfig[K] };
type Shared = {
	[A in keyof Groups]: { [B in Exclude<keyof Groups, A>]: Groups[A] & Groups[B] }[Exclude<keyof Groups, A>];
}[keyof Groups];
const groupsAreDisjoint: [Shared] extends [never] ? true : never = true;
const exactlyFourGroups: [keyof AgentRunConfig] extends ["session" | "model" | "tools" | "control"] ? true : never = true;
void groupsAreDisjoint;
void exactlyFourGroups;

/** Replaces the provider call; see `AgentModelContext.streamFn`. */
export type StreamFn = (context: LlmContext, request: StreamRequest) => Promise<AssistantMessage>;

/**
 * Runs before a tool executes. Returning `block` turns the call into an error result the model can
 * react to, without ending the turn.
 */
export type BeforeToolCall = (call: {
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
export type AfterToolCall = (call: {
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
export type PermissionRequestHook = (
	call: { toolName: string; args: Record<string, unknown>; toolCallId: string },
	request: ApprovalRequest,
) => Promise<ApprovalDecision | undefined>;

/**
 * Asked when the model is about to finish. A message returned is injected and the loop goes on —
 * the Stop hook saying the work is not done yet, and why.
 */
export type StopHook = (info: { responseText: string; toolCallCount: number }) => Promise<Message | undefined>;

/**
 * What a stand-in for the provider call is given: the `model` group narrowed to one request, plus the
 * run's stop signal.
 *
 * Narrow on purpose. It used to be the whole `AgentRunConfig`, so every field added to the loop
 * widened the provider seam too, and callers outside the loop (compaction's summary) had to fake a
 * run — empty tools, a borrowed session id — to call it.
 */
export interface StreamRequest {
	provider: ProviderConfig;
	model: ModelConfig;
	thinking?: ThinkingLevel;
	maxTokens?: number;
	temperature?: number;
	cacheKey?: string;
	signal?: AbortSignal;
}

/** The model the session has selected right now, and when that changes. See ADR-0025. */
export interface LiveModel {
	/** Which one to use now; null when it cannot be resolved (deleted), and the loop keeps its own. */
	current(): { provider: ProviderConfig; model: ModelConfig } | null;
	/**
	 * Notified on change; returns an unsubscribe. Reading once per turn is not enough: the request
	 * being retried against a broken upstream is exactly why the person switched.
	 */
	onChange(listener: () => void): () => void;
	/**
	 * The loop has switched: from the next request on it uses `model`. The session moves its switch
	 * point here — the old model may have finished one more reply since the button was pressed.
	 */
	adopted?(model: ModelConfig): void;
}

export interface AgentRunResult {
	messages: Message[];
	/**
	 * The whole history as the model saw it when the run ended — after compaction and pruning, with
	 * this run's output at the end. `messages` holds only the new part, and compaction happens out of
	 * sight. Resuming on the same context (sub-agents do) appends to this so the prefix matches byte
	 * for byte; rebuilding from the transcript loses the compaction boundary and moves date blocks.
	 *
	 * Optional: a loop swapped in through `useAgentLoop` need not provide it.
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
