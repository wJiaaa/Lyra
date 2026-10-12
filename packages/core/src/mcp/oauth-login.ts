/**
 * 人点「登录」之后：本机回调、系统浏览器、授权码换令牌。
 *
 * 只在能开浏览器的宿主里调（桌面端主进程），浏览器由调用方开（`open`）——core 不碰 Electron。
 * 协议部分仍然是 SDK 的 `auth()`，这里给它一个能跳转的 provider，再接住回调。
 *
 * 回调端口沿用注册时登记的那个：授权服务器按注册的 `redirect_uris` 精确比对，换了端口它就拒绝。
 * 只有那个端口被别人占了，才换一个新端口、连注册一起重做——这是注册信息唯一会被丢掉的情况。
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CALLBACK_PATH, clientMetadata, mergeScopes, readRecord, updateRecord, usesOAuth, withTokens, type McpOAuthRecord } from "./oauth.ts";
import type { McpHttpServer, McpServerConfig } from "./types.ts";

export interface McpLoginOptions {
	/** 在系统浏览器里打开授权页。只会收到 http(s) 地址。 */
	open(url: string): Promise<void> | void;
	/** 等人在浏览器里点完的时间。默认五分钟。 */
	timeoutMs?: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** 同一台服务器同时只走一遍登录：连点两下，第二下等第一下的结果，而不是开第二个浏览器页。 */
const running = new Map<string, Promise<void>>();

export function loginMcpServer(server: McpServerConfig, options: McpLoginOptions): Promise<void> {
	if (!usesOAuth(server)) return Promise.reject(new Error(`MCP 服务器「${server.name}」不用 OAuth 登录。`));
	const existing = running.get(server.id);
	if (existing) return existing;
	const run = login(server, options).finally(() => running.delete(server.id));
	running.set(server.id, run);
	return run;
}

async function login(server: McpHttpServer, options: McpLoginOptions): Promise<void> {
	const challenge = await challengeOf(server);
	// 每次登录都重新发现：上次的元数据可能正是登录失效的原因（授权服务器搬了家）。
	await updateRecord(server, ({ discovery: _stale, ...rest }) => rest);
	const before = await readRecord(server);
	// 服务器这次要的、上次 403 要升的、原来已经有的，一起申请：登录不该让人丢掉已有的权限。
	const scope = mergeScopes(challenge.scope, before.stepUpScope, before.tokens?.scope);
	const registered = loopbackPort(before.client);
	const callback = await listen(registered ?? 0).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EADDRINUSE" || registered === undefined) throw error;
		return listen(0);
	});
	try {
		// 端口换了，旧注册登记的回调地址就对不上了：丢掉，让 SDK 重新注册一个。
		if (registered !== undefined && callback.port !== registered) await updateRecord(server, ({ client: _old, ...rest }) => rest);
		const provider = new LoginProvider(server, await readRecord(server), `http://127.0.0.1:${callback.port}${CALLBACK_PATH}`, scope, options.open);
		const request = { serverUrl: server.url, scope, ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}) };
		if ((await auth(provider, request)) === "AUTHORIZED") return;
		const code = await callback.code(provider.expectedState, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
		await auth(provider, { ...request, authorizationCode: code });
	} finally {
		callback.close();
	}
}

/**
 * 不带令牌敲一次门，读 401 里的 `WWW-Authenticate`：受保护资源元数据在哪、要什么 scope。
 *
 * 规范把这当作发现的第一步；不读它，SDK 只能去猜 well-known 地址，而资源元数据不在默认位置的
 * 服务器就发现不了。敲不开也不要紧——不是 401 的，交给 SDK 从 well-known 开始找。
 */
async function challengeOf(server: McpHttpServer): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 15_000);
	try {
		const response =
			server.transport === "sse"
				? await fetch(server.url, { headers: { accept: "text/event-stream" }, signal: abort.signal })
				: await fetch(server.url, {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
						body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plume", version: "0.1.0" } } }),
						signal: abort.signal,
					});
		await response.body?.cancel().catch(() => {});
		if (response.status !== 401 && response.status !== 403) return {};
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
		return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
		abort.abort();
	}
}

/** 注册时登记的回环端口；不是本机回环的（别处注册的）不认。 */
function loopbackPort(client: OAuthClientInformationMixed | undefined): number | undefined {
	const uri = client && "redirect_uris" in client ? client.redirect_uris[0] : undefined;
	if (!uri) return undefined;
	try {
		const url = new URL(String(uri));
		return url.hostname === "127.0.0.1" && url.port ? Number(url.port) : undefined;
	} catch {
		return undefined;
	}
}

interface Callback {
	port: number;
	/** 等浏览器带着授权码回来。`state` 对不上的不收——那不是这一次登录发出去的。 */
	code(state: string, timeoutMs: number): Promise<string>;
	close(): void;
}

function listen(port: number): Promise<Callback> {
	let deliver: ((query: URLSearchParams) => void) | undefined;
	const arrived: URLSearchParams[] = [];
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404).end();
			return;
		}
		const failed = url.searchParams.has("error");
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(page(failed ? "登录没有完成，回到 Plume 再试一次。<br>Sign-in did not finish. Go back to Plume and try again." : "登录完成，可以关掉这一页了。<br>Signed in. You can close this tab."));
		if (deliver) deliver(url.searchParams);
		else arrived.push(url.searchParams);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				code: (state, timeoutMs) =>
					new Promise<string>((done, fail) => {
						const timer = setTimeout(() => fail(new Error("等了太久，浏览器里的登录没有完成。再点一次「登录」。")), timeoutMs);
						deliver = (query) => {
							if (query.get("state") !== state) return;
							clearTimeout(timer);
							const error = query.get("error");
							if (error) fail(new Error(`授权服务器拒绝了登录：${query.get("error_description") ?? error}`));
							else if (!query.get("code")) fail(new Error("授权服务器跳回来时没有带授权码。"));
							else done(query.get("code")!);
						};
						for (const query of arrived.splice(0)) deliver(query);
					}),
				close: () => {
					server.closeAllConnections?.();
					server.close();
				},
			});
		});
	});
}

function page(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>Plume</title><body style="font:15px system-ui;margin:4rem;text-align:center;color:#333">${message}</body>`;
}

/** 登录用的 provider：可以注册、可以跳转，不拿旧令牌——登录就是从头授权一遍。 */
class LoginProvider implements OAuthClientProvider {
	readonly expectedState = randomBytes(24).toString("base64url");
	private verifier = "";
	private readonly server: McpHttpServer;
	private record: McpOAuthRecord;
	private readonly redirect: string;
	private readonly scope: string | undefined;
	private readonly open: McpLoginOptions["open"];

	constructor(server: McpHttpServer, record: McpOAuthRecord, redirect: string, scope: string | undefined, open: McpLoginOptions["open"]) {
		this.server = server;
		this.record = record;
		this.redirect = redirect;
		this.scope = scope;
		this.open = open;
	}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return clientMetadata(this.redirect, this.scope);
	}

	state(): string {
		return this.expectedState;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.record.client;
	}

	async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
		this.record = { ...this.record, client };
		await updateRecord(this.server, (record) => ({ ...record, client }));
	}

	tokens(): OAuthTokens | undefined {
		return undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await updateRecord(this.server, ({ stepUpScope: _granted, ...record }) => withTokens(record, tokens));
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		// 地址来自服务器给的元数据：只开网页，不让它借 openExternal 去拉起别的程序。
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`授权地址不是网页：${url.protocol}`);
		await this.open(url.href);
	}

	saveCodeVerifier(verifier: string): void {
		this.verifier = verifier;
	}

	codeVerifier(): string {
		return this.verifier;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "verifier") return;
		const drop = (record: McpOAuthRecord): McpOAuthRecord => {
			if (scope === "all") return { serverUrl: record.serverUrl };
			const { [scope]: _gone, ...rest } = record;
			return rest;
		};
		this.record = drop(this.record);
		await updateRecord(this.server, drop);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.record.discovery;
	}

	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		if (!state.authorizationServerMetadata && !state.resourceMetadata) {
			throw new Error(`MCP 服务器「${this.server.name}」没有提供 OAuth 元数据，没法在这里登录。如果它要的是 API key，请在请求头里配置 Authorization。`);
		}
		this.record = { ...this.record, discovery: state };
		await updateRecord(this.server, (record) => ({ ...record, discovery: state }));
	}
}
