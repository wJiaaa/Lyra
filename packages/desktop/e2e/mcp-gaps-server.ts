/**
 * 真窗口验证 MCP 三项能力时用的那台服务器：源码在这里，跑的时候写进临时目录、用完连目录一起删。
 *
 * 一个进程两个端点：
 *
 * - `/mcp`：不要登录。一个带参数的 prompt（`review`），一个中途反问用户的工具（`ask_profile`，
 *   发 `elicitation/create`，把拿到的回答原样当结果返回）。
 * - `/secure/mcp`：要 OAuth。没带令牌回 401，`WWW-Authenticate` 里指向受保护资源元数据；同一个进程
 *   里有一台最小的授权服务器：元数据、动态注册、自动同意的 authorize、token（授权码 + PKCE、刷新）。
 *
 * 用 SDK 的服务端说 MCP，授权服务器手写——要验的就是我们的客户端对着一台照规范发现、注册、换令牌的
 * 服务器能不能走完，而 SDK 自带的那套授权服务器要 express。`/debug/stats` 报每一步被走了几次，
 * 验证脚本据此断言「注册只发生了一次」之类的事。
 */

/** 服务器脚本本体。`SDK` 是 `@modelcontextprotocol/sdk` 的 esm 目录的 file URL，启动时传进来。 */
export const MCP_GAPS_SERVER = String.raw`
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
const SDK = process.env.SDK;
const { Server } = await import(SDK + "/server/index.js");
const { StreamableHTTPServerTransport } = await import(SDK + "/server/streamableHttp.js");
const T = await import(SDK + "/types.js");

const stats = { registrations: 0, authorizations: 0, codeExchanges: 0, refreshes: 0, rejected: 0, elicitations: [], resources: [] };
const clients = new Map();
const codes = new Map();
const access = new Map();
const refresh = new Map();
let origin = "";

function mcp(secure) {
	const server = new Server({ name: secure ? "secure-fixture" : "demo-fixture", version: "1.0.0" }, { capabilities: { tools: {}, ...(secure ? {} : { prompts: {} }) } });
	if (!secure) {
		server.setRequestHandler(T.ListPromptsRequestSchema, async () => ({ prompts: [
			{ name: "review", description: "让模型审一段代码", arguments: [{ name: "code", description: "要审的代码", required: true }, { name: "language", description: "语言" }] },
		] }));
		server.setRequestHandler(T.GetPromptRequestSchema, async (request) => {
			const args = request.params.arguments ?? {};
			return { messages: [
				{ role: "user", content: { type: "text", text: "请审查这段 " + (args.language || "代码") + "，指出缺陷：" } },
				{ role: "user", content: { type: "text", text: String(args.code ?? "") } },
			] };
		});
	}
	server.setRequestHandler(T.ListToolsRequestSchema, async () => ({ tools: secure
		? [{ name: "whoami", description: "Who the token belongs to", inputSchema: { type: "object", properties: {} } }]
		: [{ name: "ask_profile", description: "Ask the user for their profile", inputSchema: { type: "object", properties: {} } }] }));
	server.setRequestHandler(T.CallToolRequestSchema, async (request, extra) => {
		if (secure) return { content: [{ type: "text", text: "you are the demo user" }] };
		const answer = await server.elicitInput({
			message: "填一下你的资料，工具要用",
			requestedSchema: {
				type: "object",
				properties: {
					name: { type: "string", title: "名字", minLength: 1 },
					color: { type: "string", title: "颜色", enum: ["red", "green", "blue"], enumNames: ["红", "绿", "蓝"] },
					age: { type: "integer", title: "年龄", minimum: 0, maximum: 150 },
					subscribe: { type: "boolean", title: "订阅", default: false },
				},
				required: ["name", "age"],
			},
		}, { relatedRequestId: extra.requestId, timeout: 600000 });
		stats.elicitations.push(answer);
		return { content: [{ type: "text", text: "elicitation answer: " + JSON.stringify(answer) }] };
	});
	return server;
}

const transports = new Map();
async function serveMcp(req, res, secure) {
	const id = req.headers["mcp-session-id"];
	let transport = typeof id === "string" ? transports.get(id) : undefined;
	if (!transport) {
		transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (sid) => transports.set(sid, transport) });
		await mcp(secure).connect(transport);
	}
	await transport.handleRequest(req, res);
}

const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const form = async (req) => { let raw = ""; for await (const chunk of req) raw += chunk; return new URLSearchParams(raw); };
const body = async (req) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; };

const http = createServer(async (req, res) => {
	const url = new URL(req.url, origin);
	const path = url.pathname;
	if (path === "/debug/stats") return json(res, 200, { ...stats, clients: clients.size });
	if (path === "/mcp") return serveMcp(req, res, false);
	if (path === "/secure/mcp") {
		const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
		const grant = token && access.get(token);
		if (!grant || grant.expires < Date.now()) {
			stats.rejected++;
			res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/secure/mcp", scope="mcp"' });
			return res.end();
		}
		return serveMcp(req, res, true);
	}
	if (path === "/.well-known/oauth-protected-resource/secure/mcp") return json(res, 200, { resource: origin + "/secure/mcp", authorization_servers: [origin + "/auth"], scopes_supported: ["mcp"] });
	if (path === "/.well-known/oauth-authorization-server/auth") return json(res, 200, {
		issuer: origin + "/auth",
		authorization_endpoint: origin + "/auth/authorize",
		token_endpoint: origin + "/auth/token",
		registration_endpoint: origin + "/auth/register",
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
	});
	if (path === "/auth/register" && req.method === "POST") {
		const meta = await body(req);
		stats.registrations++;
		const client = { ...meta, client_id: "client-" + randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: "none" };
		clients.set(client.client_id, client);
		return json(res, 201, client);
	}
	if (path === "/auth/authorize") {
		const q = url.searchParams;
		const client = clients.get(q.get("client_id"));
		const redirect = q.get("redirect_uri");
		if (!client || !client.redirect_uris.includes(redirect)) { res.writeHead(400); return res.end("redirect_uri mismatch"); }
		if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) { res.writeHead(400); return res.end("PKCE required"); }
		stats.authorizations++;
		stats.resources.push(q.get("resource"));
		const code = "code-" + randomUUID();
		codes.set(code, { client: client.client_id, challenge: q.get("code_challenge"), redirect, scope: q.get("scope") });
		const back = new URL(redirect);
		back.searchParams.set("code", code);
		if (q.get("state")) back.searchParams.set("state", q.get("state"));
		res.writeHead(302, { location: back.href });
		return res.end();
	}
	if (path === "/auth/token" && req.method === "POST") {
		const p = await form(req);
		const issue = (client, scope) => {
			const token = "at-" + randomUUID();
			const renew = "rt-" + randomUUID();
			access.set(token, { client, expires: Date.now() + Number(process.env.TOKEN_TTL_MS || 3600000) });
			refresh.set(renew, { client, scope });
			return { access_token: token, token_type: "Bearer", expires_in: Math.round(Number(process.env.TOKEN_TTL_MS || 3600000) / 1000), refresh_token: renew, scope };
		};
		if (p.get("grant_type") === "authorization_code") {
			const grant = codes.get(p.get("code"));
			codes.delete(p.get("code"));
			const verifier = p.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (!grant || grant.client !== p.get("client_id") || grant.challenge !== challenge || grant.redirect !== p.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
			stats.codeExchanges++;
			return json(res, 200, issue(grant.client, grant.scope));
		}
		if (p.get("grant_type") === "refresh_token") {
			const grant = refresh.get(p.get("refresh_token"));
			refresh.delete(p.get("refresh_token"));
			if (!grant) return json(res, 400, { error: "invalid_grant" });
			stats.refreshes++;
			return json(res, 200, issue(grant.client, grant.scope));
		}
		return json(res, 400, { error: "unsupported_grant_type" });
	}
	res.writeHead(404);
	res.end();
});
http.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
	origin = "http://127.0.0.1:" + http.address().port;
	process.stdout.write("LISTENING " + origin + "\n");
});
`;
