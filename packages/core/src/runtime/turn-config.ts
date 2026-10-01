/**
 * What one turn is handed.
 *
 * Assembling this used to be fifty lines in the middle of the method that runs the turn, which
 * made a short piece of orchestration look long and buried the two decisions in it that are
 * actually interesting: where previews are written, and what a sub-agent inherits.
 *
 * Everything it needs arrives as a parameter. That is not ceremony — it is the list of things a
 * turn depends on, which is worth being able to read in one place.
 */

import type { AgentEvent } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import type { streamAssistant } from "../ai/index.ts";
import type { Settings } from "../config/settings.ts";
import type { Skill } from "../skills/loader.ts";
import { DispatchGate, normalizeMaxConcurrentSubAgents, rootDispatch } from "./dispatch-guard.ts";
import type { AgentDefinition } from "../tools/task.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	ModelConfig,
	ProviderConfig,
	ThinkingLevel,
	Tool,
} from "../types.ts";
import { plumeHome } from "../session/store.ts";
import { compactWith } from "./compaction.ts";
import type { ArtifactSink } from "./prune.ts";
import { textTokens, toolTokens } from "./context.ts";
import { writePreview } from "./previews.ts";
import { runSubAgent } from "./sub-agent.ts";
import type { SubAgentRegistry } from "./sub-agents.ts";
import type { DelegationWaits } from "./delegation-waits.ts";
import { resolveModelRef } from "../config/model-roles.ts";
import { projectRootsFor } from "../config/project-roots.ts";
import type { TurnContext } from "./turn.ts";
import { sandboxModeFor } from "../sandbox/mode-for.ts";
import { RepetitionWatch } from "../agent/repetition.ts";
import { sessionPruner } from "./aged-prune.ts";

export interface TurnConfigDeps {
	sessionId: string;
	cwd: string;
	provider: ProviderConfig;
	model: ModelConfig;
	settings: Settings;
	/** Resolve preferences at dispatch time without altering an already running model request. */
	getSettings?: () => Settings;
	state: Map<string, unknown>;
	tools: Tool[];
	skills: Skill[];
	agents: AgentDefinition[];
	/**
	 * Where dispatched sub-agents register, so they can be watched and steered while they run.
	 *
	 * Optional throughout: a host that only wants the answer passes nothing and delegation behaves
	 * exactly as before. See `runtime/sub-agents.ts`.
	 */
	subAgents?: SubAgentRegistry;
	/**
	 * 父会话在等的派发，人一开口就放手——见 `delegation-waits.ts`。会话给，CLI 和测试可以不给：
	 * 不给就是从前的样子，`task` 等到子代理跑完为止。
	 */
	delegations?: DelegationWaits;
	signal?: AbortSignal;
	streamFn?: AgentRunConfig["streamFn"];
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
	emit(event: AgentEvent): Promise<void>;
	/** The session's stream override, in the shape compaction expects. */
	summaryStream?: typeof streamAssistant;
	/**
	 * 压缩剪掉的原文往哪儿存，让 `artifact://` 能取回。
	 *
	 * 可选：不给的时候剪掉就是没了，跟以前一样。
	 */
	artifacts?: ArtifactSink;
	beforeToolCall: AgentRunConfig["beforeToolCall"];
	afterToolCall: AgentRunConfig["afterToolCall"];
	permissionRequest?: AgentRunConfig["permissionRequest"];
	onStop?: AgentRunConfig["onStop"];
	drainSteering: AgentRunConfig["drainSteering"];
	/** The session's address space. Session-scoped: its handlers hold session state. */
	resources?: AgentRunConfig["resources"];
	/** Where `scratch://` writes for this session. */
	scratchDir?: string;
	/** This session's committed messages, read from its own store; see `ToolContext.transcript`. */
	transcript?: AgentRunConfig["transcript"];
	/** Specific files outside the workspace explicitly granted to this turn. */
	allowedPaths?: ReadonlySet<string>;
	/** 见 `AgentRunConfig.liveModel`：人一轮中途换了模型，从下一个请求起就换。 */
	liveModel?: AgentRunConfig["liveModel"];
}

export function buildTurnConfig(
	deps: TurnConfigDeps,
	turn: TurnContext,
	systemPrompt: string,
	thinking?: ThinkingLevel,
): AgentRunConfig {
	/*
	 * 闸门在组装这一轮的时候就定好宽度，而不是等到第一次派活。
	 *
	 * 宽度是这一轮的属性。放在 `spawnSubAgent` 里懒算，结果是对的，但「这一轮有多宽」变成了
	 * 取决于「这一轮有没有派过活」——在没派活的会话里根本不存在，谁想看一眼都看不到。
	 */
	const gate = dispatchGate(deps);
	/*
	 * Read once per turn, for the same reason `sandboxMode` is decided here.
	 *
	 * The project list cannot change halfway through a turn in any way the turn should notice, and
	 * a tool that looked it up itself could disagree with the one running beside it.
	 */
	const projectRoots = projectRootsFor(deps.settings.projects, deps.cwd);
	return {

			sessionId: deps.sessionId,
			// 主会话的每个请求共享同一条前缀，续跑、换轮都是它。
			cacheKey: deps.sessionId,
			cwd: deps.cwd,
			provider: deps.provider,
			model: deps.model,
			liveModel: deps.liveModel,
			systemPrompt,
			tools: turn.tools,
			messages: turn.messages,
			thinking: thinking ?? deps.settings.thinking,
				retryPolicy: () => (deps.getSettings?.() ?? deps.settings).retryPolicy,
			signal: deps.signal,
			state: deps.state,
			/*
			 * Previews are written under the app's directory, keyed by this session.
			 *
			 * The workspace is the user's project; a page produced to demonstrate an idea
			 * is not part of it and should never turn up in `git status`. Keyed by session
			 * so it can be thrown away with the conversation that produced it.
			 */
			writePreview: (input) =>
				writePreview(plumeHome(), { ...input, sessionId: deps.sessionId }),
			transcript: deps.transcript,
			requestApproval: (request) => deps.requestApproval(request),
			/*
			 * What this turn's commands may change, derived from the permission mode.
			 *
			 * Derived here rather than read from settings by each tool, because it is one decision
			 * per turn: the mode cannot change halfway through a command, and a tool that looked it
			 * up itself could disagree with the one running beside it.
			 */
			sandboxMode: sandboxModeFor(deps.settings.permissionMode),
			// The network half, stated rather than derived: no permission mode implies it.
			sandboxNetwork: deps.settings.denyCommandNetwork ? "deny" : "allow",
			allowedHosts: deps.settings.allowedHosts,
			searchProviderId: deps.settings.searchProvider ?? null,
			/*
			 * 一只表，一条续跑链。
			 *
			 * 在这里建，而不是让 `runAgent` 自己建：续跑是拿同一份 config 再调一次 `runAgent`
			 * （`runtime/session-turn.ts`），共用这只表，跑满两百轮攒下的观察才不会在续跑时清零。
			 */
			repetition: new RepetitionWatch(),
			pruner: sessionPruner(deps.state),
			artifacts: deps.artifacts,
			allowedPaths: deps.allowedPaths,
			projectRoots,
			/*
			 * Queued rather than run on demand.
			 *
			 * A model asked to look at eight things dispatches eight, which is a reasonable thought
			 * and an unreasonable amount of concurrency — eight simultaneous runs each with their
			 * own context and their own model calls. The gate turns "do these eight" into "do these
			 * eight, four at a time", which is what was wanted; the prompt says the number so the
			 * model does not read the queue as slowness and try harder.
			 *
			 * 排队发生在 `runSubAgent` 里面（`admission`）：它先上名单、说出自己在排队，再等名额。
			 * 外面再包一层 `delegations.hold`——父会话等它，但人一开口就放手，见 `delegation-waits.ts`。
			 */
			spawnSubAgent: (input) => {
				let registered: string | undefined;
				const run = runSubAgent(
					{
						sessionId: deps.sessionId,
						cwd: deps.cwd,
						settings: deps.settings,
						getSettings: deps.getSettings,
						tools: deps.tools,
						skills: deps.skills,
						agents: deps.agents,
						signal: deps.signal,
						streamFn: deps.streamFn,
						requestApproval: (request) => deps.requestApproval(request),
						emit: (event) => deps.emit(event),
						// Where the run registers itself so it can be watched and steered. Absent for
						// hosts that only want the answer — see `SubAgentOptions.registry`.
						registry: deps.subAgents,
						// So a delegated run compacts through the same model call this session does.
						summaryStream: deps.summaryStream,
						/*
						 * 整棵派生树共用同一个闸门和同一条链。
						 *
						 * 闸门传下去，是因为「最多四个」如果每一层各算各的，就成了顶层四个、
						 * 每个下面再四个。链传下去，是因为深度和自递归都只有在链上才看得出来。
						 */
						gate,
						admission: (signal) => gate.acquire(signal),
						onRegistered: (id) => {
							registered = id;
						},
						dispatch: rootDispatch(),
						allowedPaths: deps.allowedPaths,
						transcript: deps.transcript,
					},
					input,
					// 派出去那一刻会话在用哪个——一轮中途换过模型的，后派的子代理跟着新的走。
					deps.liveModel?.current()?.provider ?? deps.provider,
					deps.liveModel?.current()?.model ?? deps.model,
					systemPrompt,
				);
				return deps.delegations ? deps.delegations.hold(run, () => registered) : run;
			},
			drainSteering: deps.drainSteering,
			resources: deps.resources,
			scratchDir: deps.scratchDir,
			beforeToolCall: deps.beforeToolCall,
			afterToolCall: deps.afterToolCall,
			permissionRequest: deps.permissionRequest,
			onStop: deps.onStop,
			// The session's own stream override applies here too; summarising is a model call.
			/*
			 * The session's own stream override applies here too; summarising is a model call.
			 *
			 * The overhead is handed over rather than inferred. Compaction has to know what the
			 * request carries besides the history — this prompt and these schemas, in full, every
			 * time — because a budget that treats them as part of the conversation shrinks them on
			 * paper when the conversation is cut, and the result lands over the line it was aiming
			 * for. That is a conversation which compacts on every single turn.
			 */
			compact: (messages, model, observer, options) => {
				// 一轮中途换过模型的，供应商跟着 loop 此刻的走，见 `CompactOptions.provider`。
				const provider = options?.provider ?? deps.provider;
				const summarizer = resolveModelRef(deps.settings, "@compact", { provider, model });
				return compactWith({
					messages,
					model,
					provider,
					streamFn: deps.summaryStream,
					overhead: textTokens(systemPrompt) + toolTokens(turn.tools),
					// 自动压缩剪掉的原文也存下来——它剪掉的量比手动压缩多得多。
					artifacts: deps.artifacts,
					summarizer,
					observer,
					force: options?.force,
				});
			},
			streamFn: deps.streamFn,
	};
}

/**
 * One gate per session, found through the session's own state map.
 *
 * Not a module-level singleton: two windows on two projects would then share a limit and slow each
 * other down for no reason anybody could see. The state map is already the session-scoped place
 * where things like this live.
 */
const GATE_KEY = "dispatchGate";

/**
 * 会话级的闸门，宽度每轮按设置重读。
 *
 * 闸门本身必须活过一轮——它数的是「现在有几个在跑」，每轮换一个就等于每轮从零开始数，上一轮
 * 派出去还没跑完的那些谁都不算数了。而宽度要每轮重读：并发上限可以在对话中途改，提示词里说的
 * 那个数（见 `prompt-context.ts`）和这里拦人的必须是同一个。
 */
function dispatchGate(deps: TurnConfigDeps): DispatchGate {
	// 现读，不用组装这一轮时的副本：上限能在对话中途改。
	const live = deps.getSettings?.() ?? deps.settings;
	const width = normalizeMaxConcurrentSubAgents(live.maxConcurrentSubAgents);
	const existing = deps.state.get(GATE_KEY);
	if (existing instanceof DispatchGate) {
		existing.setLimit(width);
		return existing;
	}
	const gate = new DispatchGate(width);
	deps.state.set(GATE_KEY, gate);
	return gate;
}

/**
 * 设置改了，闸门当场跟着改宽度——不等下一轮。
 *
 * 宽度原本只在组装一轮时重算。可正是「一轮」出了问题：主会话派出去四个、闸门只放一个的时候，
 * 这一轮要等四个依次跑完才结束，人在设置页把并发从 1 调到 4，排着的那三个照样一个一个地等——
 * 新的宽度要到下一轮才生效，而下一轮要等它们全部跑完。
 *
 * 还没派过活的会话没有闸门，什么都不用做：第一次派活时自然按新设置建。
 */
export function refreshDispatchGate(state: Map<string, unknown>, settings: Settings): void {
	const existing = state.get(GATE_KEY);
	if (existing instanceof DispatchGate) existing.setLimit(normalizeMaxConcurrentSubAgents(settings.maxConcurrentSubAgents));
}
