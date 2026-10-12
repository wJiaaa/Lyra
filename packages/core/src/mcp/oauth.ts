/**
 * MCP 远程服务器的 OAuth：令牌存哪、后台连接怎么用它、什么时候该说「需要登录」。
 *
 * 协议本身全交给 SDK（`@modelcontextprotocol/sdk/client/auth.js` 的 `auth()`）：受保护资源元数据
 * （RFC 9728）→ 授权服务器元数据（RFC 8414 / OIDC，带回退路径）→ 动态注册（RFC 7591）→ PKCE 授权码，
 * `resource` 参数（RFC 8707）、刷新、401 / 403 insufficient_scope 的重试也都在 SDK 里。这里只实现
 * 它要的那个 `OAuthClientProvider`：东西存在哪、哪一步不许在后台发生。
 *
 * 分两种 provider，因为后台连接和人点「登录」能做的事不一样：
 *
 * - **后台**（会话、设置页探测、命令行）：只用已有的令牌，过期了用刷新令牌换新的。走到任何一步要人
 *   参与——没注册过、刷新失败、要更大的 scope——就抛 `McpNeedsLogin`，状态变成「需要登录」。
 *   尤其不在后台动态注册：每次连接注册一个用不上的客户端，授权服务器那边会堆满垃圾。
 * - **登录**（`oauth-login.ts`）：开本机回调、开浏览器、换令牌、把注册信息存下来以后复用。
 *
 * 存储：每台服务器一条，放在 vault 里（`mcp-oauth:<id>`），记着它属于哪个 URL——改了地址的服务器
 * 不会拿着旧地址的令牌去敲新地址；也记着访问令牌什么时候过期，快到时提前换（`REFRESH_AHEAD_MS`）。
 *
 * 几处非这样写不可的地方和已知上限见 docs/architecture/mcp-client.md。
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { putSecrets, secret } from "../config/vault.ts";
import { plumeHome } from "../session/store.ts";
import { withFileLock } from "../utils/file-lock.ts";
import type { McpHttpServer, McpServerConfig } from "./types.ts";

/** 一台服务器的登录记录。SDK 交来的东西原样存（它会盖上 `issuer`，下次靠它判断是不是同一个授权服务器）。 */
export interface McpOAuthRecord {
	/** 这份记录属于哪个地址。地址变了，整份作废。 */
	serverUrl: string;
	client?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	discovery?: OAuthDiscoveryState;
	/** 服务器回过 403 insufficient_scope 要的 scope：下次登录要一并申请，在那之前算「需要登录」。 */
	stepUpScope?: string;
	/** 访问令牌什么时候过期（毫秒时间戳），按换来时的 `expires_in` 算。没给 `expires_in` 的没有这一项。 */
	expiresAt?: number;
}

/** 换来一份新令牌：记下它，也记下它什么时候过期。 */
export function withTokens(record: McpOAuthRecord, tokens: OAuthTokens): McpOAuthRecord {
	const { expiresAt: _old, ...rest } = record;
	return { ...rest, tokens, ...(typeof tokens.expires_in === "number" ? { expiresAt: Date.now() + tokens.expires_in * 1000 } : {}) };
}

/**
 * 离过期还剩这么久就提前换：60 秒，但不超过令牌寿命的一半。
 *
 * 提前换省掉的是一次注定的 401——带着过期令牌发出去、被拒、刷新、重发。留一分钟是给两边时钟
 * 的偏差和这次请求本身在路上的时间；授权服务器给的有效期通常是一小时，一分钟不算浪费。寿命比
 * 一分钟还短的令牌（有的只给 30 秒）照这一分钟算，刚换来就又「快过期」，每个请求都去换一次。
 */
const REFRESH_AHEAD_MS = 60_000;

function refreshAhead(tokens: OAuthTokens): number {
	return typeof tokens.expires_in === "number" ? Math.min(REFRESH_AHEAD_MS, (tokens.expires_in * 1000) / 2) : REFRESH_AHEAD_MS;
}

/** 后台连接走到了要人参与的那一步。界面把它画成「需要登录」，命令行说去桌面端登录。 */
export class McpNeedsLogin extends Error {
	readonly serverName: string;
	constructor(serverName: string, why: string) {
		super(`MCP 服务器「${serverName}」需要登录（${why}）。请在 Plume 桌面端的 设置 → MCP 里点「登录」。`);
		this.name = "McpNeedsLogin";
		this.serverName = serverName;
	}
}

/** vault 里的位置。`config/settings.ts` 按这个前缀清掉已删除服务器的令牌。 */
export const MCP_OAUTH_PREFIX = "mcp-oauth:";
const recordId = (serverId: string): string => `${MCP_OAUTH_PREFIX}${serverId}`;

/**
 * 要不要给它挂 OAuth：远程服务器，而且没有自己配 Authorization 头。
 *
 * 配了头的，人已经给了凭据；再挂一层，401 时 SDK 会去发现、去注册，跟人填的那个令牌打架。
 */
export function usesOAuth(server: McpServerConfig): server is McpHttpServer {
	if (server.transport === "stdio") return false;
	return !Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

/** 同一台服务器的读改写一个接一个：刷新和登录可能同时落到一条记录上。 */
const updating = new Map<string, Promise<unknown>>();

export async function readRecord(server: McpHttpServer): Promise<McpOAuthRecord> {
	const raw = await secret(recordId(server.id));
	const parsed = raw ? (JSON.parse(raw) as McpOAuthRecord) : null;
	return parsed && parsed.serverUrl === server.url ? parsed : { serverUrl: server.url };
}

export function updateRecord(server: McpHttpServer, change: (record: McpOAuthRecord) => McpOAuthRecord | null): Promise<void> {
	const id = recordId(server.id);
	const run = (updating.get(id) ?? Promise.resolve()).then(async () => {
		const next = change(await readRecord(server));
		await putSecrets({ [id]: next ? JSON.stringify(next) : "" });
	});
	updating.set(
		id,
		run.catch(() => {}),
	);
	return run;
}

/** 退出登录：令牌和发现结果都丢掉，注册信息留着——下次登录不必再注册一遍。 */
export function forgetTokens(server: McpHttpServer): Promise<void> {
	return updateRecord(server, ({ client, serverUrl }) => (client ? { serverUrl, client } : null));
}

/** 这台服务器眼下有没有登录：有令牌、而且没有欠着一次 scope 升级。 */
export async function signedIn(server: McpServerConfig): Promise<boolean> {
	if (!usesOAuth(server)) return false;
	const record = await readRecord(server);
	return Boolean(record.tokens) && !record.stepUpScope;
}

/** 两串空格分隔的 scope 合在一起，去重、保序。 */
export function mergeScopes(...lists: (string | undefined)[]): string | undefined {
	const all = [...new Set(lists.flatMap((list) => list?.split(/\s+/).filter(Boolean) ?? []))];
	return all.length ? all.join(" ") : undefined;
}

/** 回调地址只认本机回环：注册时登记的就是它，见 `oauth-login.ts`。 */
export const CALLBACK_PATH = "/callback";

export function clientMetadata(redirectUrl: string, scope?: string): OAuthClientMetadata {
	return {
		client_name: "Plume",
		redirect_uris: [redirectUrl],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		// 桌面应用是公开客户端：拿不住 client_secret，靠 PKCE。
		token_endpoint_auth_method: "none",
		...(scope ? { scope } : {}),
	};
}

/**
 * 后台连接用的 provider。
 *
 * `redirectUrl` 必须有值：SDK 把「没有回调地址」当成 client_credentials 那种无人值守的授权，会
 * 直接去 token 端点要令牌。这里给的是注册时登记过的那个，不会真的用到——走到要跳转那一步就抛了。
 */
export class BackgroundOAuthProvider implements OAuthClientProvider {
	/** 这一次连接里碰到过 403 insufficient_scope：刷新换不来更大的 scope，必须重新授权。 */
	private steppingUp = false;
	/** 这一次连接里令牌被作废过（刷新被拒）：要说「登录已失效」，而不是「还没有登录过」。 */
	private lapsed = false;
	/** 正在提前换的那一次。 */
	private ahead: Promise<void> | undefined;
	private readonly server: McpHttpServer;
	private record: McpOAuthRecord;

	constructor(server: McpHttpServer, record: McpOAuthRecord) {
		this.server = server;
		this.record = record;
	}

	static async for(server: McpHttpServer): Promise<BackgroundOAuthProvider> {
		return new BackgroundOAuthProvider(server, await readRecord(server));
	}

	get redirectUrl(): string {
		const registered = this.record.client && "redirect_uris" in this.record.client ? this.record.client.redirect_uris[0] : undefined;
		return registered ? String(registered) : `http://127.0.0.1${CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(this.redirectUrl);
	}

	clientInformation(): OAuthClientInformationMixed {
		const client = this.record.client;
		if (!client) throw this.needsLogin("还没有登录过");
		/*
		 * 授权服务器换了：SDK 会把旧注册当作不存在、在后台重新注册一个。这里先拦下——注册属于登录。
		 * 比较的是 SDK 刚存下的发现结果，它判断用的也是这个地址。
		 */
		const issuer = typeof client.issuer === "string" ? client.issuer : undefined;
		const current = this.record.discovery?.authorizationServerUrl;
		if (issuer && current && !sameUrl(issuer, current)) throw this.needsLogin("授权服务器变了");
		return client;
	}

	/**
	 * 每次都从 vault 读：同一台服务器可能有好几条连接（几个会话、设置页的探测），谁刷新了令牌，别的
	 * 连接下一次请求就该用新的。只读自己手上那份的话，它会拿着已经被轮换掉的刷新令牌去换，换来
	 * invalid_grant，SDK 再据此把别人刚存的新令牌清掉。
	 */
	async tokens(): Promise<OAuthTokens | undefined> {
		await this.reread();
		/*
		 * 快过期了就先换：见 `REFRESH_AHEAD_MS`。换的过程（SDK 的 `auth()`）自己也会来问 `tokens()`，
		 * 那一次以及同时到的其他请求直接拿手上这份——离过期还有一分钟，它还能用。
		 */
		if (!this.ahead && this.dueForRefresh()) {
			this.ahead = this.refreshAhead().finally(() => {
				this.ahead = undefined;
			});
			await this.ahead;
			await this.reread();
		}
		const tokens = this.record.tokens;
		if (!tokens) return undefined;
		// 要升 scope 的时候不给刷新令牌：刷新换来的还是原来那点权限，SDK 会再撞一次 403。
		if (this.steppingUp || this.record.stepUpScope) {
			const { refresh_token: _spent, ...rest } = tokens;
			return rest;
		}
		return tokens;
	}

	private async reread(): Promise<void> {
		this.record = { ...(await readRecord(this.server)), ...(this.record.discovery ? { discovery: this.record.discovery } : {}) };
	}

	private dueForRefresh(): boolean {
		const { tokens, expiresAt, stepUpScope } = this.record;
		return Boolean(tokens?.refresh_token && expiresAt !== undefined && !this.steppingUp && !stepUpScope && expiresAt - Date.now() < refreshAhead(tokens));
	}

	/** 提前换一次。换不成（网断了、刷新令牌被拒）不在这里报：照旧发请求，由 401 走原来那条路。 */
	private async refreshAhead(): Promise<void> {
		await auth(this, { serverUrl: this.server.url, fetchFn: this.fetch }).catch(() => {});
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.record = withTokens(this.record, tokens);
		await updateRecord(this.server, (record) => withTokens(record, tokens));
	}

	redirectToAuthorization(): never {
		throw this.needsLogin(this.steppingUp || this.record.stepUpScope ? "需要更大的权限" : this.record.tokens || this.lapsed ? "登录已失效" : "还没有登录过");
	}

	saveCodeVerifier(): void {}

	codeVerifier(): never {
		throw this.needsLogin("还没有登录过");
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "verifier") return;
		if ((scope === "all" || scope === "tokens") && this.record.tokens) this.lapsed = true;
		const used = this.record.tokens?.refresh_token;
		const drop = (record: McpOAuthRecord): McpOAuthRecord => {
			if (scope === "all") return { serverUrl: record.serverUrl };
			// 被拒的是我们手上那张；vault 里已经换成别的连接刚刷新来的，就不是它的问题，留着。
			if (scope === "tokens" && record.tokens?.refresh_token !== used) return record;
			const { [scope === "client" ? "client" : scope === "tokens" ? "tokens" : "discovery"]: _gone, ...rest } = record;
			return rest;
		};
		this.record = drop(this.record);
		await updateRecord(this.server, drop);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record.discovery;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		// 什么元数据都没找到：这台服务器要的不是 MCP 的 OAuth（多半是要一个 API key 头）。别把它说成「需要登录」。
		if (!state.authorizationServerMetadata && !state.resourceMetadata) {
			throw new Error(`MCP 服务器「${this.server.name}」要求鉴权（401），但没有提供 OAuth 元数据。如果它要的是 API key，请在请求头里配置 Authorization。`);
		}
		this.record = { ...this.record, discovery: state };
		await updateRecord(this.server, (record) => ({ ...record, discovery: state }));
	}

	/**
	 * 给传输层的 fetch：记下 403 insufficient_scope 要的 scope，再把响应原样交回去。
	 *
	 * SDK 收到这个 403 会带着新 scope 再走一遍 `auth()`；记下来是为了两件事：这一次不许拿刷新令牌
	 * 糊弄过去（见 `tokens`），以及下次人点「登录」时把它一起申请上。
	 */
	readonly fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
		const response = await refreshOnce(this.server, url, init);
		if (response.status === 403) {
			const { error, scope } = extractWWWAuthenticateParams(response);
			if (error === "insufficient_scope") {
				this.steppingUp = true;
				const wanted = mergeScopes(this.record.stepUpScope, scope);
				this.record = { ...this.record, ...(wanted ? { stepUpScope: wanted } : {}) };
				if (wanted) await updateRecord(this.server, (record) => ({ ...record, stepUpScope: mergeScopes(record.stepUpScope, wanted) }));
			}
		}
		return response;
	};

	private needsLogin(why: string): McpNeedsLogin {
		return new McpNeedsLogin(this.server.name, why);
	}
}

/**
 * 同一个刷新令牌只换一次——这个进程里，以及几个进程之间。
 *
 * 一条连接的 POST 和它的 SSE 长连接可能同时撞上 401，同一进程里几个会话连着同一台服务器也会；各自
 * 去刷新，授权服务器轮换刷新令牌时，后到的那个拿着已经作废的令牌换，得到 invalid_grant——SDK 据此
 * 清掉令牌，刚换来的新令牌也跟着没了。进程里，后到的直接用先到的那份响应。
 *
 * 进程之间（桌面端和命令行连着同一台服务器）靠一把每台服务器一个的锁文件：拿到锁以后先从磁盘
 * 重读一遍记录，发现刷新令牌已经被别的进程换掉了，就不再拿旧的去换，直接把别人换来的那份当作这次的
 * 响应交回给 SDK；自己换成了，先把新令牌写进 vault 再放锁——放锁之后进来的那个读到的就是新的。
 */
const refreshing = new Map<string, Promise<Response>>();
async function refreshOnce(server: McpHttpServer, url: string | URL, init?: RequestInit): Promise<Response> {
	const body = init?.body;
	const grant = body instanceof URLSearchParams && body.get("grant_type") === "refresh_token" ? body.get("refresh_token") : null;
	if (!grant) return fetch(url, init);
	const running = refreshing.get(grant);
	if (running) return (await running).clone();
	const request = withFileLock(refreshLockPath(server), () => refreshUnderLock(server, grant, url, init));
	refreshing.set(grant, request);
	try {
		return (await request).clone();
	} finally {
		// 留一会儿：同时撞上 401 的那几个未必在同一个微任务里到。
		setTimeout(() => refreshing.delete(grant), 5_000).unref?.();
	}
}

async function refreshUnderLock(server: McpHttpServer, grant: string, url: string | URL, init?: RequestInit): Promise<Response> {
	const stored = await readRecord(server);
	const current = stored.tokens;
	if (current?.access_token && current.refresh_token && current.refresh_token !== grant) {
		const expiresIn = stored.expiresAt !== undefined ? Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000)) : undefined;
		const { issuer: _issuer, ...tokens } = current as OAuthTokens & { issuer?: unknown };
		return Response.json({ ...tokens, ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) });
	}
	const response = await fetch(url, init);
	if (response.ok) {
		const fresh = (await response
			.clone()
			.json()
			.catch(() => null)) as OAuthTokens | null;
		if (fresh?.access_token) {
			// 和 SDK 随后存的那份一样：没给新刷新令牌就沿用旧的，`issuer` 照旧盖上。
			const issuer = (current as { issuer?: unknown } | undefined)?.issuer;
			const tokens = { refresh_token: grant, ...fresh, ...(issuer ? { issuer } : {}) } as OAuthTokens;
			await updateRecord(server, (record) => withTokens(record, tokens));
		}
	}
	return response;
}

function refreshLockPath(server: McpHttpServer): string {
	const id = createHash("sha256").update(server.id).digest("hex").slice(0, 16);
	return join(plumeHome(), "locks", `mcp-oauth-${id}.lock`);
}

function sameUrl(a: string, b: string): boolean {
	try {
		return new URL(a).href === new URL(b).href;
	} catch {
		return a === b;
	}
}
