import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { priceUsage, usagePricingKey } from "../electron/usage-pricing.ts";
import { DEFAULT_SETTINGS, type Settings } from "@plume/core";

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

describe("historical usage pricing", () => {
	it("reprices relay history and removed providers by recognised upstream model id", () => {
		const priced = priceUsage({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 }, { cost: { total: 0 } }, [], "removed-relay", "gpt-5.2-high");
		assert.equal(priced.cost.total, 1.75);
		assert.equal(priced.source, "catalog");
	});
	it("keeps explicit zero provider bills and manual overrides ahead of catalogue estimates", () => {
		const priced = priceUsage(usage, { cost: { source: "provider", total: 0 } }, [], "relay", "gpt-5.2-high");
		assert.equal(priced.cost.total, 0);
		assert.equal(priced.source, "provider");
	});
	it("uses a configured price as stored and estimates only unpriced models from the catalogue", () => {
		const settings: Settings = { ...DEFAULT_SETTINGS, providers: [{
			id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", api: "openai-responses", apiKey: "", enabled: true,
			models: [{ id: "relay/gpt-5.2", modelId: "gpt-5.2", providerId: "relay", name: "GPT", contextWindow: 200000, maxOutputTokens: 16384, supportsThinking: true, supportsImages: true, supportsTools: true }],
		}] };
		const million = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 };
		assert.equal(priceUsage(million, null, settings.providers, "relay", "gpt-5.2").cost.total, 1.75);
		const before = usagePricingKey(settings.providers);
		settings.providers[0].models[0].pricing = { input: 9, output: 10, source: "catalog" };
		assert.notEqual(usagePricingKey(settings.providers), before);
		assert.equal(priceUsage(million, null, settings.providers, "relay", "gpt-5.2").cost.total, 9, "a price filled from the catalogue is not looked up again");
	});
	it("preserves recorded zero cost fields instead of replacing them with recalculated values", () => {
		const priced = priceUsage(usage, {
			cost: {
				source: "manual",
				input: 0,
				output: 2,
				cacheRead: 0,
				cacheWrite: 1.25,
				total: 3.25,
				rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
			},
		}, [], "local", "model");

		assert.equal(priced.cost.input, 0);
		assert.equal(priced.cost.cacheRead, 0);
		assert.equal(priced.cost.output, 2);
		assert.equal(priced.cost.total, 3.25);
	});

	it("does not treat an incomplete rates object as a historical price snapshot", () => {
		const priced = priceUsage(usage, {
			cost: {
				source: "manual",
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 0,
				total: 3.1,
				rates: { input: 1, output: 2 },
			},
		}, [], "local", "model");

		assert.equal(priced.source, "manual");
		assert.equal(priced.cost.total, 3.1);
		assert.equal(priced.rawCost, 3.1);
		assert.equal(priced.cacheSavings, 0);
	});

	it("keeps provider-reported cost in the provider quality bucket without invented rates", () => {
		const priced = priceUsage(usage, { cost: { source: "provider", total: 4.75 } }, [], "local", "model");
		assert.equal(priced.source, "provider");
		assert.equal(priced.cost.total, 4.75);
		assert.equal(priced.rawCost, 4.75);
	});

	it("treats mixed historical cost as recorded because it has no single pricing origin", () => {
		const priced = priceUsage(usage, { cost: { source: "mixed", total: 5 } }, [], "local", "model");
		assert.equal(priced.source, "recorded");
	});
});
