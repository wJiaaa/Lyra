import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeConnection, pairingCode, parsePairingCode } from "../src/connection.ts";
import { applySessionEvent } from "../src/session-event.ts";
import type { SessionSnapshot } from "../src/types.ts";

test("配对只接受根 HTTP 地址，凭据不进入 WebSocket URL", () => {
	const connection = normalizeConnection("192.168.1.2:4517", " pair-token ");
	assert.deepEqual(parsePairingCode(pairingCode(connection)), connection);
	assert.equal(connection.url, "http://192.168.1.2:4517");
	for (const url of ["file:///tmp", "http://user:password@host", "https://host/other", "https://host/?token=x"]) assert.throws(() => normalizeConnection(url, "token"));
	assert.throws(() => normalizeConnection("http://host", ""));
	assert.throws(() => parsePairingCode("other://pair?url=http://host&token=x"));
});

test("快照与流事件交错时不重复消息，也不丢失后台授权", () => {
	let state = { meta: { id: "session" }, messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "hello" }] }], running: false, pendingApprovals: [] } as unknown as SessionSnapshot;
	state = applySessionEvent(state, { type: "message_start", message: state.messages[0]! });
	assert.equal(state.messages.length, 1);
	state = applySessionEvent(state, { type: "agent_start", sessionId: "session" });
	state = applySessionEvent(state, { type: "approval_request", requestId: "ask", toolCallId: "tool", kind: "bash", title: "Run?", detail: "pwd", subject: "pwd" });
	assert.equal(state.pendingApprovals[0]?.title, "Run?");
	state = applySessionEvent(state, { type: "agent_end", reason: "done" });
	assert.equal(state.running, false);
	assert.equal(state.pendingApprovals.length, 1);
	state = applySessionEvent(state, { type: "approval_settled", requestId: "ask" });
	assert.equal(state.pendingApprovals.length, 0);
});
