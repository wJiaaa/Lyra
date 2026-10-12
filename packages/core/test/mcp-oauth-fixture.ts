/**
 * 给 `mcp-http-fixture.ts` 那台 MCP 服务器装上门禁和一台最小的授权服务器，OAuth 的测试用。
 *
 * 授权服务器手写：受保护资源元数据（RFC 9728）、授权服务器元数据（RFC 8414）、动态注册、自动同意的
 * authorize（校验回调地址和 PKCE）、token（授权码 + PKCE、刷新令牌轮换）。每一步被走了几次记在
 * `stats` 里，测试据此断言「只注册了一次」「带了 resource」这类事。
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startMcpHttpFixture, type McpHttpFixture } from "./mcp-http-fixture.ts";

export interface OAuthFixtureOptions {
	/** 访问令牌活多久，毫秒。 */
	ttlMs?: number;
	/** 401 里写不写 `resource_metadata`。不写时客户端要自己去 well-known 找。 */
	advertise?: boolean;
	/** 调工具要的 scope；令牌没有就回 403 insufficient_scope。 */
	toolScope?: string;
	/** 完全不给 OAuth 元数据：一台要 API key 的服务器。 */
	noMetadata?: boolean;
}

export interface OAuthFixture extends McpHttpFixture {
	stats: {
		registrations: number;
		authorizations: { scope: string | null; resource: string | null; state: string | null; clientId: string | null }[];
		codeExchanges: number;
		refreshes: number;
		refreshRejected: number;
		/** 带着令牌进来的请求里的令牌，按先后。 */
		bearers: string[];
	};
	/** 让之后的刷新一律回 invalid_grant（授权服务器吊销了刷新令牌）。 */
	revokeRefresh(): void;
	/** 让手上所有访问令牌立刻过期。 */
	expireAccess(): void;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => resolve(raw));
	});
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

export async function startOAuthFixture(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
	const stats: OAuthFixture["stats"] = { registrations: 0, authorizations: [], codeExchanges: 0, refreshes: 0, refreshRejected: 0, bearers: [] };
	const clients = new Map<string, { redirect_uris: string[] }>();
	const codes = new Map<string, { client: string; challenge: string; redirect: string; scope: string }>();
	const access = new Map<string, { expires: number; scope: string }>();
	const refresh = new Map<string, { client: string; scope: string }>();
	let refreshRevoked = false;
	let origin = "";

	const challenge = (res: ServerResponse, status: 401 | 403, extra = "") => {
		const meta = options.advertise === false || options.noMetadata ? "" : ` resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp",`;
		res.writeHead(status, { "www-authenticate": `Bearer${meta} scope="mcp"${extra}` });
		res.end();
	};

	const fixture = await startMcpHttpFixture({
		guard: async (req, res) => {
			const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
			if (token) stats.bearers.push(token);
			const grant = token ? access.get(token) : undefined;
			if (!grant || grant.expires < Date.now()) {
				challenge(res, 401);
				return false;
			}
			if (options.toolScope && req.method === "POST") {
				// 偷看一眼请求体：只有调工具要更大的 scope。看完要把它还给传输层。
				const raw = await readBody(req);
				const wanted = raw.includes('"tools/call"') && !grant.scope.split(" ").includes(options.toolScope);
				(req as IncomingMessage & { body?: unknown }).body = JSON.parse(raw);
				if (wanted) {
					res.writeHead(403, { "www-authenticate": `Bearer error="insufficient_scope", scope="mcp ${options.toolScope}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
					res.end();
					return false;
				}
			}
			return true;
		},
		routes: async (req, res, url) => {
			const path = url.pathname;
			if (options.noMetadata && path.startsWith("/.well-known/")) return false;
			if (path === "/.well-known/oauth-protected-resource/mcp") {
				json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [`${origin}/auth`], scopes_supported: ["mcp"] });
				return true;
			}
			if (path === "/.well-known/oauth-authorization-server/auth") {
				json(res, 200, {
					issuer: `${origin}/auth`,
					authorization_endpoint: `${origin}/auth/authorize`,
					token_endpoint: `${origin}/auth/token`,
					registration_endpoint: `${origin}/auth/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
				return true;
			}
			if (path === "/auth/register" && req.method === "POST") {
				const meta = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
				stats.registrations += 1;
				const client = { ...meta, client_id: `client-${randomUUID()}`, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" };
				clients.set(client.client_id, client);
				json(res, 201, client);
				return true;
			}
			if (path === "/auth/authorize") {
				const q = url.searchParams;
				const client = clients.get(q.get("client_id") ?? "");
				const redirect = q.get("redirect_uri") ?? "";
				stats.authorizations.push({ scope: q.get("scope"), resource: q.get("resource"), state: q.get("state"), clientId: q.get("client_id") });
				if (!client || !client.redirect_uris.includes(redirect) || q.get("code_challenge_method") !== "S256") {
					res.writeHead(400).end("bad authorization request");
					return true;
				}
				const code = `code-${randomUUID()}`;
				codes.set(code, { client: q.get("client_id")!, challenge: q.get("code_challenge")!, redirect, scope: q.get("scope") ?? "" });
				const back = new URL(redirect);
				back.searchParams.set("code", code);
				if (q.get("state")) back.searchParams.set("state", q.get("state")!);
				res.writeHead(302, { location: back.href }).end();
				return true;
			}
			if (path === "/auth/token" && req.method === "POST") {
				const p = new URLSearchParams(await readBody(req));
				const issue = (client: string, scope: string) => {
					const token = `at-${randomUUID()}`;
					const renew = `rt-${randomUUID()}`;
					access.set(token, { expires: Date.now() + (options.ttlMs ?? 3_600_000), scope });
					refresh.set(renew, { client, scope });
					return { access_token: token, token_type: "Bearer", expires_in: Math.ceil((options.ttlMs ?? 3_600_000) / 1000), refresh_token: renew, scope };
				};
				if (p.get("grant_type") === "authorization_code") {
					const grant = codes.get(p.get("code") ?? "");
					codes.delete(p.get("code") ?? "");
					const verified = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
					if (!grant || grant.client !== p.get("client_id") || grant.challenge !== verified || grant.redirect !== p.get("redirect_uri")) {
						json(res, 400, { error: "invalid_grant" });
						return true;
					}
					stats.codeExchanges += 1;
					json(res, 200, issue(grant.client, grant.scope));
					return true;
				}
				if (p.get("grant_type") === "refresh_token") {
					const grant = refresh.get(p.get("refresh_token") ?? "");
					refresh.delete(p.get("refresh_token") ?? "");
					if (!grant || refreshRevoked) {
						stats.refreshRejected += 1;
						json(res, 400, { error: "invalid_grant" });
						return true;
					}
					stats.refreshes += 1;
					json(res, 200, issue(grant.client, grant.scope));
					return true;
				}
				json(res, 400, { error: "unsupported_grant_type" });
				return true;
			}
			return false;
		},
	});
	origin = fixture.origin;
	return Object.assign(fixture, {
		stats,
		revokeRefresh: () => void (refreshRevoked = true),
		expireAccess: () => {
			for (const grant of access.values()) grant.expires = 0;
		},
	});
}

/**
 * 替人在浏览器里点「同意」：打开授权页，跟着它跳回本机回调。
 *
 * 不跟随重定向，自己去敲回调地址：那正是浏览器会做的事，而回调服务器要的就是那一下 GET。
 */
export async function browser(url: string): Promise<void> {
	const response = await fetch(url, { redirect: "manual" });
	const location = response.headers.get("location");
	if (!location) throw new Error(`authorize did not redirect: ${response.status}`);
	await (await fetch(location)).text();
}
