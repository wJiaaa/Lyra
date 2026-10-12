import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpServerConfig, McpServerStatus } from "@plume/core";
import { mcpStatusFor } from "../electron/mcp-probe.ts";

const server: McpServerConfig = { id: "s", name: "S", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: true };
const status = (state: McpServerStatus["state"], extra: Partial<McpServerStatus> = {}): McpServerStatus => ({ id: "s", name: "S", transport: "http", state, ...extra });

test("设置页报会话手上的那条连接：重连中、断了只在那里看得见", async () => {
	const held = [status("connected", { toolCount: 2 }), status("reconnecting", { attempt: 3 }), status("connected", { id: "other" })];
	assert.deepEqual(await mcpStatusFor(server, held), status("reconnecting", { attempt: 3 }));
	assert.equal((await mcpStatusFor(server, [status("connected"), status("failed", { error: "x" })])).state, "failed");
	assert.equal((await mcpStatusFor(server, [status("connecting"), status("connected")])).state, "connecting");
});

test("没有会话连着这台服务器时才去探测", async () => {
	// 9 号端口没人听：探测连不上，报的是探测自己的失败，而不是别的服务器的状态。
	const probed = await mcpStatusFor(server, [status("connected", { id: "other" }), status("disabled")]);
	assert.equal(probed.state, "failed");
});
