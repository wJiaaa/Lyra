/**
 * What a session can do, as opposed to what it has done.
 *
 * Tools, skills, sub-agents and MCP servers are discovered together, replaced together when the
 * settings change, and read together every turn — so they are one object rather than ten fields on
 * the session. It also gives the diagnostics somewhere to live: a skill that failed to parse is
 * part of this answer, not an error to throw away.
 *
 * The scratch state map rides along because its lifetime is the same. It holds the symbol index,
 * the todo list and the skill catalogue — things a tool wrote down for the next tool to read.
 */

import { createHash } from "node:crypto";
import { ExtensionHost } from "../extensions/host.ts";
import { plumeHome } from "../session/store.ts";
import { CODE_INTEL_KEY, CodeIntelManager } from "../lsp/manager.ts";
import { McpManager, type McpServerConfig, type McpServerStatus } from "../mcp/client.ts";
import type { AskPerson } from "../mcp/elicitation.ts";
import { BUILTIN_RESOURCES } from "../resources/handlers.ts";
import { ResourceRouter } from "../resources/router.ts";
import type { Settings } from "../config/settings.ts";
import type { Plugin, PluginDiagnostic } from "../plugins/loader.ts";
import type { Skill, SkillDiagnostic } from "../skills/loader.ts";
import { ARTIFACTS_KEY, MCP_KEY, PLUGINS_KEY, type Artifact, type McpLookup } from "../resources/more-handlers.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { backgroundJobs } from "../tools/background-jobs.ts";
import { invalidateIndex } from "../tools/index.ts";
import { TOOL_NAMES_KEY } from "../tools/reroute.ts";
import { planTools, MCP_CALL, MCP_SEARCH } from "../tools/mcp-search.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import type { AgentEvent } from "../agent/events.ts";
import type { Tool } from "../types.ts";
import { loadCapabilities } from "./session-setup.ts";

/**
 * 最多留多少份折叠内容。
 *
 * 三十份的量级已经远超「模型会回头去看」的范围，而它挡住的是另一件事：一个跑了一天、
 * 搜了几百次的会话，把每一次的完整输出都留在内存里。
 */
const MAX_ARTIFACTS = 30;

/** 一轮开始前最多等还在第一次连的 MCP 服务器多久。见 `SessionCapabilities.mcpReady`。 */
const MCP_START_GRACE_MS = 5_000;

export interface SessionCapabilitiesOptions {
	/** MCP 服务器要人填表时怎么问到人；没有人可问的宿主不给。见 `mcp/elicitation.ts`。 */
	ask?: AskPerson;
	/** 一台 MCP 服务器在后台连不上、或者重连放弃了。会话据此在对话里说一声。 */
	onMcpFailure?: (status: McpServerStatus) => void;
	/**
	 * `load` 等 MCP 服务器多久。不给就等到每台都有结果（测试、只要答案的宿主）；会话给 0，
	 * 让慢的在后台连，第一轮开始前再等一小会儿（`mcpReady`）。
	 */
	mcpWait?: number;
}

export class SessionCapabilities {
	tools: Tool[] = [];
	skills: Skill[] = [];
	skillDiagnostics: SkillDiagnostic[] = [];
	plugins: Plugin[] = [];
	pluginDiagnostics: PluginDiagnostic[] = [];
	agents: AgentDefinition[] = [...BUILTIN_AGENTS];
	/**
	 * 这次加载实际读过的目录。
	 *
	 * 热重载监听的就是这份名单——不是「所有可能放技能的地方」，而是「这台机器上真的放了东西
	 * 的地方」。前者是几十个 watcher，其中大多数指向不存在的目录。
	 */
	watched: string[] = [];
	/**
	 * The session's address space: `skill://`, `scratch://`, `plume://`.
	 *
	 * One per session, never a module singleton. A sub-agent has its own skill set, and a shared
	 * router would resolve `skill://x` against whichever session touched it last — a bug that only
	 * shows up under concurrency and looks like a skill occasionally holding someone else's text.
	 */
	readonly resources = buildRouter();

	/**
	 * Third-party extensions, each in its own worker.
	 *
	 * Session-scoped like everything else here, and disposed with the session — a worker left
	 * running is a thread nobody owns. Empty until `load` finds extension directories, so a session
	 * with none pays nothing.
	 */
	readonly extensions = new ExtensionHost();

	/**
	 * 被剪枝折叠掉的大块输出，按 id 存着，`artifact://` 从这里取。
	 *
	 * 跟会话一起活在内存里，也跟会话一起消失。落盘是另一个决定：那些内容动辄几十万字符，
	 * 而它们的用处几乎全部集中在产生它的那一个回合之后的几分钟里。
	 */
	readonly artifacts = new Map<string, Artifact>();

	/** Shared scratch space for tools that need to remember something across calls. */
	readonly state = new Map<string, unknown>();
	readonly mcp: McpManager;

	/**
	 * Tools that only exist on a particular host — the desktop app contributes browser automation
	 * backed by a real BrowserWindow, which the platform-agnostic core cannot build.
	 *
	 * Assigned in the body rather than declared as a parameter property: Node's type stripping
	 * runs the source as-is and cannot rewrite one into a field.
	 */
	private readonly extraTools: Tool[];

	/** 内置的和宿主给的工具；`tools` 是它们加上此刻 MCP 服务器提供的那些。 */
	private baseTools: Tool[] = [];
	/** 此刻全部的 MCP 工具。 */
	private mcpTools: Tool[] = [];
	/** MCP 工具延迟过没有：切过去就不切回来，见 `ToolPlanInput.mcpDeferred`。 */
	private mcpDeferred = false;
	/** 常驻的服务器：延迟加载时它们的工具照样放进工具表。 */
	private pinnedMcp = new Set<string>();
	private rerouting = true;
	private readonly options: SessionCapabilitiesOptions;
	/** 已经报过的 MCP 失败，同一台服务器同一个原因只报一次。 */
	private readonly reported = new Set<string>();

	constructor(extraTools: Tool[] = [], options: SessionCapabilitiesOptions = {}) {
		this.extraTools = extraTools;
		this.options = options;
		this.mcp = new McpManager({ ask: options.ask, onChange: (status) => this.mcpChanged(status) });
	}

	/** 每台 MCP 服务器此刻的状态：连上、连接中、重连中、失败的原因。 */
	get mcpStatuses(): McpServerStatus[] {
		return this.mcp.statuses();
	}

	/**
	 * 一台 MCP 服务器在后台连上、断开、重连、放弃，或者改了工具表。
	 *
	 * 工具表当场重算，但不会塞进正在跑的那一轮：一轮的工具表在组装时取定（`session-turn.ts`），
	 * 系统提示和记下来的上下文都按它写。新的那份从下一轮起生效。
	 *
	 * 为什么不像换模型那样从下一个请求起就换（ADR-0025）：换模型是为了躲开一个坏掉的上游，晚一个
	 * 请求都是在烧钱；工具表变了没有这种急迫——缓存前缀反正要因它失效一次，早一轮晚一轮花的是同一笔。
	 * 而且断线重连回来、工具表一字未变的（最常见的那种），前缀根本不动：重算出来的是同一份。
	 */
	private mcpChanged(status: McpServerStatus): void {
		this.composeTools();
		if (status.state !== "failed" || status.missing) return;
		const key = `${status.id}\0${status.error ?? ""}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		this.options.onMcpFailure?.(status);
	}

	/**
	 * `tools` 里被延迟的是带 `deferred` 的副本（`tools/mcp-search.ts`）：它们照样经过权限档、子代理定义
	 * 的筛选，只是不进发给服务商的工具表。
	 */
	private composeTools(): void {
		this.mcpTools = this.mcp.allTools(new Set([...this.baseTools.map((tool) => tool.name), MCP_SEARCH, MCP_CALL]));
		const plan = planTools({ tools: [...this.baseTools, ...this.mcpTools], pinnedServers: this.pinnedMcp, mcpDeferred: this.mcpDeferred });
		this.mcpDeferred = plan.mcpDeferred;
		this.tools = plan.tools;
		/*
		 * `bash` 的改道靠这个 key 知道「建议的工具在不在」。
		 *
		 * 开关关了就不填——`rerouteShellCommand` 见到 undefined 一律放行。用「不填」而不是
		 * 「填个空集」：空集会让每条 `cat` 都去查一次表然后放行，而不填是一次 map miss。
		 */
		if (this.rerouting) this.state.set(TOOL_NAMES_KEY, new Set(this.tools.map((tool) => tool.name)));
		else this.state.delete(TOOL_NAMES_KEY);
	}

	/**
	 * 设置里哪几台服务器「常驻」。在设置页拨了开关，开着的会话从下一轮起照新的来：工具表在
	 * 每轮组装时才读（`session-turn.ts`），这里只是把它算好。
	 */
	pinMcp(settings: Settings): void {
		this.pinnedMcp = new Set(settings.mcpServers.filter((server) => server.pinned === true).map((server) => server.id));
		this.composeTools();
	}

	/** 来自 MCP 服务器的工具名。上下文面板据此把工具 schema 分成内置和 MCP 两段。 */
	mcpToolNames(): Set<string> {
		return new Set(this.mcpTools.map((tool) => tool.name));
	}

	/**
	 * 一轮开始前，等还在第一次连的 MCP 服务器一小会儿（`MCP_START_GRACE_MS`）。
	 *
	 * 会话打开时不等它们：一台要冷启动三分钟的服务器不该让窗口跟着卡三分钟。第一句话发出去时多半
	 * 都已经连上了（30 台本地服务器实测几百毫秒）；还没连上的不再等，连上以后从下一轮起可用。
	 */
	async mcpReady(graceMs = MCP_START_GRACE_MS): Promise<void> {
		await this.mcp.settled(graceMs);
	}

	/** Discover everything again. Safe to call after the settings change. */
	async load(cwd: string, settings: Settings): Promise<void> {
		const loaded = await loadCapabilities(cwd, settings, this.mcp, this.extraTools, this.options.mcpWait);
		this.plugins = loaded.plugins;
		this.pluginDiagnostics = loaded.pluginDiagnostics;
		this.skills = loaded.skills;
		this.skillDiagnostics = loaded.skillDiagnostics;
		this.agents = loaded.agents;
		this.baseTools = loaded.tools;
		this.rerouting = settings.rerouteShellCommands !== false;
		this.pinMcp(settings);
		/*
		 * Extensions load after everything else, because they can only affect what already exists.
		 *
		 * Failures here are diagnostics rather than exceptions: a broken extension must not stop a
		 * session from starting, which is the same reason a broken skill does not.
		 */
		// Replaced, not added to: a reload that loaded them again left the previous workers running.
		await this.extensions.replaceAll(await extensionDirs(cwd));
		// Two tools read these back rather than taking them as arguments.
		this.state.set(SKILLS_KEY, this.skills);
		this.state.set(AGENTS_KEY, this.agents);
		this.state.set(ARTIFACTS_KEY, this.artifacts);
		/*
		 * `plugin://` 和 `mcp://` 的数据源。
		 *
		 * 放进 state 而不是交给路由：路由每个会话建一次，而这两样每次 `load` 都会变——
		 * 装了一个插件、开了一台服务器之后，地址该指向新的那份。
		 */
		this.state.set(PLUGINS_KEY, this.plugins);
		this.state.set(MCP_KEY, {
			resources: () => this.mcp.allResources(),
			read: (server: string, uri: string) => this.mcp.readResource(server, uri),
		} satisfies McpLookup);
		this.watched = loaded.watched;
	}

	/**
	 * 剪枝往这里存原文，换回一个 `artifact://` 地址。
	 *
	 * 地址按内容取，同一段原文每次都换回同一个地址：发送路径每次从日志重建视图（重启之后也是），
	 * 占位标记里的地址要是换了，发给模型的前缀就从那里断开。重复存同一份只是把它挪到最新。
	 *
	 * 有上限：折叠下来的东西每一份都是几十万字符，一个跑了一天的会话能攒出几百兆。超过之后
	 * 丢最旧的——最近折叠的那几份才是模型可能回头去看的，而一天前那次搜索的完整输出，
	 * 它早就不记得自己搜过了。
	 */
	keepArtifact(tool: string, content: string): string {
		const id = `a${createHash("sha256").update(tool).update("\0").update(content).digest("hex").slice(0, 12)}`;
		this.artifacts.delete(id);
		this.artifacts.set(id, { id, tool, content, at: Date.now() });
		while (this.artifacts.size > MAX_ARTIFACTS) {
			const oldest = this.artifacts.keys().next().value;
			if (oldest === undefined) break;
			this.artifacts.delete(oldest);
		}
		return `artifact://${id}`;
	}

	/** Drop the cached symbol index so the next lookup re-reads it from disk. */
	invalidateSymbolIndex(): void {
		invalidateIndex(this.state);
	}

	/**
	 * Stop this session's connections to the servers `match` picks, and take their tools with them.
	 *
	 * The host calls it before an MCP bundle's files are replaced or removed — see
	 * `McpManager.disconnect`. Without the second half the model would go on being offered tools whose
	 * server is gone, each call failing as not connected.
	 */
	async disconnectMcp(match: (server: McpServerConfig) => boolean): Promise<number> {
		const closed = await this.mcp.disconnect(match);
		this.composeTools();
		return closed.length;
	}

	async dispose(): Promise<void> {
		try { backgroundJobs(this.state).dispose(); }
		finally {
			// A process kill failure must not skip unrelated session resources.
			await this.mcp.dispose();
			await this.extensions.dispose().catch(() => {});
			/*
			 * Language servers are hundreds of megabytes each and outlive the session that started them
			 * unless something kills them. The manager is created lazily by the `lsp` tool and parked in
			 * this state map, so this is the only place that knows whether there is one to stop.
			 */
			const codeIntel = this.state.get(CODE_INTEL_KEY);
			if (codeIntel instanceof CodeIntelManager) await codeIntel.dispose().catch(() => {});
		}
	}
}

/**
 * 一台 MCP 服务器连不上时，对话里的那一句。stderr 只带一行，全文在设置页：最后一行有字的、又不是
 * 调用栈的那行——Node、Python 崩溃时最后几行是 `at …` / `File "…", line …`，原因在它们上面。
 */
export function mcpFailureNotice(status: McpServerStatus): AgentEvent {
	const last = status.stderr?.split("\n").findLast((line) => line.trim() && !/^\s+(at |File ")/.test(line));
	const error = `${status.error ?? "unknown error"}${last ? ` — ${last.trim()}` : ""}`;
	return { type: "notice", level: "warn", message: `MCP 服务器「${status.name}」没有连上：${error}`, code: "mcp-failed", params: { server: status.name, error } };
}

/**
 * A router with the shipped schemes on it — all of them, or only those named.
 *
 * Named for a delegated run, which builds its own: a scheme it has no data for would be advertised
 * in its prompt and fail when used.
 */
export function buildRouter(schemes?: readonly string[]): ResourceRouter {
	const router = new ResourceRouter();
	for (const handler of BUILTIN_RESOURCES) if (!schemes || schemes.includes(handler.scheme)) router.register(handler);
	return router;
}

/**
 * Where extensions live: `<cwd>/.plume/extensions/*` and `~/.plume/extensions/*`.
 *
 * One directory per extension, each with its own `extension.json`. Missing directories are the
 * normal case and are not reported — most projects have none.
 */
export async function extensionDirs(cwd: string): Promise<string[]> {
	const { readdir } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const roots = [join(cwd, ".plume", "extensions"), join(plumeHome(), "extensions")];
	const found: string[] = [];
	for (const root of roots) {
		const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) if (entry.isDirectory()) found.push(join(root, entry.name));
	}
	return found;
}
