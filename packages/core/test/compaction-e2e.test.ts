/**
 * Compaction, through a real session.
 *
 * The unit tests cover the cut itself. This one covers the wiring: that a session running near its
 * window actually reaches compaction through the seam, that the summarised history is what the next
 * turn is built from, and that the run says so rather than quietly losing the past.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

// Small enough that a handful of turns overflows it.
const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 2_000,
	maxOutputTokens: 512,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

const SETTINGS: Settings = {
	...DEFAULT_SETTINGS,
	providers: [PROVIDER],
	defaultModelId: MODEL.id,
	mcpServers: [],
	permissionMode: "full",
};

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("a session that overflows its window compacts, and says so", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-"));
	const events: AgentEvent[] = [];
	/** What the provider was asked to answer, per call. */
	const seen: Message[][] = [];

	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: (event) => {
			events.push(event);
		},
		streamFn: async (context) => {
			seen.push([...context.messages]);
			// Long replies, so the window fills in a few turns.
			return reply("回复".repeat(400));
		},
	});
	await session.initialize();

	try {
		for (let i = 0; i < 6; i++) {
			await session.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
		}

		const compacted = events.filter((e) => e.type === "compacted");
		assert.ok(compacted.length >= 1, "compaction happened");

		const event = compacted[0];
		if (event.type !== "compacted") throw new Error("wrong event");
		assert.ok(event.after < event.before, "and it actually made the history smaller");

		// The turn after a compaction is built from the summary, not from the old messages.
		const last = seen[seen.length - 1];
		const text = last
			.flatMap((m) => (m.role === "user" ? m.content : []))
			.map((c) => (c.type === "text" ? c.text : ""))
			.join("\n");
		assert.ok(text.includes("摘要") || last.length < 12, "the history handed over is the condensed one");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("a compaction still applies on the next prompt, rather than being redone from scratch", async () => {
	/*
	 * The failure this exists for, which every other test in the file walked straight past.
	 *
	 * Compaction used to hand a shorter array back to the running loop and stop there. The loop's
	 * array dies with the run — so the next prompt rebuilt its history from the log, which keeps
	 * every original message, and arrived at exactly the size it had been before. It compacted
	 * again, paid for another summary, and ended the turn no smaller than it started.
	 *
	 * From the outside that is a session pinned near its limit: "compacting" on every turn, the
	 * percentage never moving. Nothing about the cut itself was wrong, which is why unit tests on
	 * the cut all passed while the window stayed full.
	 *
	 * The claim has to be stated carefully, because the obvious version of it does not test
	 * anything. "The last request is shorter than the log" passes either way: the loop compacts
	 * in-memory before every request, so of course what goes out is small. What was broken is that
	 * the *work* was thrown away — so the test is that a compacted session, given one short prompt,
	 * does not compact all over again. Under the old behaviour it must, because it starts from the
	 * full log every time; under the fixed one there is nothing left to do.
	 */
	const root = await mkdtemp(join(tmpdir(), "ly-compact-keep-"));
	const seen: Message[][] = [];
	const events: AgentEvent[] = [];

	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: (event) => {
			events.push(event);
		},
		streamFn: async (context) => {
			seen.push([...context.messages]);
			return reply("回复".repeat(400));
		},
	});
	await session.initialize();

	try {
		for (let i = 0; i < 6; i++) {
			await session.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
		}
		const count = () => events.filter((e) => e.type === "compacted").length;
		const before = count();
		assert.ok(before >= 1, "precondition: the window filled and compaction ran");

		/*
		 * A short prompt, so nothing about it could push the conversation over on its own. Whatever
		 * happens next is a consequence of what the session believes its history to be.
		 */
		await session.prompt([{ type: "text", text: "再来一个" }]);

		assert.equal(
			count(),
			before,
			`a session that has already been compacted does not compact again on the next short prompt (${count() - before} extra passes)`,
		);

		// And the request that went out really was the condensed history.
		const last = seen[seen.length - 1];
		assert.ok(
			last.length < session.messages.length,
			`built from the summary and the tail (${last.length} sent, ${session.messages.length} in the log)`,
		);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("reopening a compacted session does not hand the model its whole history back", async () => {
	/*
	 * The same fact, across a restart. The boundary is stored in the log beside the summary, so a
	 * session read back from disk knows where the model's view begins — otherwise every reopen
	 * starts over the window and pays for a summary to get back to where it already was.
	 */
	const root = await mkdtemp(join(tmpdir(), "ly-compact-reopen-"));
	const store = new SessionStore(join(root, "sessions"));
	const seen: Message[][] = [];
	const reopenedEvents: AgentEvent[] = [];

	const first = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store,
		emit: () => {},
		streamFn: async () => reply("回复".repeat(400)),
	});
	await first.initialize();

	try {
		for (let i = 0; i < 6; i++) {
			await first.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
		}

		const loaded = await store.load(first.meta.id);
		assert.ok(loaded, "the session is on disk");
		if (!loaded) return;
		assert.ok(loaded.compaction, "and the boundary was written down with it");

		const reopened = new AgentSession({
			cwd: root,
			settings: SETTINGS,
			store,
			meta: loaded.meta,
			emit: (event) => {
				reopenedEvents.push(event);
			},
			streamFn: async (context) => {
				seen.push([...context.messages]);
				return reply("好");
			},
		});
		reopened.restore(loaded.messages, loaded.compaction);
		await reopened.initialize();

		await reopened.prompt([{ type: "text", text: "接着来" }]);

		/*
		 * Nothing to compact, because the boundary came back with the messages. Without it the
		 * reopened session starts over its window and pays for a summary to reach a state it was
		 * already in when it was closed.
		 */
		assert.equal(
			reopenedEvents.filter((e) => e.type === "compacted").length,
			0,
			"a reopened session is already inside its window",
		);

		const sent = seen[seen.length - 1];
		assert.ok(
			sent.length < loaded.messages.length,
			`it sends the summary and the tail (${sent.length}), not the full transcript (${loaded.messages.length})`,
		);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
test("session.compact() uses @compact model when configured", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-role-"));
	// Keep automatic pressure out of a test for explicit model routing, including prompt/schema overhead.
	const manualModel = { ...MODEL, contextWindow: 200_000 };
	const compactModel: ModelConfig = {
		...manualModel,
		id: "fake/compact-model",
		modelId: "compact-model",
		name: "Compact Spec",
	};
	const providerWithCompact: ProviderConfig = {
		...PROVIDER,
		models: [manualModel, compactModel],
	};
	const settingsWithCompact: Settings = {
		...SETTINGS,
		providers: [providerWithCompact],
		subAgentProfiles: { compact: { modelId: compactModel.id } },
	};

	let calledConfig: { provider: string; model: string } | undefined;

	const session = new AgentSession({
		cwd: root,
		settings: settingsWithCompact,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (_context, config) => {
			calledConfig = { provider: config.provider.id, model: config.model.modelId };
			return reply("这是紧凑摘要");
		},
	});
	await session.initialize();

	try {
		for (let i = 0; i < 12; i++) {
			await session.prompt([{ type: "text", text: `问题 ${i}: ${"详细说明系统设计与边界要求".repeat(30)}` }]);
		}

		const res = await session.compact();
		assert.ok(res.ok, `session compact should succeed: ${JSON.stringify(res)}`);
		assert.equal(calledConfig?.model, "compact-model", "compact() should ask the @compact model");
		assert.equal(calledConfig?.provider, "fake");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("session.compact() falls back to session model when @compact is not configured", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-fallback-"));
	const manualSettings = { ...SETTINGS, providers: [{ ...PROVIDER, models: [{ ...MODEL, contextWindow: 200_000 }] }] };
	let calledConfig: { provider: string; model: string } | undefined;

	const session = new AgentSession({
		cwd: root,
		settings: manualSettings,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (_context, config) => {
			calledConfig = { provider: config.provider.id, model: config.model.modelId };
			return reply("会话模型自身摘要");
		},
	});
	await session.initialize();

	try {
		for (let i = 0; i < 12; i++) {
			await session.prompt([{ type: "text", text: `问题 ${i}: ${"详细说明系统设计与边界要求".repeat(30)}` }]);
		}

		const res = await session.compact();
		assert.ok(res.ok, `session compact should succeed: ${JSON.stringify(res)}`);
		assert.equal(calledConfig?.model, MODEL.modelId, "should fall back to current session model");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

/** Every `usage` record written to the session database under `sessions/`, whichever session it is in. */
async function usageRecords(root: string): Promise<Array<{ source: string; modelId: string; usage: { input: number; output: number } }>> {
	const store = new SessionStore(join(root, "sessions"));
	const out = [];
	for (const meta of await store.listSessions()) {
		for await (const record of store.read(meta.id)) if (record.type === "usage") out.push(record);
	}
	return out;
}

/** A summary request carries no tools; a conversation turn always does. */
function billedSummary(): (context: unknown, config: { tools: unknown[] }) => Promise<AssistantMessage> {
	return async (_context, config) => {
		if (config.tools.length > 0) return reply("回复".repeat(400));
		return { ...reply("这是摘要"), usage: { ...emptyUsage(), input: 1_234, output: 56, total: 1_290 } };
	};
}

test("an automatic compaction's summary is billed to the session", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-bill-"));
	const session = new AgentSession({ cwd: root, settings: SETTINGS, store: new SessionStore(join(root, "sessions")), emit: () => {}, streamFn: billedSummary() });
	await session.initialize();
	try {
		for (let i = 0; i < 6; i++) {
			await session.prompt([{ type: "text", text: `第 ${i} 个问题${"，说详细些".repeat(60)}` }]);
		}
		const billed = (await usageRecords(root)).filter((record) => record.source === "compaction");
		assert.ok(billed.length >= 1, "the summary call left a usage record");
		assert.equal(billed[0].modelId, "model");
		assert.equal(billed[0].usage.input, 1_234);
		assert.ok(session.meta.usage.input >= 1_234, "and the session's own total includes it");
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});

test("a manual /compact is billed to the session", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-compact-bill-manual-"));
	const settings: Settings = { ...SETTINGS, providers: [{ ...PROVIDER, models: [{ ...MODEL, contextWindow: 200_000 }] }] };
	const session = new AgentSession({ cwd: root, settings, store: new SessionStore(join(root, "sessions")), emit: () => {}, streamFn: billedSummary() });
	await session.initialize();
	try {
		for (let i = 0; i < 12; i++) {
			await session.prompt([{ type: "text", text: `问题 ${i}: ${"详细说明系统设计与边界要求".repeat(30)}` }]);
		}
		assert.deepEqual(await usageRecords(root), [], "nothing billed before compacting");
		const res = await session.compact();
		assert.ok(res.ok, JSON.stringify(res));
		const billed = await usageRecords(root);
		assert.equal(billed.length, 1);
		assert.equal(billed[0].source, "compaction");
		assert.equal(billed[0].usage.output, 56);
	} finally {
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
