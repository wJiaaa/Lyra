/**
 * 派一个子代理要交代什么、它交回什么——`runSubAgent` 和它拆出去的几段共用的形状。
 *
 * 单独成文件，是为了那几段（`sub-agent-dispatch.ts`、`sub-agent-run.ts`……）不必回头引用
 * `sub-agent.ts`：它们由它调用，再引用它就成了环。
 */

import type { AgentEvent } from "../../agent/events.ts";
import type { ArtifactSink } from "../../agent/prune.ts";
import type { StreamFn } from "../../agent/run-config.ts";
import type { streamAssistant } from "../../ai/index.ts";
import type { Settings } from "../../config/settings.ts";
import type { ExtensionHost } from "../../extensions/host.ts";
import type { Skill } from "../../skills/loader.ts";
import type { AgentDefinition } from "../../tools/task.ts";
import type { ApprovalDecision, ApprovalRequest, Message, Tool } from "../../types.ts";
import type { SubAgentRegistry } from "./sub-agents.ts";

/**
 * What a delegated run hands back.
 *
 * `text` is what goes in the transcript and what the parent model reads. `output` is the same
 * answer as data, present only when the agent declared a schema and yielded against it — the
 * parent tool puts it in `details` so the UI can render it and `agent://<id>/<field>` can index
 * into it without the parent re-reading anything.
 */
export interface SubAgentAnswer {
	text: string;
	output?: Record<string, unknown>;
	/** Schema problems that were accepted rather than rejected. */
	warnings?: string[];
	/** 登记簿里的 id，续跑用。没有登记簿的宿主不给。 */
	id?: string;
	/** 没做完就停下了——`text` 开头那句话说了为什么。上下文还在，可以续跑。 */
	incomplete?: boolean;
	/** 人在面板上把它按停的。派它来的那一方不该自作主张地让它接着跑。 */
	stoppedByUser?: boolean;
	/** 父会话没等它跑完就放手了：它在后台接着跑，结果由运行时另外送回。见 `delegation-waits.ts`。 */
	detached?: boolean;
}

export interface SubAgentOptions {
	sessionId: string;
	cwd: string;
	settings: Settings;
	/** Resolve preferences at dispatch time without altering an already running model request. */
	getSettings?: () => Settings;
	tools: Tool[];
	skills: Skill[];
	agents: AgentDefinition[];
	signal?: AbortSignal;
	streamFn?: StreamFn;
	requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
	emit(event: AgentEvent): Promise<void>;
	/**
	 * The session's stream override in the shape compaction expects, passed down so a delegated run
	 * summarises through the same model call the parent does.
	 *
	 * Optional like `registry`: left off, compaction still runs — it falls back to a real provider
	 * call, exactly as the parent's does when nothing is overriding it.
	 */
	summaryStream?: typeof streamAssistant;
	/**
	 * Where this run registers itself, so it can be watched and steered while it happens.
	 *
	 * Optional: a host that only wants the answer — the CLI, a test — passes nothing and gets the
	 * old behaviour exactly. Delegation works the same either way; the registry only adds a window.
	 */
	registry?: SubAgentRegistry;
	/**
	 * 派它的会话的扩展，同一个宿主往下传。
	 *
	 * 扩展能拦工具调用（`tool_call`）。从前这里没有它，主对话里被扩展拦下的命令，派给子代理就能跑——
	 * 和沙箱、钩子当初漏掉是同一种事。可选只是为了直接调 `runSubAgent` 的测试；会话那条路一定给。
	 */
	extensions?: ExtensionHost;
	/** Passed through to the subagent; see `ToolContext.allowedPaths`. */
	allowedPaths?: ReadonlySet<string>;
	/** The dispatching conversation's messages, which is what `recall` searches from inside a delegation; see `ToolContext.transcript`. */
	transcript?: () => Promise<Message[]>;
	/**
	 * What the dispatching session's addresses resolve against, so `artifact://`, `scratch://`,
	 * `plugin://`… mean the same thing one level down, and pruned output lands where its marker's
	 * address reads it back. `lookups` holds only the keys `addressLookups` picks, never the
	 * parent's whole state. The router itself is the sub-agent's own; see `SUB_AGENT_SCHEMES` in `sub-agent-dispatch.ts`.
	 */
	addresses?: { artifacts?: ArtifactSink; lookups: ReadonlyMap<string, unknown>; scratchDir?: string };
	/**
	 * 怎么拿到一个名额：会话的那道闸门的 `acquire`。
	 *
	 * 在 `runSubAgent` 里面等，而不是像从前那样由调用方把整个调用包进 `gate.run`：它要先登记、在
	 * 名单上说出自己在排队，然后才等。包在外面的话，排着的那几个在名单上一个字都没有——一次派四个、
	 * 闸门只放一个的时候，界面上只看得见一个。
	 *
	 * 不给就是不排队（CLI、测试）。
	 */
	admission?: (signal: AbortSignal) => Promise<() => void>;
	/**
	 * 登记好了、有了 id——在它开始排队之前就会叫到。
	 *
	 * 给派它的那一方用：人插话时父会话要放手，放手时得说得出放下的是哪一个（见
	 * `delegation-waits.ts`）。
	 */
	onRegistered?: (id: string) => void;
}

/** 派一个子代理时说的话。`resume` 给了，就是续跑它派出去过的那一个，见 `dispatchSubAgent`。 */
export interface SubAgentRequest {
	description: string;
	prompt: string;
	agentType?: string;
	resume?: string;
	onResumable?: (id: string) => void;
}
