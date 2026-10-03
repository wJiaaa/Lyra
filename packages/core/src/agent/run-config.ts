/**
 * What a run of the agent loop is given and what it hands back.
 *
 * Its own file because it is the contract, not the loop: the session, sub-agents, side chats, hooks
 * and the tool runner all build or read these, and a loop swapped in through `useAgentLoop` honours
 * the same shapes.
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

export interface AgentRunConfig {
	sessionId: string;
	cwd: string;
	provider: ProviderConfig;
	model: ModelConfig;
	/**
	 * The model this conversation should use right now; it can change mid-run (ADR-0025).
	 * Omitted means `provider` / `model` hold for the whole run: sub-agents, side chats, evals, tests.
	 */
	liveModel?: LiveModel;
	systemPrompt: string;
	tools: Tool[];
	messages: Message[];
	thinking?: ThinkingLevel;
	/** Attempts per request, including the first, for a caller with no `retryPolicy` of its own. */
	retryAttempts?: number;
	retryPolicy?: RetryPolicySource;
	maxTokens?: number;
	temperature?: number;
	maxTurns?: number;
	/**
	 * Shared across a whole continuation chain (`runtime/continuation.ts`), so the count survives
	 * each restart — a fresh watch per call never accumulates enough to notice anything.
	 * Omitted for single calls (sub-agents, evals, tests), which have no previous segment.
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
	/** Passed through to the tools; see `ToolContext.transcript`. */
	transcript?: ToolContext["transcript"];
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
	streamFn?: (context: LlmContext, request: StreamRequest) => Promise<AssistantMessage>;
	/** Observe the effective request after pruning, compaction and overflow recovery. */
	onContext?: (context: LlmContext, model: ModelConfig) => void;
	/**
	 * Render the `<env>` date blocks into every request rather than into `messages`.
	 *
	 * For the main session, whose history is rebuilt from the log each turn and the log has none;
	 * rendering reads only message timestamps, so the bytes stay stable (`prompt/environment.ts`).
	 * Sub-agents leave it off: they store the rendered `view` and resume from it.
	 */
	environment?: boolean;
	/**
	 * Stable id of this conversation prefix, sent as `prompt_cache_key` / affinity header.
	 * Session id for the main session, run id for a sub-agent (kept across resumes), its own for a
	 * side chat. One-off requests (summaries, titles) do not go through the loop and carry none.
	 */
	cacheKey?: string;
	/**
	 * Runs before a tool executes. Returning `block` turns the call into an error result the
	 * model can react to, without ending the turn.
	 */
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
 * What a stand-in for the provider call is given: the request, not the loop's configuration.
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
