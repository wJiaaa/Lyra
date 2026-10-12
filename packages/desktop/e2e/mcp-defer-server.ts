/**
 * `core/test/mcp-catalog-fixture.ts` 里的一台服务器，作为真的 stdio MCP 服务器跑起来：工具表照搬，
 * 调用只回一句 ok 并把参数原样写回去。`FIXTURE_SERVER` 选哪一台。给 `mcp-search-demo.ts` 用。
 *
 * 用 `node <本文件>` 起（Node 24 自己会剥类型）。
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FIXTURE_SERVERS } from "../../core/test/mcp-catalog-fixture.ts";

const fixture = FIXTURE_SERVERS.find((one) => one.id === process.env.FIXTURE_SERVER);
if (!fixture) throw new Error(`No fixture server "${process.env.FIXTURE_SERVER}"`);

const server = new Server({ name: fixture.id, version: "0.0.0", description: fixture.description }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: fixture.tools }));
server.setRequestHandler(CallToolRequestSchema, (request) => ({
	content: [{ type: "text", text: `ok: ${fixture.name} ${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}` }],
}));
await server.connect(new StdioServerTransport());
