/**
 * 一台真的 MCP 服务器，跑在本进程的一个 HTTP 端口上，给 prompts、elicitation、OAuth 的测试用。
 *
 * 用 SDK 自己的服务端（`Server` + Streamable HTTP），不用手写 JSON-RPC：要钉住的是我们的客户端
 * 对着一台照规范说话的服务器时做得对不对，而服务端那一半照规范说话正是 SDK 已经做好的事。
 * 有状态的会话：elicitation 是服务器在一次工具调用中途反问客户端，回答走另一个 POST，必须落回
 * 同一个传输上。
 *
 * 不用 zod 的高层 `McpServer`：core 不依赖 zod，测试也不该为此引进来。
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ElicitResultSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListToolsRequestSchema,
	type ClientCapabilities,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

export interface FixtureOptions {
	/** 每次请求先过它；返回 false 表示它已经自己答了（比如 401）。OAuth 的测试拿它挡门。 */
	guard?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
	/** 每页几个 prompt；不给就一页。 */
	promptPage?: number;
	/** 额外的路由，比如授权服务器的那几个端点。返回 true 表示答过了。 */
	routes?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;
}

export interface McpHttpFixture {
	url: string;
	origin: string;
	/** 每次 initialize 时客户端声明的能力。 */
	capabilities: ClientCapabilities[];
	/** `ask` 工具每次拿到的回答。 */
	answers: ElicitResult[];
	close(): Promise<void>;
}

/** 一个带参数的 prompt 和一个不带的。 */
const PROMPTS = [
	{ name: "review", description: "Review a piece of code", arguments: [{ name: "code", description: "The code", required: true }, { name: "language", required: false }] },
	{ name: "hello", description: "Say hello", arguments: [] },
];

/** 一份扁平表单：规范允许的四种原始类型都在。 */
export const FORM_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string", title: "Name", minLength: 1 },
		color: { type: "string", enum: ["red", "green"], enumNames: ["Red", "Green"] },
		email: { type: "string", format: "email" },
		age: { type: "integer", minimum: 0, maximum: 150 },
		score: { type: "number" },
		subscribe: { type: "boolean", default: false },
	},
	required: ["name", "age"],
} as const;

function mcpServer(fixture: McpHttpFixture, options: FixtureOptions): Server {
	const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {}, prompts: { listChanged: true } } });
	server.oninitialized = () => fixture.capabilities.push(server.getClientCapabilities() ?? {});
	server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
		const page = options.promptPage ?? PROMPTS.length;
		const start = Number(request.params?.cursor ?? 0);
		const next = start + page;
		return { prompts: PROMPTS.slice(start, next), ...(next < PROMPTS.length ? { nextCursor: String(next) } : {}) };
	});
	server.setRequestHandler(GetPromptRequestSchema, async (request) => {
		if (request.params.name === "hello") return { messages: [{ role: "user", content: { type: "text", text: "Hello from the server." } }] };
		const args = request.params.arguments ?? {};
		return {
			messages: [
				{ role: "user", content: { type: "text", text: `Review this ${args.language ?? "code"}:` } },
				{ role: "user", content: { type: "text", text: String(args.code ?? "") } },
			],
		};
	});
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [{ name: "ask", description: "Asks the user for details", inputSchema: { type: "object", properties: {} } }],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
		/*
		 * 直接发 `elicitation/create`，不走 `elicitInput`：后者在客户端没声明能力时自己就拦下了，
		 * 而「没声明的客户端收到了也要好好回」正是要测的一种情况。
		 */
		const answer = await server.request(
			{ method: "elicitation/create", params: { mode: "form", message: "Who are you?", requestedSchema: FORM_SCHEMA } },
			ElicitResultSchema,
			{ relatedRequestId: extra.requestId, timeout: 60_000 },
		);
		fixture.answers.push(answer);
		return { content: [{ type: "text", text: JSON.stringify(answer) }] };
	});
	return server;
}

export async function startMcpHttpFixture(options: FixtureOptions = {}): Promise<McpHttpFixture> {
	const transports = new Map<string, StreamableHTTPServerTransport>();
	const fixture: McpHttpFixture = { url: "", origin: "", capabilities: [], answers: [], close: async () => {} };
	const http = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", fixture.origin);
		if (options.routes && (await options.routes(req, res, url))) return;
		if (url.pathname !== "/mcp") {
			res.writeHead(404).end();
			return;
		}
		if (options.guard && !(await options.guard(req, res))) return;
		const id = req.headers["mcp-session-id"];
		let transport = typeof id === "string" ? transports.get(id) : undefined;
		if (!transport) {
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				onsessioninitialized: (sessionId) => void transports.set(sessionId, transport!),
			});
			await mcpServer(fixture, options).connect(transport);
		}
		// 门禁读过请求体的（看是不是调工具），把读出来的交给传输层，它不会再读一遍。
		await transport.handleRequest(req, res, (req as IncomingMessage & { body?: unknown }).body);
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const { port } = http.address() as AddressInfo;
	fixture.origin = `http://127.0.0.1:${port}`;
	fixture.url = `${fixture.origin}/mcp`;
	fixture.close = async () => {
		for (const transport of transports.values()) await transport.close().catch(() => {});
		http.closeAllConnections();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	};
	return fixture;
}
