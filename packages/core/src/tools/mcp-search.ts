/**
 * MCP 工具的延迟加载：多了以后不放进工具表，系统提示词里一份目录说有它们，模型要用时 `mcp_search`
 * 拿回完整 schema、`mcp_call` 调用。内置工具一律常驻，为什么见 `docs/architecture/mcp-search.md`。
 *
 * 被延迟的工具仍在这一轮的工具列表里，只是带着 `deferred`（`withhold` 的副本）：权限档、子代理定义、
 * `sessionOnly` 这些按名字筛工具的地方照旧筛它们，筛剩下的才搜得到、调得到。真正发给服务商的工具表
 * 由 `toolTable` 算：没延迟的，加上两个入口（有东西被延迟时）。
 *
 * 为什么不把搜到的工具加进工具表（maka 的做法）：工具表在三条协议的缓存前缀最前面，加一个、轮末撤
 * 一个，整段前缀就重算两次。这里两个入口一个字节不变，目录变化走提示词增量（`prompt/update.ts`），
 * 搜索结果和调用只往历史末尾追加。原生的 `defer_loading` 不用，理由见 `docs/architecture/mcp-search.md`。
 *
 * 代价是参数不再由服务商按 schema 约束，所以调用前按 schema 校验，不合格的连同 schema 退回。审批、
 * 钩子、并行判定不在这里：`agent/tool-run.ts` 先把调用换成真正的工具，再走和别的工具同一条路。
 */

import { coerceArguments } from "../agent/tool-args.ts";
import { toolTokens } from "../tokens.ts";
import type { Tool, ToolResult } from "../types.ts";
import { schemaProblem } from "./tool-schema-check.ts";

export const MCP_SEARCH = "mcp_search";
export const MCP_CALL = "mcp_call";

/**
 * MCP 工具 schema 合计到这么多 token（`toolTokens` 的 3.5 字符估）就延迟加载。
 *
 * 推导（2026-10-11 实测，见 `docs/architecture/mcp-search.md`）：每发现一个工具多一次请求，加上约
 * 960 token 的搜索结果，折合约 3,500 token；常驻 S token 的 schema 在一条请求序列（真实会话平均 25 次
 * 请求、缓存读按一成）里折合约 2.5·S。目录每台服务器约 65 token，三台、发现两次时在 S ≈ 3,400 打平。
 */
export const DEFER_MCP_TOKENS = 3_000;

/** 留在工具表外的那一份。原定义是全进程共用的，不能在它身上记「这个会话没放它」。 */
export function withhold(tool: Tool): Tool {
	return { ...tool, deferred: true };
}

export interface ToolPlanInput {
	tools: readonly Tool[];
	/** 设置里「常驻」的 MCP 服务器。 */
	pinnedServers: ReadonlySet<string>;
	/**
	 * 这个会话的 MCP 工具已经延迟过。切过去就不切回来：阈值附近一台服务器断线重连，来回切一次就是
	 * 两次整段前缀重算，而切回来省下的只是一行目录。
	 */
	mcpDeferred: boolean;
}

export function planTools(input: ToolPlanInput): { tools: Tool[]; mcpDeferred: boolean } {
	const movable = input.tools.filter((tool) => tool.mcp && !input.pinnedServers.has(tool.mcp.server().id));
	const mcpDeferred = input.mcpDeferred || (movable.length > 0 && toolTokens(movable) >= DEFER_MCP_TOKENS);
	const withheld = new Set(mcpDeferred ? movable : []);
	const tools = input.tools.map((tool) => (withheld.has(tool) ? withhold(tool) : tool));
	return { tools, mcpDeferred };
}

/**
 * 真正发给服务商的工具表：没延迟的，加上两个入口。请求、日志里记的上下文、「没有这个工具」的提示
 * 都读它，三处说的是同一份。
 */
export function toolTable(available: readonly Tool[]): Tool[] {
	const shown = available.filter((tool) => !tool.deferred);
	return shown.length === available.length ? [...available] : [...shown, mcpSearchTool, mcpCallTool];
}

/** 目录里的一行：一台 MCP 服务器。 */
export interface CatalogEntry {
	key: string;
	/** 服务器上的原名，按名字排。 */
	tools: string[];
	server: { id: string; name: string; description?: string };
}

export function deferredCatalog(available: readonly Tool[]): CatalogEntry[] {
	const entries = new Map<string, CatalogEntry>();
	for (const tool of available) {
		if (!tool.deferred || !tool.mcp) continue;
		const server = tool.mcp.server();
		const key = `mcp:${server.id}`;
		const entry = entries.get(key) ?? { key, tools: [], server: { id: server.id, name: server.name, description: server.description } };
		entry.tools.push(tool.mcp.tool);
		entries.set(key, entry);
	}
	// 按 id 排：服务器一台台连上，目录的次序不跟着连接先后变。
	return [...entries.values()].map((entry) => ({ ...entry, tools: [...entry.tools].sort() })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/**
 * 搜的是这一次调用所在的那一轮被延迟的工具（`ctx.tools`）：子代理、权限档筛掉的搜不到，服务器连上、
 * 断开之后搜到的是新的那一份。入口自己的描述里不写任何一件工具——写了，它一变工具表就变。
 */
export const mcpSearchTool: Tool = {
	name: MCP_SEARCH,
	description:
		"Find tools of the MCP servers listed under \"MCP tools to search for\" in the system prompt. They are not in your tool list until you search. " +
		"Search by what you need to do (words from the task), a tool name, or a server; each match comes back with its full input schema. " +
		`Then run it with \`${MCP_CALL}\`. Search before calling: tool names and arguments are not guessable.`,
	parameters: {
		type: "object",
		properties: {
			query: { type: "string", description: "What you need to do, or a tool or server name, e.g. \"linear create issue\"." },
			source: { type: "string", description: "Only search one MCP server: its id or name." },
			limit: { type: "integer", description: `How many matches to return, 1–${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`, minimum: 1, maximum: MAX_LIMIT },
		},
		required: ["query"],
	},
	mutating: false,
	executionMode: "parallel",
	summarize: (args) => `Search MCP tools “${String(args.query ?? "")}”`,
	async execute(args, ctx): Promise<ToolResult> {
		const query = typeof args.query === "string" ? args.query : "";
		const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? (args.limit as number) : DEFAULT_LIMIT));
		const pool = (ctx.tools ?? []).filter((tool) => tool.deferred && tool.mcp);
		const source = typeof args.source === "string" && args.source.trim() ? args.source.trim().toLowerCase() : undefined;
		const scoped = source ? pool.filter((tool) => sourceNames(tool).includes(source)) : pool;
		if (source && scoped.length === 0) return failed(`Nothing in the list is called "${args.source}". Entries: ${entryList(pool)}.`);
		const ranked = rank(scoped, query);
		if (ranked.length === 0) {
			return { content: [{ type: "text", text: `No tool matched "${query}". Entries: ${entryList(pool)}. Try other words, or pass "source" to list one entry's tools.` }], uneventful: true };
		}
		const shown = ranked.slice(0, limit);
		const more = ranked.length - shown.length;
		const text = [
			...shown.map(describeTool),
			`Call one with ${MCP_CALL}: {"tool": "<name above>", "arguments": {…matching its input schema}}.${more > 0 ? ` ${more} more matched; add words or pass "source" to narrow.` : ""}`,
		].join("\n\n");
		return { content: [{ type: "text", text }], details: { kind: "mcp-search", matches: shown.map((tool) => tool.name) } };
	},
};

/**
 * 只是个名字：`tool-run.ts` 在计划阶段就用 `routeMcpCall` 把它换成了真正的工具，走不到 `execute`。
 * 留着它是为了别的宿主直接调时也有一句话。
 */
const mcpCallTool: Tool = {
	name: MCP_CALL,
	description: `Run a tool found with \`${MCP_SEARCH}\`. "tool" is the exact name the search returned; "arguments" must match that tool's input schema.`,
	parameters: {
		type: "object",
		properties: {
			tool: { type: "string", description: `Exact tool name from ${MCP_SEARCH}, e.g. "mcp__linear__create_issue".` },
			arguments: { type: "object", description: "Arguments for that tool, matching its input schema.", additionalProperties: true },
		},
		required: ["tool"],
	},
	summarize: (args) => String(args.tool ?? MCP_CALL),
	async execute(): Promise<ToolResult> {
		return failed(`${MCP_CALL} could not be routed. Find the tool with ${MCP_SEARCH} first.`);
	},
};

export type Routed = { tool: Tool; args: Record<string, unknown> } | { error: string };

/**
 * `mcp_call`，或者直接按名字叫一个被延迟的工具：找到它、按 schema 校验参数，交回真正要跑的那个。
 * 别的调用返回 undefined，照常走。`available` 是这一轮的工具列表，被延迟的在内。
 */
export function routeMcpCall(call: { name: string; args: Record<string, unknown> }, available: readonly Tool[]): Routed | undefined {
	const via = call.name === MCP_CALL;
	if (!via) {
		const direct = findTool(available.filter((tool) => tool.deferred), call.name);
		if (direct) return checked(direct, call.args);
		// 像 MCP 名字、又一个都对不上的，告诉它去搜；别的照常报「没有这个工具」。
		return call.name.startsWith("mcp__") && available.some((tool) => tool.mcp && tool.deferred) ? { error: notFound(call.name, available) } : undefined;
	}
	const name = call.args.tool;
	if (typeof name !== "string" || !name.trim()) return { error: `${MCP_CALL} needs "tool" (the exact name ${MCP_SEARCH} returned) and "arguments".` };
	const tool = findTool(available, name.trim());
	if (!tool) return { error: notFound(name, available) };
	let args: unknown = call.args.arguments ?? {};
	if (typeof args === "string") {
		try {
			args = JSON.parse(args);
		} catch {
			// 交给下面那句「必须是对象」。
		}
	}
	return checked(tool, args);
}

function checked(tool: Tool, args: unknown): Routed {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return { error: `"arguments" must be an object matching ${tool.name}'s input schema, so it was not called.\nInput schema: ${JSON.stringify(tool.parameters)}` };
	}
	const coerced = coerceArguments(args as Record<string, unknown>, tool.parameters);
	const problem = schemaProblem(tool.parameters, coerced);
	if (problem) return { error: `${tool.name} was not called: its arguments do not match the input schema (${problem}). Fix them and call again.\nInput schema: ${JSON.stringify(tool.parameters)}` };
	return { tool, args: coerced };
}

/** 搜的只有 MCP 工具（见 `pool`）。 */
function describeTool(tool: Tool): string {
	const mcp = tool.mcp!;
	const flags = tool.mutating === false ? " [read-only]" : "";
	return [`${tool.name} — MCP ${mcp.server().name}: ${mcp.tool}${flags}`, tool.description, `Input schema: ${JSON.stringify(tool.parameters)}`].join("\n");
}

/** `source` 认的名字：服务器的 id 和名字。 */
function sourceNames(tool: Tool): string[] {
	const server = tool.mcp?.server();
	return server ? [server.id.toLowerCase(), server.name.toLowerCase()] : [];
}

function entryList(tools: readonly Tool[]): string {
	const names = [...new Set(tools.flatMap((tool) => tool.mcp?.server().id ?? []))];
	return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * 名字的几种写法都认：完整名（大小写不论）、`服务器__工具`、`服务器.工具`、`服务器/工具`、`服务器:工具`，
 * 以及只在一台服务器上出现的原名。原名撞了几台的不猜，交给 `notFound` 列出来。
 */
function findTool(tools: readonly Tool[], name: string): Tool | undefined {
	const wanted = name.toLowerCase();
	const exact = tools.find((tool) => tool.name === name) ?? tools.find((tool) => tool.name.toLowerCase() === wanted);
	if (exact) return exact;
	const scoped = tools.filter((tool) => {
		if (!tool.mcp) return false;
		const server = tool.mcp.server().id.toLowerCase();
		const raw = tool.mcp.tool.toLowerCase();
		return [`${server}__${raw}`, `${server}.${raw}`, `${server}/${raw}`, `${server}:${raw}`].includes(wanted);
	});
	if (scoped.length === 1) return scoped[0];
	const bare = tools.filter((tool) => tool.mcp?.tool.toLowerCase() === wanted);
	return bare.length === 1 ? bare[0] : undefined;
}

/**
 * 名字里写了服务器（`mcp__linear__make_ticket`）就先在那台里找最接近的：记对了服务器、记错了工具名
 * 是最常见的那种错，全局排会被别的服务器上同名的词抢走（「ticket」排出一串 Zendesk）。
 */
function notFound(name: string, tools: readonly Tool[]): string {
	const [, server, rest] = /^(?:mcp__)?([^_./:]+(?:[-_][^_./:]+)*?)(?:__|[./:])(.+)$/.exec(name) ?? [];
	const scoped = server ? tools.filter((tool) => tool.mcp?.server().id.toLowerCase() === server.toLowerCase()) : [];
	const near = scoped.length > 0 ? rank(scoped, rest!) : rank(tools, name.replace(/^mcp__/, ""));
	// 那台里一个词都对不上，就列出它的几个工具：至少知道这台上有什么。
	const close = (near.length > 0 ? near : scoped).slice(0, scoped.length > 0 ? 5 : 3).map((tool) => tool.name);
	return `No tool named "${name}"${close.length > 0 ? `. Closest: ${close.join(", ")}` : ""}. Use ${MCP_SEARCH} to find the right tool and its input schema, then call it with the exact name.`;
}

const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "with", "from", "by", "my", "me", "i", "it", "is", "be", "at", "as", "into", "new", "mcp", "tool", "tools"]);

/** 小写、拆开驼峰和各种分隔符，再去掉英文复数的 s——「issues」要找得到 `create_issue`。 */
function words(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9㐀-鿿]+/)
		.filter((word) => word.length > 0 && !STOP_WORDS.has(word))
		.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

/**
 * 按工具名、服务器、描述打分：查询里每个词取它在这三处里最好的一次命中。名字最重
 * （说「建 issue」时，`create_issue` 比一段提到 issue 的描述更像要找的那个），来源次之，描述最轻。
 * 前缀也算，打折：「comment」要找得到 `comments`。
 */
function rank(tools: readonly Tool[], query: string): Tool[] {
	const wanted = words(query);
	const whole = query.trim().toLowerCase();
	const scored: { tool: Tool; score: number }[] = [];
	for (const tool of tools) {
		const server = tool.mcp?.server();
		const raw = tool.mcp?.tool ?? tool.name;
		if (whole && (tool.name.toLowerCase() === whole || raw.toLowerCase() === whole)) {
			scored.push({ tool, score: 1_000 });
			continue;
		}
		const fields: [string[], number][] = [
			[words(raw), 4],
			[words(server ? `${server.id} ${server.name}` : ""), 3],
			[words(`${tool.description} ${server?.description ?? ""}`), 1],
		];
		let score = 0;
		for (const word of wanted) {
			let best = 0;
			for (const [field, weight] of fields) {
				for (const candidate of field) {
					if (candidate === word) best = Math.max(best, weight);
					else if (word.length >= 3 && (candidate.startsWith(word) || word.startsWith(candidate))) best = Math.max(best, weight / 2);
				}
			}
			score += best;
		}
		if (score > 0) scored.push({ tool, score });
	}
	return scored.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1)).map((entry) => entry.tool);
}

function failed(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
