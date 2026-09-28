/**
 * What happens to a parked transcript when its conversation moves on without you.
 *
 * The cache exists so that going back to a conversation you have already read does not flash a
 * skeleton at you. That is right, and it was being applied to conversations that had since said
 * something new: a turn finishing in the background put a green dot on the row, and clicking it
 * showed the transcript from *before* that turn — presented as current, with nothing to say so —
 * until the re-read landed.
 *
 * Events are folded into the parked transcript. Dropping it used to replace stale content
 * with a fresh cold load on every visit; keeping it current avoids both stale replies and flashes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, CommandRun, Message, SessionMeta } from "@plume/core";
import { applyAgentEvent } from "../src/store/apply-event.ts";
import { cachedEvent } from "../src/store/cached-event.ts";
import { nextActivity } from "@plume/core/activity";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const said = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const reply: Message = {
	role: "assistant",
	content: [{ type: "text", text: "好" }],
	api: "anthropic",
	provider: "p",
	model: "m",
	usage,
	stopReason: "stop",
	timestamp: 2,
};

test("automatic compaction completion and failure never settle the agent turn, in either visible or parked sessions", () => {
	const command: CommandRun = { id: "auto", name: "compact", input: "", at: 2, timestamp: 2, status: "running", detail: "summary", automatic: { phase: "retrying", retries: 2 } };
	const meta = { id: "watching" } as SessionMeta;
	let cached = cachedEvent({ meta, messages: [said("first"), reply], toolRuns: {} }, { type: "agent_start", sessionId: "watching" });
	const state = { activity: { watching: "running" }, turns: {}, sessions: [], activeSessionId: "watching", messages: [], toolRuns: {}, commandRuns: [], compactions: [], sessionCache: {}, running: true } as Record<string, unknown>;
	const done: CommandRun = { ...command, status: "done", automatic: { ...command.automatic!, outcome: "fallback" } };
	const events: AgentEvent[] = [
		{ type: "command_status", command },
		{ type: "command_status", command: { ...command, status: "failed" } },
		{ type: "compacted", before: 24, after: 8, summary: "saved", kept: 6, commandId: command.id, command: done },
	];
	for (const event of events) {
		cached = cachedEvent(cached, event);
		applyAgentEvent("watching", event, partial => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial), () => state as never);
		assert.equal(nextActivity(event, "running"), "running");
		assert.equal(cached.state?.running, true);
		assert.equal(state.running, true);
	}
	assert.equal(cached.state?.commandRuns?.length, 1);
	assert.deepEqual(cached.state?.commandRuns?.[0], done);
	assert.deepEqual(state.commandRuns, [done]);
});

/**
 * Dispatch one event for a conversation that is *not* on screen, and report what survived.
 *
 * "other" is the background conversation; "watching" is the one the window has open. Writes are
 * folded back into the state so a handler that reads what it just wrote sees it.
 */
function afterEvent(event: AgentEvent): { parked: boolean; dirty: boolean } {
	const state = {
		activity: {},
		turns: {},
		sessions: [],
		activeSessionId: "watching",
		messages: [],
		toolRuns: {},
		sessionCache: {
			other: { meta: { id: "other" }, messages: [said("旧的")], toolRuns: {} },
		},
	} as Record<string, unknown>;

	applyAgentEvent(
		"other",
		event,
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	const cache = state.sessionCache as Record<string, { dirty?: boolean }>;
	return { parked: "other" in cache, dirty: cache.other?.dirty === true };
}

for (const [name, event] of [
	["a reply starting", { type: "message_start", message: reply }],
	["a reply finishing", { type: "message_end", message: reply }],
	["a tool starting", { type: "tool_start", toolCallId: "t", toolName: "read", args: {} }],
	["a tool finishing", { type: "tool_end", toolCallId: "t", toolName: "read", result: { content: [] } }],
	["history being rewound", { type: "rewound", messageCount: 1 }],
	["history being summarised", { type: "compacted", before: 10, after: 2 }],
] as [string, AgentEvent][]) {
	test(`${name} elsewhere updates the parked transcript without a cold load`, () => {
		assert.deepEqual(afterEvent(event), { parked: true, dirty: true });
	});
}

for (const [name, event] of [
	["a turn starting", { type: "agent_start" }],
	["a title being derived", { type: "title", title: "新名字" }],
	["a queue update", { type: "tasks", tasks: [] }],
	["a notice", { type: "notice", level: "info", message: "嗯" }],
] as [string, AgentEvent][]) {
	test(`${name} elsewhere leaves it parked`, () => {
		// Nothing about the transcript changed, so re-reading it would be work for the same answer —
		// and a skeleton on the way back in for no reason at all.
		assert.equal(afterEvent(event).parked, true);
	});
}

test("a conversation on screen keeps its cache — it is being kept up to date live", () => {
	const state = {
		activity: {},
		turns: {},
		sessions: [],
		activeSessionId: "watching",
		messages: [],
		toolRuns: {},
		pendingUserMessage: null,
		retrying: null,
		turnStartedAt: null,
		turnTokens: 0,
		sessionCache: {
			watching: { meta: { id: "watching" }, messages: [said("旧的")], toolRuns: {} },
		},
	} as Record<string, unknown>;

	applyAgentEvent(
		"watching",
		{ type: "message_start", message: reply },
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	assert.ok("watching" in (state.sessionCache as Record<string, unknown>));
});

test("background command updates stay singular and rewinding retains only earlier command records", () => {
	const meta: SessionMeta = { id: "other", title: "same title", cwd: "/project", projectId: "p", projectName: "p", createdAt: 1, updatedAt: 1, modelId: "m", messageCount: 2, usage };
	const command: CommandRun = { id: "compact-1", name: "compact", input: "/compact", at: 1, timestamp: 2, status: "running", detail: "正在压缩" };
	let cached = cachedEvent({ meta, messages: [said("first"), reply], toolRuns: {} }, { type: "command_status", command });
	assert.equal(cached.state?.running, true);
	cached = cachedEvent(cached, { type: "command_status", command: { ...command, status: "done" } });
	assert.equal(cached.state?.running, false);
	assert.equal(cached.state?.commandRuns?.length, 1);
	cached = cachedEvent(cached, { type: "command_status", command: { ...command, id: "compact-2", at: 2, status: "done" } });
	cached = cachedEvent(cached, { type: "rewound", messageCount: 1 });
	assert.deepEqual(cached.state?.commandRuns?.map((run) => run.id), ["compact-1"]);
	assert.equal(cached.messages.length, 1);
});

test("pendingUserMessage matches its own session and does not clear on events from another session", () => {
	const userMsg: Message = { role: "user", content: [{ type: "text", text: "同样的提问" }], timestamp: 10 };
	const state = {
		activity: {},
		turns: {},
		sessions: [],
		activeSessionId: "session-a",
		messages: [userMsg],
		toolRuns: {},
		pendingUserMessage: { sessionId: "session-a", message: userMsg },
		sessionCache: {},
	} as Record<string, unknown>;

	// Event coming from session-b with the exact same text
	applyAgentEvent(
		"session-b",
		{ type: "message_start", message: { role: "user", content: [{ type: "text", text: "同样的提问" }], timestamp: 10 } },
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	// Should still be pending for session-a
	assert.ok(state.pendingUserMessage !== null);
	assert.equal((state.pendingUserMessage as { sessionId: string }).sessionId, "session-a");

	// Now event comes from session-a
	applyAgentEvent(
		"session-a",
		{ type: "message_start", message: { role: "user", content: [{ type: "text", text: "同样的提问" }], timestamp: 10 } },
		(partial) => Object.assign(state, typeof partial === "function" ? partial(state as never) : partial),
		() => state as never,
	);

	// Now pendingUserMessage is successfully cleared
	assert.equal(state.pendingUserMessage, null);
});
