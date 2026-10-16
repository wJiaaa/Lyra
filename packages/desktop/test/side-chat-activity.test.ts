/**
 * 侧边聊天跑完不留「完成」标记。
 *
 * 它不在会话列表上：标记留着，通知里就多一条只有「新对话」的行，点下去是「会话不存在」，标记
 * 永远清不掉，侧栏切换按钮上的圆点也跟着一直亮。还在跑的那一段要留着，行首靠它亮。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { AgentEvent, SessionMeta } from "@plume/core";
import { useSide } from "../src/features/dock/sideStore.ts";
import { applyAgentEvent } from "../src/store/apply-event.ts";
import { unreadActivity } from "../src/lib/session-notifications.ts";

// 后台会话收尾时会去重读会话列表；这里只关心 activity。
(globalThis as { plume?: unknown }).plume = { sessions: { list: async () => [] } };

const side = { id: "side-1", parentId: "main", sideId: "panel-1", seq: 1 } as SessionMeta;

function fold(state: Record<string, unknown>, sessionId: string, event: AgentEvent) {
	applyAgentEvent(sessionId, event, (partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial), () => state as never);
}

function freshState(): Record<string, unknown> {
	return { activity: {}, turns: {}, sessions: [], activeSessionId: "main", messages: [], toolRuns: {}, commandRuns: [], compactions: [], sessionCache: {}, queued: {}, running: false, notify: () => {}, flushQueue: () => {} };
}

beforeEach(() => {
	useSide.setState({ sides: {} });
	useSide.getState().noteSide(side);
});

test("a side chat is marked running while it answers, and leaves no mark once it finishes or fails", () => {
	for (const reason of ["done", "error"] as const) {
		const state = freshState();
		fold(state, side.id, { type: "agent_start" } as AgentEvent);
		assert.equal((state.activity as Record<string, string>)[side.id], "running");
		fold(state, side.id, { type: "agent_end", reason } as AgentEvent);
		assert.deepEqual(state.activity, {});
		assert.equal(unreadActivity(state.activity as never, "main"), null);
	}
});

test("a background conversation that is not a side chat still finishes unread", () => {
	const state = freshState();
	fold(state, "other", { type: "agent_start" } as AgentEvent);
	fold(state, "other", { type: "agent_end", reason: "done" } as AgentEvent);
	assert.deepEqual(state.activity, { other: "done" });
	assert.equal(unreadActivity(state.activity as never, "main"), "done");
});
