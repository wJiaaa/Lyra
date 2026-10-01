/**
 * Reading spend out of the session database.
 *
 * The incremental cache is the part that can be quietly wrong: it reads on from the last row it
 * folded in, so a mistake there does not throw — it double-counts a day, or silently stops counting
 * a conversation that is still being written to. Every test here writes through the store the way
 * the app does and then checks the totals against what was written.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { SessionStore, type AssistantMessage, type Message, type ProviderConfig, type SessionMeta } from "@plume/core";
import { scanUsage } from "../electron/usage-scan.ts";

let home = "";
let store: SessionStore;
/** What `Date.now()` answers while a test writes: records are stamped with it, and activity is counted by it. */
let clock = 0;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-usage-"));
	store = new SessionStore(join(home, "sessions"));
	clock = AT;
	mock.method(Date, "now", () => clock);
});

afterEach(async () => {
	mock.restoreAll();
	store.close();
	await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

const AT = new Date(2026, 8, 1, 10, 0).getTime();
const NEXT_DAY = new Date(2026, 8, 2, 10, 0).getTime();

const scan = (providers: ProviderConfig[] = []) => scanUsage(store, home, providers);

function user(at: number): Message {
	return { role: "user", content: [], timestamp: at };
}

function reply(at: number, over: { provider?: string; model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: number } = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: over.provider ?? "relay",
		model: over.model ?? "gemini-3.7",
		stopReason: "stop",
		usage: {
			input: over.input ?? 100,
			output: over.output ?? 20,
			cacheRead: over.cacheRead ?? 0,
			cacheWrite: over.cacheWrite ?? 0,
			reasoning: over.reasoning ?? 0,
			total: (over.input ?? 100) + (over.output ?? 20),
			cost: { total: over.cost ?? 0.25 },
		} as AssistantMessage["usage"],
		timestamp: at,
	};
}

/** A conversation, and a way to say things into it at a given time. */
async function conversation(): Promise<{ meta: SessionMeta; say(message: Message, at?: number): Promise<void>; record(payload: Parameters<SessionStore["append"]>[1], at?: number): Promise<void> }> {
	const meta = await store.create("/tmp/proj-a", "relay/gemini-3.7");
	const record = async (payload: Parameters<SessionStore["append"]>[1], at = AT) => {
		clock = at;
		await store.append(meta, payload);
	};
	return { meta, record, say: (message, at = message.timestamp) => record({ type: "message", message }, at) };
}

function pricedProvider(price: number, baseUrl = "https://relay.example/v1"): ProviderConfig {
	return {
		id: "relay",
		name: "Relay",
		baseUrl,
		api: "openai-responses",
		apiKey: "",
		enabled: true,
		models: [{
			id: "relay/gemini-3.7",
			providerId: "relay",
			modelId: "gemini-3.7",
			name: "Gemini",
			contextWindow: 1_000_000,
			maxOutputTokens: 100_000,
			supportsThinking: true,
			supportsImages: true,
			supportsTools: true,
			pricing: { input: price, output: price * 2, cacheRead: price / 10, cacheWrite: price * 1.25, source: "manual" },
		}],
	};
}

describe("scanUsage", () => {
	it("an empty home is zeroes, not a failure", async () => {
		const result = await scan();
		assert.deepEqual(result.days, []);
		assert.deepEqual(result.buckets, []);
	});

	it("totals one conversation by day and by model", async () => {
		const s1 = await conversation();
		await s1.say(user(AT));
		await s1.say(reply(AT, { input: 100, output: 20, cost: 0.25 }));
		await s1.record({ type: "event", event: { type: "context", systemPrompt: "x", tools: [] } as never });
		const result = await scan();

		assert.equal(result.days.length, 1);
		assert.equal(result.days[0].day, "2026-09-01");
		assert.equal(result.days[0].messages, 2, "both sides count as messages");
		assert.equal(result.days[0].sessions, 1);

		assert.equal(result.buckets.length, 1);
		assert.equal(result.buckets[0].key, "relay/gemini-3.7");
		assert.equal(result.buckets[0].input, 100);
		assert.equal(result.buckets[0].output, 20);
		assert.equal(result.buckets[0].cost, 0.25);
		assert.equal(result.buckets[0].recordedPricedTokens, 120);
		assert.equal(result.buckets[0].replies, 1);
	});

	it("counts spend outside any conversation as cost, never as a conversation", async () => {
		const s1 = await conversation();
		await s1.say(user(AT));
		await s1.say(reply(AT, { input: 100, output: 20, cost: 0.25 }));
		await store.recordUsage({ source: "memory-extract", providerId: "relay", modelId: "gemini-3.7", usage: { input: 900, output: 30, cacheRead: 0, cacheWrite: 0, total: 930, cost: { total: 0.5 } } as never });
		const result = await scan();

		assert.equal(result.days.length, 1);
		assert.equal(result.days[0].sessions, 1, "the memory pass is not an active conversation");
		assert.equal(result.days[0].messages, 2);
		assert.equal(result.buckets.length, 1);
		assert.equal(result.buckets[0].input, 1_000);
		assert.equal(result.buckets[0].cost, 0.75);
	});

	it("estimates old zero-cost replies from an exact configured model price", async () => {
		await (await conversation()).say(reply(AT, { input: 100, output: 100, cacheRead: 900, cost: 0 }));
		const bucket = (await scan([pricedProvider(1)])).buckets[0];
		// Fresh tokens (100 + 100), not the 1100 that crossed the wire: this figure is shown as a
		// share of the page's total, which excludes cache reads.
		assert.equal(bucket.manualPricedTokens, 200);
		assert.ok(Math.abs(bucket.cost - 0.00039) < 1e-12);
		assert.ok(Math.abs(bucket.rawCost - 0.0012) < 1e-12);
		assert.ok(Math.abs(bucket.cacheSavings - 0.00081) < 1e-12);
	});

	it("uses a catalogue reference for both official endpoints and relays", async () => {
		await (await conversation()).say(reply(AT, { provider: "openai-local", model: "gpt-5.2", input: 1_000_000, output: 0, cost: 0 }));
		const official: ProviderConfig = { ...pricedProvider(1, "https://api.openai.com/v1"), id: "openai-local", models: [] };
		const priced = await scan([official]);
		assert.equal(priced.buckets[0].catalogPricedTokens, 1_000_000);
		assert.equal(priced.buckets[0].cost, 1.75);

		const relay = { ...official, baseUrl: "https://relay.example/v1" };
		const reference = await scan([relay]);
		assert.equal(reference.buckets[0].catalogPricedTokens, 1_000_000);
		assert.equal(reference.buckets[0].unpricedTokens, 0);
		assert.equal(reference.buckets[0].cost, 1.75);
	});

	it("invalidates the cache when configured prices change", async () => {
		await (await conversation()).say(reply(AT, { input: 1_000_000, output: 0, cost: 0 }));
		const first = await scan([pricedProvider(1)]);
		assert.equal(first.buckets[0].cost, 1);

		const second = await scan([pricedProvider(2)]);
		assert.equal(second.scanned, 1, "a price change must re-evaluate what was already read");
		assert.equal(second.cached, 0);
		assert.equal(second.buckets[0].cost, 2);
	});

	it("title request usage reaches model totals without inflating conversation messages", async () => {
		const s1 = await conversation();
		await s1.say(user(AT));
		await s1.say(reply(AT));
		await scan();
		await s1.record({ type: "usage", source: "title-summary", providerId: "fast-provider", modelId: "fast-model", usage: { input: 80, output: 8, cacheRead: 0, cacheWrite: 0, total: 88, cost: { total: 0.003 } } as never });
		const result = await scan();
		assert.equal(result.days[0].messages, 2);
		const title = result.buckets.find((bucket) => bucket.key === "fast-provider/fast-model");
		assert.equal(title?.input, 80);
		assert.equal(title?.output, 8);
		assert.equal(title?.cost, 0.003);
		assert.equal(title?.replies, 1);
		assert.deepEqual((await scan()).buckets, result.buckets, "cached scans must not charge the request twice");
	});

	it("a conversation spanning two days is split across them", async () => {
		const s1 = await conversation();
		await s1.say(reply(AT, { input: 10 }));
		await s1.say(reply(NEXT_DAY, { input: 90 }));
		const result = await scan();

		assert.deepEqual(result.buckets.map((b) => [b.day, b.input]), [
			["2026-09-01", 10],
			["2026-09-02", 90],
		]);
		assert.deepEqual(result.days.map((d) => d.day), ["2026-09-01", "2026-09-02"]);
		assert.equal(result.days[0].sessions, 1, "and counts as active on both");
		assert.equal(result.days[1].sessions, 1);
	});

	it("two models on one day are two buckets", async () => {
		const s1 = await conversation();
		await s1.say(reply(AT, { model: "a", input: 10 }));
		await s1.say(reply(AT, { model: "b", input: 20 }));
		assert.deepEqual((await scan()).buckets.map((b) => b.key).sort(), ["relay/a", "relay/b"]);
	});

	it("two conversations on one day are two active sessions", async () => {
		await (await conversation()).say(reply(AT));
		await (await conversation()).say(reply(AT));
		const result = await scan();
		assert.equal(result.days[0].sessions, 2);
		assert.equal(result.buckets[0].replies, 2, "and their tokens are merged into one bucket");
	});

	it("a second scan with nothing new reads nothing", async () => {
		await (await conversation()).say(reply(AT));
		const first = await scan();
		assert.equal(first.scanned, 1);

		const second = await scan();
		assert.equal(second.scanned, 0, "nothing changed, so nothing was read");
		assert.equal(second.cached, 1);
		assert.deepEqual(second.buckets, first.buckets, "and the answer is the same");
	});

	it("a table longer than one read is folded a page at a time, all of it", async () => {
		const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, cost: { total: 0 } } as never;
		for (let i = 0; i < 5_001; i++) await store.recordUsage({ source: "memory-extract", providerId: "relay", modelId: "gemini-3.7", usage });
		const reads = mock.method(store, "readSpend");
		const result = await scan();
		assert.equal(result.scanned, 5_001);
		assert.equal(reads.mock.callCount(), 3, "two pages and the empty one that ends them, not one array of everything");
		assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.input, 0), 5_001);
	});

	it("an appended turn is counted once, not twice", async () => {
		const s1 = await conversation();
		await s1.say(reply(AT, { input: 100 }));
		await scan();

		await s1.say(reply(AT, { input: 5 }));
		const result = await scan();

		assert.equal(result.scanned, 1, "only the new reply was read");
		assert.equal(result.buckets[0].input, 105, "the old turn is not re-counted");
		assert.equal(result.buckets[0].replies, 2);
	});

	it("a new conversation is picked up without disturbing the cached ones", async () => {
		await (await conversation()).say(reply(AT, { input: 100 }));
		await scan();

		await (await conversation()).say(reply(AT, { input: 50 }));
		const result = await scan();
		assert.equal(result.cached, 1);
		assert.equal(result.scanned, 1);
		assert.equal(result.buckets[0].input, 150);
		assert.equal(result.days[0].sessions, 2);
	});

	it("a deleted conversation's spend stays counted, and its activity goes with it", async () => {
		await (await conversation()).say(reply(AT, { input: 100 }));
		const s2 = await conversation();
		await s2.say(reply(AT, { input: 50 }));
		await scan();

		await store.delete(s2.meta.id);
		assert.equal((await scan()).buckets[0].input, 150, "what was billed does not un-happen");
		assert.equal((await scan()).days[0].sessions, 1);
		await rm(join(home, "usage-cache.json"));
		assert.equal((await scan()).buckets[0].input, 150, "and not only because the cache remembered it");
	});

	it("a database moved aside and started over is read from its own first row, not the old cursor", async () => {
		await (await conversation()).say(reply(AT, { input: 100 }));
		await (await conversation()).say(reply(AT, { input: 50 }));
		assert.equal((await scan()).buckets[0].input, 150);

		// What someone does with a database that will not open: move it away and let a new one start.
		store.close();
		await rm(join(home, "sessions"), { recursive: true, force: true });
		store = new SessionStore(join(home, "sessions"));
		await (await conversation()).say(reply(AT, { input: 7 }));
		const result = await scan();
		assert.equal(result.buckets[0].input, 7, "the new database's first row is counted, and the old totals are gone");
		assert.equal(result.cached, 0);
	});

	it("a rewind does not take back what the rewound replies cost", async () => {
		const s1 = await conversation();
		await s1.say(user(AT));
		await s1.say(reply(AT, { input: 100 }));
		await s1.record({ type: "truncate", afterSeq: 1 });
		assert.equal((await scan()).buckets[0].input, 100);
	});

	it("side-chat auxiliary usage is recorded as auxiliary spend without inflating message count", async () => {
		await (await conversation()).record({ type: "usage", source: "side-chat", providerId: "relay", modelId: "gemini-3.7", usage: { input: 300, output: 50, cacheRead: 200, cacheWrite: 0, reasoning: 0, total: 350, cost: { total: 0 } } as never });
		const result = await scan();
		assert.equal(result.days[0].messages, 0, "auxiliary usage does not count as conversational message");
		assert.equal(result.buckets[0].input, 300);
		assert.equal(result.buckets[0].cacheRead, 200);
	});

	it("cache misses are diagnosed per request, attributed to compaction, and resumed across scans", async () => {
		const at = (n: number) => AT + n * 1000;
		const s1 = await conversation();
		await s1.say(reply(at(0), { input: 5000 }));
		// 前缀全部读到：命中。
		await s1.say(reply(at(1), { input: 200, cacheRead: 5000 }));
		await s1.record({ type: "event", event: { type: "compacted" } as never }, at(2));
		// 压缩之后前缀重写，上一次的 5200 都没读到。
		await s1.say(reply(at(3), { input: 6000 }));
		const first = await scan();
		assert.deepEqual(first.buckets[0].cacheMiss, { tokens: 5200, cost: 0, unpriced: 5200, byCause: { compaction: 5200 } });

		// 又来了一次，从上次停下的地方接着诊断：上一次的 6000 该读到而没读到，没有边界，原因不明。
		await s1.say(reply(at(4), { input: 7000 }));
		const next = await scan();
		assert.equal(next.scanned, 1);
		assert.deepEqual(next.buckets[0].cacheMiss?.byCause, { compaction: 5200, unknown: 6000 });
	});

	it("a sub-agent is its own request stream, not a continuation of the main one", async () => {
		const s1 = await conversation();
		await s1.say(reply(AT, { input: 5000, cacheRead: 100 }));
		await s1.record({ type: "event", event: { type: "subagent_message", id: "a1", message: reply(AT + 1, { input: 3000 }) } }, AT + 1);
		await s1.say(reply(AT + 2, { input: 100, cacheRead: 5100 }));
		assert.equal((await scan()).buckets[0].cacheMiss, undefined, "子代理的第一次请求是冷启动，主会话前后两次都命中");
	});
});
