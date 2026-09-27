import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseCache, summarizeCacheDiagnoses } from "../src/runtime/cache-diagnostics.ts";
import { emptyUsage, type AssistantMessage, type Message, type Usage } from "../src/types/message.ts";

const MINUTE = 60_000;
const RATES = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

function request(at: number, usage: Partial<Usage>, over: Partial<AssistantMessage> = {}): AssistantMessage {
	const base = emptyUsage();
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-chat-completions",
		provider: "relay",
		model: "m1",
		stopReason: "stop",
		timestamp: at,
		...over,
		usage: { ...base, ...usage, cost: { ...base.cost, rates: RATES } },
	};
}

const user = (text = "go"): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

describe("cache diagnostics", () => {
	it("treats the first request as a cold start and a stable prefix as a hit", () => {
		const out = diagnoseCache([
			user(),
			request(0, { input: 8_000, cacheRead: 0 }),
			user(),
			// 前缀 8,000 里读到 7,936：64 token 的粒度差，不算打断
			request(10_000, { input: 2_064, cacheRead: 7_936 }),
		]);
		assert.deepEqual(out.map((d) => [d.ordinal, d.index, d.cause, d.expected, d.missed]), [
			[1, 1, "first", 0, 0],
			[2, 3, "hit", 8_000, 0],
		]);
	});

	it("blames an idle gap past the TTL, and a warm miss on a changed prefix", () => {
		const out = diagnoseCache([
			request(0, { input: 1_000, cacheRead: 19_000 }),
			request(6 * MINUTE, { input: 21_000, cacheRead: 0 }),
			request(6 * MINUTE + 5_000, { input: 16_000, cacheRead: 6_000 }),
		]);
		assert.equal(out[1].cause, "idle");
		assert.equal(out[1].missed, 20_000);
		assert.equal(out[1].idleMs, 6 * MINUTE);
		// 按实付单价 1 而非缓存读单价 0.1 计：20,000 × 0.9 / 1M
		assert.ok(Math.abs(out[1].extraCost! - 0.018) < 1e-12);
		assert.equal(out[2].cause, "unknown");
		assert.equal(out[2].missed, 21_000 - 6_000);
	});

	it("takes the TTL a provider declares instead of the default", () => {
		const messages = [request(0, { input: 1_000, cacheRead: 19_000 }), request(6 * MINUTE, { input: 21_000, cacheRead: 0 })];
		assert.equal(diagnoseCache(messages, { ttlMs: () => 60 * MINUTE })[1].cause, "unknown");
		assert.equal(diagnoseCache(messages, { ttlMs: () => undefined })[1].cause, "idle");
	});

	it("attributes a miss after switching model or provider to the switch", () => {
		const out = diagnoseCache([
			request(0, { input: 1_000, cacheRead: 9_000 }),
			request(1_000, { input: 11_000, cacheRead: 0 }, { model: "m2" }),
			request(2_000, { input: 12_000, cacheRead: 0 }, { provider: "other", model: "m2" }),
		]);
		assert.deepEqual(out.map((d) => d.cause), ["first", "model", "model"]);
		assert.equal(out[1].missed, 10_000);
	});

	it("does not count the first request after a compaction or rewind boundary as a broken prefix", () => {
		const messages: Message[] = [
			user(),
			request(0, { input: 2_000, cacheRead: 48_000 }),
			user(),
			request(1_000, { input: 12_000, cacheRead: 3_000 }),
			user(),
			request(2_000, { input: 500, cacheRead: 15_000 }),
			user(),
			request(3_000, { input: 9_000, cacheRead: 3_000 }),
		];
		const out = diagnoseCache(messages, { boundaries: [{ at: 2, kind: "compaction" }, { at: 6, kind: "rewind" }] });
		assert.deepEqual(out.map((d) => d.cause), ["first", "compaction", "hit", "rewind"]);
		assert.equal(out[1].missed, 15_000 - 3_000);
		// 边界只对它之后的第一次请求有效
		assert.equal(diagnoseCache(messages)[1].cause, "unknown");
	});

	it("reads a total miss on a provider that only reports cacheRead, once it has reported caching at all", () => {
		const out = diagnoseCache([
			request(0, { input: 10_000, cacheRead: 0, cacheWrite: 0 }),
			request(1_000, { input: 2_000, cacheRead: 9_984, cacheWrite: 0 }),
			request(2_000, { input: 13_000, cacheRead: 0, cacheWrite: 0 }),
		]);
		assert.deepEqual(out.map((d) => d.cause), ["first", "hit", "unknown"]);
		assert.equal(out[2].missed, 11_984);
	});

	it("does not judge a model that never reported any cache activity", () => {
		const out = diagnoseCache([
			request(0, { input: 10_000 }),
			request(1_000, { input: 12_000 }),
			request(2_000, { input: 14_000 }),
		]);
		assert.deepEqual(out.map((d) => [d.cause, d.missed, d.extraCost]), [["first", 0, 0], ["uncached", 0, 0], ["uncached", 0, 0]]);
	});

	it("skips requests that never reached the provider", () => {
		const failed = request(500, {}, { stopReason: "error" });
		const out = diagnoseCache([request(0, { input: 5_000, cacheRead: 5_000 }), failed, request(1_000, { input: 1_000, cacheRead: 10_000 })]);
		assert.deepEqual(out.map((d) => [d.ordinal, d.index, d.cause]), [[1, 0, "first"], [2, 2, "hit"]]);
	});

	it("reports misses without recorded rates as tokens, not money", () => {
		const bare = (at: number, usage: Partial<Usage>) => {
			const message = request(at, usage, { api: "anthropic-messages" });
			delete message.usage.cost.rates;
			return message;
		};
		const unpriced = diagnoseCache([bare(0, { input: 100, cacheWrite: 30_000 }), bare(1_000, { input: 100, cacheRead: 5_000, cacheWrite: 30_000 })]);
		assert.equal(unpriced[1].missed, 30_100 - 5_000);
		assert.equal(unpriced[1].extraCost, undefined);
		const summary = summarizeCacheDiagnoses(unpriced);
		assert.equal(summary.unpricedMissed, 25_100);
		assert.equal(summary.extraCost, 0);
	});

	it("sums requests, misses and cost by cause", () => {
		const summary = summarizeCacheDiagnoses(diagnoseCache([
			request(0, { input: 1_000, cacheRead: 19_000 }),
			request(6 * MINUTE, { input: 21_000, cacheRead: 0 }),
			request(6 * MINUTE + 5_000, { input: 16_000, cacheRead: 6_000 }),
			request(6 * MINUTE + 9_000, { input: 1_000, cacheRead: 22_000 }),
		]));
		assert.equal(summary.requests, 4);
		assert.equal(summary.missed, 20_000 + 15_000);
		assert.deepEqual(
			Object.fromEntries(Object.entries(summary.byCause).filter(([, v]) => v.requests > 0).map(([k, v]) => [k, [v.requests, v.missed]])),
			{ first: [1, 0], idle: [1, 20_000], unknown: [1, 15_000], hit: [1, 0] },
		);
		assert.ok(Math.abs(summary.extraCost - 35_000 * 0.9 / 1e6) < 1e-12);
	});
});
