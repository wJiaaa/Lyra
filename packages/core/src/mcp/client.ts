/**
 * MCP integration.
 *
 * Each configured server is connected over stdio or streamable HTTP and every tool is exposed to the
 * agent under a `mcp__<server>__<tool>` name (`names.ts`). Each server lives in its own slot with
 * its own state — connecting, connected, reconnecting, failed — so one that is slow, broken or
 * gone never holds up another, or the session.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { commandEnv } from "../sandbox/login-path.ts";
import type { McpPromptEntry } from "../commands/mcp-prompt.ts";
import type { Tool, UserContent } from "../types.ts";
import { elicitationCapability, ElicitationQueue, handleElicitation, type AskPerson } from "./elicitation.ts";
import { dedupeToolNames, qualifiedToolName } from "./names.ts";
import { BackgroundOAuthProvider, McpNeedsLogin, usesOAuth } from "./oauth.ts";
import { McpMissingValues, resolveServer } from "./placeholders.ts";
import { listPrompts, promptContent } from "./prompts.ts";
import { TreeKillingStdioTransport } from "./stdio.ts";
import { toAgentTool, type McpToolHandle, type RawMcpTool } from "./tool.ts";
import type { McpOrigin, McpServerConfig } from "./types.ts";

/*
 * The shapes of a server's configuration live in `types.ts`, apart from the client that starts them,
 * so the placeholder rules (`placeholders.ts`) can read them without importing the client that
 * imports those rules.
 */
export type { McpHttpServer, McpOrigin, McpServerConfig, McpStdioServer } from "./types.ts";
export { qualifiedToolName } from "./names.ts";

export interface McpServerStatus {
	id: string;
	name: string;
	origin?: McpOrigin;
	/**
	 * `connecting`：第一次连，还没有结果。`reconnecting`：连上过、断了，正在按退避重连——工具还留在
	 * 工具表里。`needs-login`：远程服务器要 OAuth 登录，后台连接走不下去了。
	 */
	state: "connecting" | "connected" | "reconnecting" | "failed" | "disabled" | "needs-login";
	/** 连上了，而且用的是 OAuth 登录来的令牌——设置页据此给「退出登录」。 */
	signedIn?: boolean;
	toolCount: number;
	error?: string;
	/** stdio 服务器 stderr 的最后几行：起不来、半路崩掉时，原因多半写在这里。 */
	stderr?: string;
	/** 重连到第几次（`reconnecting`，以及重连放弃后的 `failed`）。 */
	attempt?: number;
	/** 没启动，是因为这几个值还没填——界面据此画「去填」，而不是一段报错。 */
	missing?: string[];
	tools: { name: string; description: string }[];
	/** 它提供的 prompt，给 `/` 菜单。没连上、或服务器不提供的，没有这一项。 */
	prompts?: McpPromptEntry[];
}

export interface McpConnection {
	config: McpServerConfig;
	client: Client;
	/** 服务器说列表变了（`notifications/prompts/list_changed`）就换成新的一份。 */
	prompts: McpPromptEntry[];
	/** 用的是 OAuth 登录来的令牌。 */
	signedIn: boolean;
	close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long the first start of a server launched through a package runner may take.
 *
 * `npx -y pkg@latest` and `uvx pkg@latest` download the package — and for a Python server its whole
 * dependency tree — the first time they are run on a machine. Measured cold: markitdown 131s,
 * mongodb 106s, grafana 60s, the first Python server about a minute. Against a 30s deadline every
 * one of those failed the first time it was switched on and worked the second, which reads as
 * "this server is broken" rather than "it was downloading". Once one start has succeeded in this
 * process the package is cached and the ordinary deadline applies again.
 */
const FIRST_RUN_TIMEOUT_MS = 180_000;
const PACKAGE_RUNNERS = new Set(["npx", "uvx", "bunx", "pnpx", "uv", "pnpm", "yarn", "pipx"]);
/** Servers that have started once in this process, by what starts them. */
const warmed = new Set<string>();

function startKey(server: McpServerConfig): string | null {
	if (server.transport !== "stdio") return null;
	const runner = server.command.split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, "") ?? "";
	return PACKAGE_RUNNERS.has(runner) ? JSON.stringify([server.command, ...(server.args ?? [])]) : null;
}

/** 一次工具调用多久没回复、也没进度就算超时：五分钟。见 `tool.ts`。 */
const CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * 断线重连的节奏：0.5s 起翻倍，封顶 30s，最多 8 次（合计约一分半），够一台远程服务器重启、
 * 一次短暂断网。连上之后稳定 30s 才把计数清零——否则一台每次调用都崩的服务器会「重连成功、
 * 再崩、再重连」永远转下去。参数照 deepseek-harness 的 `mcp-client`。
 */
const RECONNECT = { baseMs: 500, maxMs: 30_000, attempts: 8, stableMs: 30_000 };
/** 一次工具调用碰上服务器正在重连时，最多等它多久。 */
const RECONNECT_WAIT_MS = 15_000;
/** 一台服务器的 `nextCursor` 永远不为空时，翻到这么多页就当它坏了。和 prompt 一样。 */
const MAX_PAGES = 50;
/** 服务器常常一口气发好几个 list_changed（每加一个工具一个），合成一次重列。 */
const LIST_CHANGED_DEBOUNCE_MS = 300;

export interface McpManagerOptions {
	/** How long connecting, and then listing tools, may each take. Tests shorten it. */
	timeoutMs?: number;
	/** 一次工具调用没有回复也没有进度时等多久。测试缩短它。 */
	callTimeoutMs?: number;
	/** 断线重连的节奏。测试缩短它。 */
	reconnect?: Partial<typeof RECONNECT>;
	/**
	 * 服务器中途要人填表时怎么问到人。给了才声明 elicitation 能力；不给的（命令行、设置页临时连的
	 * 那一下）不声明，服务器硬发来就回 decline。见 `elicitation.ts`。
	 */
	ask?: AskPerson;
	/**
	 * 后台有了变化——连上了、断了、重连上了、放弃了、工具表变了——就叫一声。会话据此重算工具表，
	 * 新的那份从下一轮起生效（见 `SessionCapabilities`）。
	 */
	onChange?: (status: McpServerStatus) => void;
}

export class McpManager {
	private slots = new Map<string, Slot>();
	/** 最近一次 `connectAll` 给的名单：关着的服务器也要出现在状态里。 */
	private declared: McpServerConfig[] = [];
	readonly timeoutMs: number;
	readonly callTimeoutMs: number;
	readonly reconnectPolicy: typeof RECONNECT;
	private readonly ask: AskPerson | undefined;
	private readonly onChange: ((status: McpServerStatus) => void) | undefined;
	private readonly elicitations = new ElicitationQueue();
	/**
	 * Bumped by every `closeAll`, so a replacement that was already under way when it ran can tell
	 * that it must not start anything.
	 */
	private epoch = 0;
	private disposed = false;
	/** The replacement in progress; the next one starts after it. See `connectAll`. */
	private replacing: Promise<unknown> = Promise.resolve();

	constructor(options: McpManagerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
		this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
		this.reconnectPolicy = { ...RECONNECT, ...options.reconnect };
		this.ask = options.ask;
		this.onChange = options.onChange;
	}

	/**
	 * Replace every connection with ones to `servers`.
	 *
	 * Every server connects on its own, in parallel, under its own deadline. `wait` is how long to wait
	 * for them before answering: by default until each has a result — the settings page's probe and
	 * the command line want that — while a session passes 0 and lets the slow ones finish in the
	 * background (`settled` is where its first turn waits a little).
	 *
	 * One replacement at a time. Three things reload a session's capabilities — the file watcher,
	 * the end of a turn releasing a change it held back, and the desktop app saving an agent
	 * definition — and nothing kept them apart. Two replacements running together each closed what
	 * was there when they started and then both connected; the second to finish overwrote the
	 * first's connection in the map without closing it, and that server ran until the app quit.
	 */
	connectAll(servers: McpServerConfig[], options: { wait?: number } = {}): Promise<McpServerStatus[]> {
		const run = this.replacing.then(() => this.replaceAll(servers, options.wait ?? Number.POSITIVE_INFINITY));
		this.replacing = run.catch(() => {});
		return run;
	}

	private async replaceAll(servers: McpServerConfig[], wait: number): Promise<McpServerStatus[]> {
		// A reload that was queued behind the one running when the session was disposed.
		if (this.disposed) return [];
		this.declared = servers;
		/*
		 * 配置没变、连接还活着（或者正在连）的原样留下。重载多半是改了一条技能（见
		 * `AgentSession.reloadCapabilities`），跟 MCP 无关；每次都关掉重启，等于让每台服务器为一个
		 * markdown 文件冷启动一遍。改了启动配置、关过再开、失败了、正在重连的，都立刻重来——这也是
		 * 想手动重连一台服务器时的办法。
		 */
		const wanted = new Map(servers.filter((server) => server.enabled).map((server) => [server.id, server]));
		const closing: Slot[] = [];
		for (const [id, slot] of this.slots) {
			const next = wanted.get(id);
			if (next && sameLaunch(slot.declared, next) && (slot.state === "connected" || slot.state === "connecting")) {
				// 名字、信任开关这类不影响进程的改动，换上新的就行，不必重启。
				slot.declared = next;
				continue;
			}
			closing.push(slot);
			this.slots.delete(id);
		}
		const epoch = this.epoch;
		await Promise.all(closing.map((slot) => slot.close()));
		const mine = new Map<string, Slot>();
		for (const server of wanted.values()) {
			const slot = this.slots.get(server.id) ?? (this.disposed || epoch !== this.epoch ? undefined : this.start(server));
			if (slot) mine.set(server.id, slot);
		}
		await this.settled(wait, [...mine.values()]);
		return servers.map((server) => {
			if (!server.enabled) return disabledStatus(server);
			const slot = mine.get(server.id);
			return slot ? this.statusOf(slot) : { ...disabledStatus(server), state: "failed", error: `MCP server "${server.name}" was disconnected while it was still starting` };
		});
	}

	/**
	 * Connect one server and wait for the answer; throws what stopped it.
	 *
	 * The low-level step under `connectAll`, also used directly where one server is all there is.
	 */
	async connect(declared: McpServerConfig): Promise<McpConnection> {
		if (this.disposed) throw new Error(`MCP server "${declared.name}" was not started: its session has been closed`);
		const previous = this.slots.get(declared.id);
		if (previous) {
			this.slots.delete(declared.id);
			await previous.close();
		}
		const slot = this.start(declared);
		await slot.settle(Number.POSITIVE_INFINITY);
		if (slot.state === "connected" && slot.connection) return slot.connection;
		throw slot.failure ?? new Error(slot.error ?? `MCP server "${declared.name}" did not connect`);
	}

	/**
	 * 等还在第一次连的服务器，每台最多等到它开始连之后 `graceMs` 为止。
	 *
	 * 会话在每一轮开始前调它：刚打开的会话里，大多数服务器几百毫秒就连上了，第一句话应该用得上
	 * 它们；而一台要冷启动三分钟的服务器不该让人对着「发送中」干等三分钟——它连上以后从下一轮起
	 * 加入工具表。已经连过、正在重连的不等：它们的工具还在表里，调用时自己会等一会儿。
	 */
	async settled(graceMs = Number.POSITIVE_INFINITY, slots: Slot[] = [...this.slots.values()]): Promise<void> {
		await Promise.all(slots.map((slot) => slot.settle(slot.startedAt + graceMs)));
	}

	/** 手动重连一台：关掉、计数清零、立刻重新连。设置页的「重新连接」。 */
	reconnect(serverId: string): Promise<void> {
		const run = this.replacing.then(async () => {
			const slot = this.slots.get(serverId);
			if (!slot || this.disposed) return;
			this.slots.delete(serverId);
			await slot.close();
			if (!this.disposed) this.start(slot.declared);
		});
		this.replacing = run.catch(() => {});
		return run;
	}

	private start(declared: McpServerConfig): Slot {
		const slot = new Slot(this, declared);
		this.slots.set(declared.id, slot);
		slot.begin();
		return slot;
	}

	/** 一台服务器的状态变了。`closeAll` 以后不再报：会话已经不在听了。 */
	changed(slot: Slot): void {
		if (this.disposed || this.slots.get(slot.declared.id) !== slot) return;
		this.onChange?.(this.statusOf(slot));
	}

	/**
	 * One attempt at a connection: start the process or open the transport, initialize, list.
	 *
	 * Every way out of here that does not hand the connection over closes it.
	 */
	async open(slot: Slot): Promise<{ connection: McpConnection; listed: RawMcpTool[] }> {
		const declared = slot.declared;
		/*
		 * 空位先填上，缺值就不启动——见 `mcp/placeholders.ts`。取值的环境和启动用的是同一份（登录
		 * shell 的），所以「我在 .zshrc 里 export 过」的人不用再填一遍。
		 */
		const server = resolveServer(declared, commandEnv(process.env));
		let connection: McpConnection | undefined;
		const client = new Client(
			{ name: "plume", version: "0.1.0" },
			{
				capabilities: this.ask ? elicitationCapability : {},
				/*
				 * 列表变了就自己重列（翻页的那种列法），不用 SDK 自带的自动刷新：它只取第一页。
				 *
				 * 工具表的新版本不是当场换给模型：它在提示缓存前缀的最前面，改了整个前缀重算；而一轮里的
				 * 系统提示、记下来的上下文都是按这一轮开始时的工具表写的。会话在下一轮组装时读到新的那份
				 * ——见 `SessionCapabilities` 的 `onChange`。
				 */
				listChanged: {
					tools: {
						autoRefresh: false,
						debounceMs: LIST_CHANGED_DEBOUNCE_MS,
						onChanged: () => {
							if (connection && slot.connection === connection) void slot.refreshTools();
						},
					},
					prompts: {
						autoRefresh: false,
						onChanged: () => {
							void listPrompts(client, declared, this.timeoutMs)
								.then((prompts) => {
									if (connection) connection.prompts = prompts;
								})
								.catch(() => {});
						},
					},
				},
			},
		);
		handleElicitation(client, declared, this.ask, this.elicitations);
		// 远程服务器、没自己配 Authorization 的，挂上 OAuth：用不上的话（服务器不回 401）它一次也不会被调用。
		const oauth = usesOAuth(server) ? await BackgroundOAuthProvider.for(server) : undefined;
		const authOptions = oauth ? { authProvider: oauth, fetch: oauth.fetch } : {};
		const transport =
			server.transport === "stdio"
				? new TreeKillingStdioTransport(server)
				: server.transport === "sse"
					? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers }, ...authOptions })
					: new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers }, ...authOptions });
		slot.stderrOf = transport instanceof TreeKillingStdioTransport ? () => transport.stderrTail() : undefined;

		/*
		 * A server that never answers must not hold anything up, so there is a deadline — but giving
		 * up on a promise does not stop the process behind it. The SDK's own request timeout was 60s
		 * against our 30s, and a server answering in between finished connecting a client nobody
		 * held; one that connected and then failed `tools/list` was dropped the same way. Both kept
		 * running until the app quit.
		 *
		 * The SDK is handed the same timeout so it gives up on its request when we do. Ours stays as
		 * well: it also covers what the SDK does not time — an SSE stream that opens and never sends
		 * its endpoint, the `initialized` notification over HTTP.
		 */
		const cold = startKey(declared);
		const deadline = cold && !warmed.has(cold) ? Math.max(this.timeoutMs, FIRST_RUN_TIMEOUT_MS) : this.timeoutMs;
		let listed: RawMcpTool[];
		let prompts: McpPromptEntry[];
		try {
			await withTimeout(client.connect(transport, { timeout: deadline }), deadline, `Connecting to MCP server "${server.name}"`);
			listed = await withTimeout(listAllTools(client, this.timeoutMs), this.timeoutMs, `Listing tools of "${server.name}"`);
			// 列不出 prompt 不算连接失败：工具照样能用，菜单里少几条而已。
			prompts = await withTimeout(listPrompts(client, declared, this.timeoutMs), this.timeoutMs, `Listing prompts of "${server.name}"`).catch(() => []);
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
		if (cold) warmed.add(cold);
		connection = {
			// 记声明本身，不记填好的那份：密钥只在启动那一刻用，不跟着连接到处传。
			config: declared,
			client,
			prompts,
			signedIn: Boolean(oauth && (await oauth.tokens())),
			close: async () => {
				await client.close().catch(() => {});
			},
		};
		return { connection, listed };
	}

	/**
	 * Every tool from every server that has (or, while it reconnects, had) a connection, ready to hand
	 * to the agent loop.
	 *
	 * 按名字排序，不按连接完成的先后：工具表在提示缓存前缀的最前面，服务器谁先连上每次都可能不同，
	 * 顺序一变整个前缀就失效。名字以 `mcp__<服务器>__` 开头，所以这也是按服务器、再按工具排。
	 *
	 * `reserved` 是宿主已经占用的名字：撞上的 MCP 工具换成带哈希的名字，不覆盖、也不被覆盖。
	 */
	allTools(reserved: ReadonlySet<string> = new Set()): Tool[] {
		return this.named(reserved)
			.map(({ slot, raw, name }) => slot.tool(raw, name))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	private named(reserved: ReadonlySet<string> = new Set()): { slot: Slot; raw: RawMcpTool; name: string }[] {
		const entries = [...this.slots.values()]
			.filter((slot) => slot.offersTools())
			.flatMap((slot) => slot.listed.map((raw) => ({ slot, raw, serverId: slot.declared.id, toolName: raw.name, name: qualifiedToolName(slot.declared.id, raw.name) })));
		const names = dedupeToolNames(entries, reserved);
		return entries.map((entry, index) => ({ slot: entry.slot, raw: entry.raw, name: names[index]! }));
	}

	private connected(): McpConnection[] {
		return [...this.slots.values()].flatMap((slot) => (slot.state === "connected" && slot.connection ? [slot.connection] : []));
	}

	/** 每台连着的服务器提供的 prompt，给 `/` 菜单。按名字排，和工具一样不随连接先后变。 */
	allPrompts(): McpPromptEntry[] {
		return this.connected()
			.flatMap((c) => c.prompts)
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	/**
	 * 取一个 prompt 展开后的内容，作为一条用户输入发出去。
	 *
	 * 参数在这之前已经对过（`bindPromptArguments`），这里不再猜；服务器嫌参数不对会回错误，原样抛给
	 * 调用的人——那是能据以改正的一句话。
	 */
	async getPrompt(name: string, args: Record<string, string>): Promise<UserContent[]> {
		const wanted = name.toLowerCase();
		for (const connection of this.connected()) {
			const entry = connection.prompts.find((prompt) => prompt.name.toLowerCase() === wanted);
			if (!entry) continue;
			const result = await connection.client.getPrompt({ name: entry.prompt, arguments: args }, { timeout: this.timeoutMs });
			const content = promptContent(result.messages);
			if (content.length === 0) throw new Error(`MCP prompt "${entry.prompt}" 没有返回任何内容。`);
			return content;
		}
		throw new Error(`没有连着的 MCP 服务器提供 "${name}"。`);
	}

	/**
	 * 每台服务器声明的资源，给 `mcp://`。
	 *
	 * 一台服务器不支持 resources 是**正常**的（协议里它是可选的），所以拿不到就当没有：
	 * 一台服务器把整个列表变成错误，会让另外三台的资源也跟着不可见。每次现列，不缓存——
	 * 所以 `resources/list_changed` 不需要做任何事。
	 */
	async allResources(): Promise<{ server: string; uri: string; name?: string; description?: string }[]> {
		const perServer = await Promise.all(
			this.connected().map(async (connection) => {
				const listed = await withTimeout(connection.client.listResources(), this.timeoutMs, `Listing resources of "${connection.config.name}"`).catch(() => null);
				return (listed?.resources ?? []).map((resource) => ({
					server: connection.config.id,
					uri: String(resource.uri),
					name: typeof resource.name === "string" ? resource.name : undefined,
					description: typeof resource.description === "string" ? resource.description : undefined,
				}));
			}),
		);
		return perServer.flat();
	}

	/**
	 * 读一个资源。
	 *
	 * 一个资源可以有多段内容（协议允许），拼起来给模型——挑第一段会静默丢掉后面的，
	 * 而「只读到了一部分」是这里最难被发现的一种错。二进制段跳过：它进不了文本上下文，
	 * 而把 base64 塞进去只会烧掉一屏 token。
	 */
	async readResource(serverId: string, uri: string): Promise<string> {
		const connection = this.connected().find((one) => one.config.id === serverId);
		if (!connection) throw new Error(`没有连着叫 "${serverId}" 的 MCP 服务器。`);

		const result = await withTimeout(connection.client.readResource({ uri }), this.timeoutMs, `Reading ${uri}`);
		const parts = (result.contents ?? [])
			.map((part) => (typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : null))
			.filter((text): text is string => text !== null);

		if (parts.length === 0) throw new Error(`${uri} 没有可读的文本内容（可能是二进制资源）。`);
		return parts.join("\n\n");
	}

	/** Every configured server's state, in the order they were configured. */
	statuses(): McpServerStatus[] {
		const out: McpServerStatus[] = [];
		const seen = new Set<string>();
		for (const server of this.declared) {
			seen.add(server.id);
			const slot = this.slots.get(server.id);
			if (slot) out.push(this.statusOf(slot));
			else if (!server.enabled) out.push(disabledStatus(server));
		}
		for (const slot of this.slots.values()) if (!seen.has(slot.declared.id)) out.push(this.statusOf(slot));
		return out;
	}

	private statusOf(slot: Slot): McpServerStatus {
		const server = slot.declared;
		const tools = slot.offersTools()
			? this.named()
					.filter((entry) => entry.slot === slot)
					.map(({ raw, name }) => ({ name, description: raw.description ?? raw.name }))
			: [];
		const connection = slot.state === "connected" ? slot.connection : undefined;
		return {
			id: server.id,
			name: server.name,
			origin: server.origin,
			state: slot.state,
			toolCount: tools.length,
			tools,
			...(connection ? { prompts: connection.prompts } : {}),
			...(connection?.signedIn ? { signedIn: true } : {}),
			...(slot.error && slot.state !== "connected" ? { error: slot.error } : {}),
			...(slot.stderr && slot.state !== "connected" ? { stderr: slot.stderr } : {}),
			...(slot.attempt > 0 && slot.state !== "connected" ? { attempt: slot.attempt } : {}),
			...(slot.missing ? { missing: slot.missing } : {}),
		};
	}

	async closeAll(): Promise<void> {
		this.epoch += 1;
		const open = [...this.slots.values()];
		this.slots = new Map();
		await Promise.all(open.map((slot) => slot.close()));
	}

	/**
	 * Close the connections to the servers `match` picks, and forget them.
	 *
	 * For when their files are about to change — an MCP bundle being updated or uninstalled. On
	 * Windows a running server holds its own executable and modules open, and nothing in its
	 * directory can be moved or deleted until it stops. Queued behind a replacement in progress, so a
	 * server that replacement is still connecting is closed as well, not registered a moment after
	 * this returned.
	 */
	disconnect(match: (server: McpServerConfig) => boolean): Promise<McpConnection[]> {
		const run = this.replacing.then(async () => {
			const closing = [...this.slots.values()].filter((slot) => match(slot.declared));
			for (const slot of closing) this.slots.delete(slot.declared.id);
			this.declared = this.declared.filter((server) => !match(server));
			await Promise.all(closing.map((slot) => slot.close()));
			return closing.flatMap((slot) => (slot.connection ? [slot.connection] : []));
		});
		this.replacing = run.catch(() => {});
		return run;
	}

	/**
	 * Close everything, for good.
	 *
	 * Separate from `closeAll`, which a reload also uses: a reload that was already queued when the
	 * session went away would otherwise start every server again, for a session nobody will close.
	 */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.closeAll();
	}
}

type SlotState = McpServerStatus["state"];

/**
 * One configured server: its connection, if it has one, and where it is in connecting to it.
 *
 * Tools ask it for a client on every call (`McpToolHandle`), so a reconnect behind them is invisible
 * to the tool list the model already has.
 */
class Slot implements McpToolHandle {
	declared: McpServerConfig;
	state: SlotState = "connecting";
	connection: McpConnection | undefined;
	/** 最近一次列出的工具。重连期间留着：服务器回来了，工具表不必变。 */
	listed: RawMcpTool[] = [];
	error: string | undefined;
	/** 让这次连接失败的那个错误本身，`connect()` 原样抛给调用的人。 */
	failure: unknown;
	stderr: string | undefined;
	missing: string[] | undefined;
	/** 连续第几次重连。0 表示没在重连。 */
	attempt = 0;
	startedAt = Date.now();
	stderrOf: (() => string) | undefined;
	/** 服务器自己的一句介绍。断线重连期间留着上一次的：延迟加载的目录写在提示词里，不该跟着断线变。 */
	about: string | undefined;
	private connectedAt = 0;
	private closed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshing: Promise<void> | undefined;
	private refreshAgain = false;
	private readonly built = new Map<string, Tool>();
	private readonly waiters = new Set<() => void>();
	private readonly manager: McpManager;

	constructor(manager: McpManager, declared: McpServerConfig) {
		this.manager = manager;
		this.declared = declared;
	}

	get callTimeoutMs(): number {
		return this.manager.callTimeoutMs;
	}

	config(): McpServerConfig {
		return this.declared;
	}

	describe(): string | undefined {
		return this.about;
	}

	offersTools(): boolean {
		return this.state === "connected" || this.state === "reconnecting";
	}

	tool(raw: RawMcpTool, name: string): Tool {
		const key = `${raw.name}\0${name}`;
		let tool = this.built.get(key);
		if (!tool) {
			tool = toAgentTool(this, raw, name);
			this.built.set(key, tool);
		}
		return tool;
	}

	/** One connection attempt; its outcome lands in `state`. Never throws. */
	begin(): void {
		this.state = this.attempt > 0 ? "reconnecting" : "connecting";
		this.startedAt = Date.now();
		void this.manager.open(this).then(
			({ connection, listed }) => this.adopt(connection, listed),
			(error: unknown) => this.fail(error),
		);
	}

	private adopt(connection: McpConnection, listed: RawMcpTool[]): void {
		if (this.closed) {
			// Closed while this one was starting: nobody is going to read this connection, or close it.
			void connection.close();
			return;
		}
		this.connection = connection;
		this.connectedAt = Date.now();
		this.about = serverAbout(connection.client);
		this.state = "connected";
		this.error = undefined;
		this.failure = undefined;
		this.stderr = undefined;
		this.missing = undefined;
		this.setListed(listed);
		connection.client.onclose = () => {
			if (this.connection === connection && !this.closed) this.dropped();
		};
		this.wake();
		this.manager.changed(this);
	}

	private async fail(error: unknown): Promise<void> {
		// stderr 经 PassThrough 转一手，比进程的 close 晚一拍到；等它一下再读最后几行。
		await new Promise((resolve) => setImmediate(resolve));
		if (this.closed) return;
		this.failure = error;
		this.error = error instanceof Error ? error.message : String(error);
		this.stderr = this.stderrOf?.() || undefined;
		this.missing = error instanceof McpMissingValues ? error.missing : undefined;
		const policy = this.manager.reconnectPolicy;
		if (error instanceof McpNeedsLogin) this.state = "needs-login";
		else if (this.attempt > 0 && !(error instanceof McpMissingValues) && this.attempt < policy.attempts) {
			this.attempt += 1;
			this.state = "reconnecting";
			this.schedule();
		} else {
			if (this.attempt > 0) this.error = `Gave up after ${this.attempt} reconnect attempts: ${this.error}`;
			this.state = "failed";
		}
		this.wake();
		this.manager.changed(this);
	}

	/** 连着的连接断了：进程退出，或者远端断线。 */
	private dropped(): void {
		const stable = Date.now() - this.connectedAt >= this.manager.reconnectPolicy.stableMs;
		this.attempt = stable ? 1 : this.attempt + 1;
		this.connection = undefined;
		this.error = `The connection to "${this.declared.name}" was lost`;
		this.stderr = this.stderrOf?.() || undefined;
		if (this.attempt > this.manager.reconnectPolicy.attempts) {
			this.state = "failed";
			this.error = `Gave up after ${this.attempt - 1} reconnect attempts: it keeps disconnecting right after it connects`;
		} else {
			this.state = "reconnecting";
			this.schedule();
		}
		this.wake();
		this.manager.changed(this);
		// stderr 比 close 晚一拍到，补一次；状态没变，只是原因写全了。
		setImmediate(() => {
			if (this.closed || this.state === "connected") return;
			const tail = this.stderrOf?.() || undefined;
			if (tail !== this.stderr) {
				this.stderr = tail;
				this.manager.changed(this);
			}
		});
	}

	private schedule(): void {
		const policy = this.manager.reconnectPolicy;
		const delay = Math.min(policy.baseMs * 2 ** (this.attempt - 1), policy.maxMs);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.closed) this.begin();
		}, delay);
		// 退避等待不该让一个本来要退出的进程（命令行）多活一分半。
		this.timer.unref?.();
	}

	/** `tools/list_changed` 之后重列。同一时刻只列一次，列的过程中又变了就再列一次。 */
	async refreshTools(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		const connection = this.connection;
		if (!connection) return;
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				const listed = await withTimeout(listAllTools(connection.client, this.manager.timeoutMs), this.manager.timeoutMs, `Listing tools of "${this.declared.name}"`).catch(() => null);
				// 重列失败就留着旧的：少一个新工具，好过整台服务器的工具都不见了。
				if (listed && this.connection === connection && !this.closed && this.setListed(listed)) this.manager.changed(this);
			} while (this.refreshAgain);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	/** 换上新的工具表；和原来一模一样就不换，返回有没有变。 */
	private setListed(listed: RawMcpTool[]): boolean {
		const unique = [...new Map(listed.map((raw) => [raw.name, raw])).values()];
		const signature = (tools: RawMcpTool[]) => JSON.stringify(tools.map(({ name, title, description, inputSchema, annotations }) => [name, title, description, inputSchema, annotations]));
		if (signature(unique) === signature(this.listed)) return false;
		this.listed = unique;
		this.built.clear();
		return true;
	}

	/** 等它离开「第一次连」，最多等到 `deadline`。 */
	async settle(deadline: number): Promise<void> {
		while (this.state === "connecting" && !this.closed) {
			const left = deadline - Date.now();
			if (left <= 0) return;
			await this.nextChange(left);
		}
	}

	async client(signal?: AbortSignal): Promise<Client> {
		const deadline = Date.now() + RECONNECT_WAIT_MS;
		// oxlint-disable-next-line no-unmodified-loop-condition -- signal.aborted 由外部的 abort 改变，nextChange 会在那时返回
		while ((this.state === "connecting" || this.state === "reconnecting") && !this.closed && !signal?.aborted) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			await this.nextChange(left, signal);
		}
		if (this.state === "connected" && this.connection && !this.closed) return this.connection.client;
		if (signal?.aborted) throw new Error("cancelled");
		const where =
			this.state === "reconnecting"
				? `is reconnecting (attempt ${this.attempt} of ${this.manager.reconnectPolicy.attempts})`
				: this.state === "connecting"
					? "is still starting"
					: "is not connected";
		throw new Error(`MCP server "${this.declared.name}" ${where}${this.error ? `: ${this.error}` : ""}${this.explain()}`);
	}

	explain(): string {
		if (this.state === "connected") return "";
		const tail = this.stderr ?? this.stderrOf?.();
		return tail ? `\nLast lines the server wrote to stderr:\n${tail}` : "";
	}

	private nextChange(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				this.waiters.delete(done);
				resolve();
			};
			const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
			signal?.addEventListener("abort", done, { once: true });
			this.waiters.add(done);
		});
	}

	private wake(): void {
		// 每个 waiter 会把自己从集合里删掉；Set 迭代时删当前项是安全的。
		for (const waiter of this.waiters) waiter();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		if (this.state !== "failed" && this.state !== "needs-login") {
			this.error ??= `MCP server "${this.declared.name}" was disconnected`;
			this.state = "failed";
		}
		this.wake();
		await this.connection?.close();
	}
}

/** 两份声明会不会起出同一个进程、连到同一个地方：名字、来源、信任开关、常驻开关不算。 */
function sameLaunch(a: McpServerConfig, b: McpServerConfig): boolean {
	const launch = ({ name: _name, origin: _origin, trustReadOnly: _trust, pinned: _pinned, ...rest }: McpServerConfig) => JSON.stringify(rest);
	return launch(a) === launch(b);
}

/** 一行以内，够写进延迟加载的目录；`instructions` 往往是几段使用说明，只取第一行。 */
function serverAbout(client: Client): string | undefined {
	const text = client.getServerVersion()?.description?.trim() || client.getInstructions()?.trim().split("\n")[0]?.trim();
	if (!text) return undefined;
	return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function disabledStatus(server: McpServerConfig): McpServerStatus {
	return { id: server.id, name: server.name, origin: server.origin, state: "disabled", toolCount: 0, tools: [] };
}

/** 工具表也要翻页：只拿第一页，工具多的服务器会在工具表里少掉一截，而且没有人会发现。 */
async function listAllTools(client: Client, timeoutMs: number): Promise<RawMcpTool[]> {
	const tools: RawMcpTool[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
		tools.push(...(listed.tools as RawMcpTool[]));
		cursor = listed.nextCursor;
		if (!cursor) break;
	}
	return tools;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
