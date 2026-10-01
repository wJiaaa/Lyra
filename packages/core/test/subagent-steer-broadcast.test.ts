/**
 * Steering a sub-agent has to be *announced*, not just recorded.
 *
 * This is a regression test for a bug that every other test in this feature missed, and that only
 * showed up when the thing was actually used: `steer` pushed the message into the sub-agent's
 * history and fired the registry's change callback — but that callback broadcasts the *roster*, and
 * the roster carries no transcripts. So the message was delivered to the model and invisible in the
 * window: you typed, the box cleared, nothing appeared, and the sub-agent's reply arrived later as
 * an answer to a question that was never on screen.
 *
 * The registry tests passed (the message was in `messages`), and the renderer tests passed (given
 * the event, the transcript updates). Nothing covered the one line between them, which is exactly
 * where it was broken. So this asserts the seam itself: steering emits `subagent_message`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentSession } from "../src/runtime/session.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import type { SessionMeta } from "../src/types.ts";

const META: SessionMeta = {
	id: "s1",
	projectId: "p1",
	cwd: "/tmp",
	title: "t",
	createdAt: 0,
	updatedAt: 0,
	messageCount: 0,
	modelId: "fake/model",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as SessionMeta;

/** Enough storage for a session to be constructed; nothing here writes anything. */
const store = {
	create: async () => META,
	append: async (meta: SessionMeta) => meta,
	async *read() {},
	messages: async () => [],
	load: async () => null,
	listSessions: async () => [],
	rebuildIndex: async () => [],
	truncateFrom: async () => null,
} as never;

function session(emit: (event: AgentEvent) => void) {
	return new AgentSession({
		cwd: "/tmp",
		settings: { permissionMode: "ask", alwaysAllow: [], thinking: "off" } as never,
		store,
		meta: META,
		emit: async (event) => emit(event),
	});
}

test("steering a running sub-agent emits the message, so a window can show it", async () => {
	const events: AgentEvent[] = [];
	const agent = session((event) => events.push(event));
	agent.subAgents.start({ id: "sub1", agent: "explore", description: "找一处代码", abort: () => {} });
	events.length = 0;

	assert.equal(await agent.steerSubAgent("sub1", "别看测试目录"), true);

	const message = events.find((event) => event.type === "subagent_message");
	assert.ok(message, `no subagent_message was emitted; got ${events.map((e) => e.type).join(", ")}`);
	assert.equal(message.type === "subagent_message" && message.id, "sub1", "carrying which sub-agent it was said to");
	assert.equal(
		message.type === "subagent_message" && (message.message.content[0] as { text: string }).text,
		"别看测试目录",
	);
});

test("steering a finished sub-agent emits nothing and says it failed", async () => {
	// Emitting here would put a message in the pane for something that will never read it.
	const events: AgentEvent[] = [];
	const agent = session((event) => events.push(event));
	agent.subAgents.start({ id: "sub1", agent: "explore", description: "x", abort: () => {} });
	agent.subAgents.finish("sub1", { status: "done", answer: "" });
	events.length = 0;

	assert.equal(await agent.steerSubAgent("sub1", "再看看"), false);
	assert.equal(
		events.some((event) => event.type === "subagent_message"),
		false,
	);
});

test("stopping the session stops the sub-agents it dispatched", () => {
	// Otherwise they run on past the session that owns them, spending tokens with nothing able to
	// reach them — no window, no parent, no way to stop them short of quitting the app.
	let stopped = false;
	const agent = session(() => {});
	agent.subAgents.start({
		id: "sub1",
		agent: "explore",
		description: "x",
		abort: () => {
			stopped = true;
		},
	});

	agent.abort();

	assert.equal(stopped, true);
});
