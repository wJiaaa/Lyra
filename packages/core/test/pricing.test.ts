import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addUsage, emptyUsage, type Usage } from "../src/types/message.ts";
import { freshTokens } from "../src/tokens.ts";
import type { ModelConfig, ModelPricing } from "../src/types/provider.ts";
import { computeCost, selectPricingRates } from "../src/utils/pricing.ts";

function model(pricing: ModelPricing): ModelConfig {
	return {
		id: "qa/model",
		providerId: "qa",
		modelId: "model",
		name: "model",
		contextWindow: 1_000_000,
		maxOutputTokens: 100_000,
		supportsThinking: true,
		supportsImages: true,
		supportsTools: true,
		pricing,
	};
}

describe("model pricing", () => {
	it("prices the four token buckets independently and records the selected rates", () => {
		const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
		const priced = computeCost(usage, model({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, source: "catalog" }));
		assert.deepEqual(priced.cost, {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			total: 4.35,
			source: "catalog",
			rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		});
	});

	it("uses ordinary input pricing when a provider has no distinct cache rate", () => {
		assert.deepEqual(selectPricingRates({ input: 1, cacheRead: 1, cacheWrite: 1 }, { input: 3, output: 9 }), {
			input: 3,
			output: 9,
			cacheRead: 3,
			cacheWrite: 3,
		});
	});

	it("selects the highest matching long-context tier", () => {
		const pricing: ModelPricing = {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			tiers: [
				{ aboveTokens: 200_000, input: 2, output: 4, cacheRead: 0.2 },
				{ aboveTokens: 500_000, input: 3, output: 6, cacheRead: 0.3 },
			],
		};
		assert.equal(selectPricingRates({ input: 600_000, cacheRead: 0, cacheWrite: 0 }, pricing).input, 3);
		assert.equal(selectPricingRates({ input: 200_000, cacheRead: 0, cacheWrite: 0 }, pricing).input, 1);
	});
});

describe("usage pricing aggregation", () => {
	function priced(input = 1): Usage {
		return computeCost({ ...emptyUsage(), input: 1_000_000 }, model({
			input, output: 2, cacheRead: 0.1, cacheWrite: 1.25,
			source: "catalog",
		}));
	}

	it("preserves selected pricing when an empty accumulator receives its first usage", () => {
		const usage = priced();
		assert.deepEqual(addUsage(emptyUsage(), usage).cost, usage.cost);
		assert.deepEqual(addUsage(usage, emptyUsage()).cost, usage.cost);
	});

	it("does not introduce pricing properties into historical usage", () => {
		const usage = { ...emptyUsage(), input: 10 };
		assert.deepEqual(addUsage(emptyUsage(), usage).cost, usage.cost);
	});

	it("retains common rates across priced requests", () => {
		const usage = priced();
		const sum = addUsage(usage, usage);
		assert.equal(sum.cost.total, 2);
		assert.deepEqual(sum.cost.rates, usage.cost.rates);
		assert.equal(sum.cost.source, "catalog");
	});

	it("never restores a single rate after differently priced requests were combined", () => {
		const a = priced();
		const b = priced(2);
		for (const sum of [addUsage(addUsage(a, b), a), addUsage(a, addUsage(b, a))]) {
			assert.equal(sum.cost.total, 4);
			assert.equal(Object.hasOwn(sum.cost, "rates"), false);
		}
	});

	it("does not attribute historical or provider-only usage to catalog rates", () => {
		const catalog = priced();
		const historical = { ...emptyUsage(), input: 10 };
		const provider: Usage = { ...emptyUsage(), cost: { ...emptyUsage().cost, total: 0.1, source: "provider" } };
		for (const other of [historical, provider]) {
			for (const sum of [addUsage(catalog, other), addUsage(other, catalog)]) {
				assert.equal(sum.cost.source, "mixed");
				assert.equal(Object.hasOwn(sum.cost, "rates"), false);
				assert.equal(addUsage(sum, catalog).cost.source, "mixed");
			}
		}
	});
});

describe("freshTokens", () => {
	it("leaves out cache reads and keeps everything that was paid for at full rate", () => {
		const usage = { ...emptyUsage(), input: 1_000, output: 200, cacheRead: 90_000, cacheWrite: 500 };
		assert.equal(freshTokens(usage), 1_700);
	});

	/*
	 * The case this exists for. A long agentic run re-reads its context on every tool call, so
	 * `total` is dominated by a bucket billed at a tenth of the input rate — the session this was
	 * written for reported 524M against 28M of actual input.
	 */
	it("is the figure that does not grow with the number of tool calls", () => {
		const oneRequest = { ...emptyUsage(), input: 1_000, output: 100, cacheRead: 200_000, total: 201_100 };
		let total = emptyUsage();
		for (let i = 0; i < 100; i++) total = addUsage(total, oneRequest);
		assert.equal(total.total, 20_110_000, "what crossed the wire");
		assert.equal(freshTokens(total), 110_000, "what was actually new");
	});

	it("counts a cache write as fresh, because it is the first full-price pass over that content", () => {
		assert.equal(freshTokens({ ...emptyUsage(), cacheWrite: 5_000 }), 5_000);
		assert.equal(freshTokens({ ...emptyUsage(), cacheRead: 5_000 }), 0);
	});
});
