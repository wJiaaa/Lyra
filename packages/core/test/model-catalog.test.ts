import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	catalogModelFor,
	catalogProviderFor,
	MODEL_CATALOG_SOURCE,
	MODEL_CATALOG_PROVIDERS,
	withCatalogPricing,
} from "../src/model-catalog.ts";
import { withSmartConfig } from "../src/model-rules.ts";
import { normalizeSettings } from "../src/config/settings.ts";
import { computeCost } from "../src/utils/pricing.ts";
import type { ModelConfig, ProviderConfig } from "../src/types/provider.ts";

function provider(baseUrl: string, id = "provider-local"): ProviderConfig {
	return { id, name: "Configured endpoint", baseUrl, api: "openai-responses", apiKey: "", enabled: true, models: [] };
}

/** A model row whose limits are deliberately meaningless, so a test sees what the catalogue changes. */
function bare(endpoint: ProviderConfig, modelId: string): ModelConfig {
	return { id: `${endpoint.id}/${modelId}`, providerId: endpoint.id, modelId, name: modelId, contextWindow: 1, maxOutputTokens: 1, supportsThinking: false, supportsImages: false, supportsTools: false };
}

describe("offline model catalogue", () => {
	it("is stamped with a reproducible MIT-licensed upstream version", () => {
		assert.equal(MODEL_CATALOG_SOURCE.license, "MIT");
		assert.match(MODEL_CATALOG_SOURCE.commit, /^[a-f0-9]{40}$/);
		assert.equal(MODEL_CATALOG_SOURCE.repository, "https://github.com/anomalyco/models.dev");
	});

	it("identifies a custom local id from the official endpoint host", () => {
		assert.equal(catalogProviderFor(provider("https://api.openai.com/v1"))?.id, "openai");
		assert.equal(catalogProviderFor(provider("https://eastus.openai.azure.com/openai/v1"))?.id, "azure");
	});

	it("uses upstream reference prices for an unknown relay without changing its wire id", () => {
		const relay = provider("https://relay.example/v1", "openai");
		assert.equal(catalogProviderFor(relay), null);
		assert.equal(catalogModelFor(relay, "gpt-5.2")?.model.inputPrice, 1.75);
		const priced = withCatalogPricing(relay, { ...bare(relay, "gpt-5.2-high") });
		assert.equal(priced.modelId, "gpt-5.2-high");
		assert.equal(priced.pricing?.input, 1.75);
	});

	it("matches exact model ids and fills in only the price", () => {
		const openai = provider("https://api.openai.com/v1");
		const found = catalogModelFor(openai, "gpt-5.2");
		assert.equal(found?.model.inputPrice, 1.75);
		assert.equal(catalogModelFor(openai, "GPT-5.2")?.model.id, "gpt-5.2");

		const model = withCatalogPricing(openai, bare(openai, "gpt-5.2"));
		assert.equal(model.pricing?.cacheRead, 0.175);
		assert.equal(model.pricing?.source, "catalog");
		assert.equal(model.contextWindow, 1, "limits are the smart config's, not the catalogue's");
		const manual = withCatalogPricing(openai, { ...bare(openai, "gpt-5.2"), pricing: { input: 9, output: 10 } });
		assert.equal(manual.pricing?.input, 9, "a manual price always wins");
	});

	it("recognises versioned relay suffixes across model families without guessing unknown versions", () => {
		const relay = provider("https://relay.example/v1");
		for (const [id, expected] of [
			["gemini-3.7-flash-high", "gemini-3.7-flash"],
			["gemini-3.8-flash-preview-high", "gemini-3.8-flash"],
			["gemini-3.1-pro-high", "gemini-3.1-pro-preview"],
			["claude-opus-4-6-thinking", "claude-opus-4-6"],
			["command/deepseek-v4-flash:0731", "deepseek-v4-flash"],
			["kimi-k3-high", "kimi-k3"],
			["qwen3.8-max-preview-high", "qwen3.8-max"],
			["glm-5.3-high", "glm-5.3"],
			["hy3-preview-high", "tencent/hy3-preview"],
		]) assert.equal(catalogModelFor(relay, id)?.model.id, expected, id);
		for (const id of ["gemini-pro-agent", "gemini-99-pro", "gpt-5.2-unrecognised", "qwen-unknown", "gpt-5.2:free"]) {
			assert.equal(catalogModelFor(relay, id), null, id);
		}
	});
	it("distinguishes regional endpoints instead of applying international prices in China", () => {
		assert.equal(catalogProviderFor(provider("https://api.moonshot.cn/v1"))?.id, "moonshotai-cn");
		assert.equal(catalogProviderFor(provider("https://dashscope.aliyuncs.com/compatible-mode/v1"))?.id, "alibaba-cn");
		assert.equal(catalogProviderFor(provider("https://open.bigmodel.cn/api/paas/v4"))?.id, "zhipuai");
	});
	it("keeps the complete text-model catalogue, including HY and metadata without a tariff", () => {
		assert.ok(MODEL_CATALOG_PROVIDERS.length > 100);
		assert.ok(MODEL_CATALOG_PROVIDERS.flatMap((p) => p.models).length > 5000);
		assert.ok(MODEL_CATALOG_PROVIDERS.some((p) => p.models.some((m) => m.inputPrice === undefined)));
		const relay = provider("https://relay.example/v1");
		assert.equal(withCatalogPricing(relay, bare(relay, "hy3-preview-high")).pricing?.input, 0.18);
	});
	it("repairs old imports at settings load so live requests use the same prices as the editor", () => {
		const relay = provider("https://relay.example/v1");
		const legacy = { id: "local", providerId: relay.id, modelId: "deepseek-v4-flash:0731", name: "Custom name", contextWindow: 200000, maxOutputTokens: 16384, supportsThinking: true, supportsImages: true, supportsTools: true };
		const settings = normalizeSettings({ providers: [{ ...relay, models: [legacy] }] });
		const model = settings.providers[0].models[0];
		assert.equal(model.supportsImages, false, "the old import signature now follows the smart config");
		assert.equal(model.modelId, legacy.modelId);
		assert.equal(model.name, legacy.name);
		assert.equal(model.metadataSource, "smart");
		assert.ok(model.pricing);
		const usage = computeCost({ input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1000000 }, model);
		assert.equal(usage.cost?.source, "catalog");
		assert.equal(usage.cost?.total, model.pricing.input);
		const manual = withCatalogPricing(relay, withSmartConfig(relay, { ...legacy, contextWindow: 500000, metadataSource: "manual", pricing: { input: 9, output: 10 } }));
		assert.equal(manual.contextWindow, 500000);
		assert.equal(manual.supportsImages, true);
		assert.equal(manual.pricing?.input, 9);
	});
	it("binds opaque relay aliases explicitly and does not substitute for a broken binding", () => {
		const relay = provider("https://relay.example/v1");
		assert.equal(catalogModelFor(relay, "gemini-pro-agent"), null);
		const bound = catalogModelFor(relay, "gemini-pro-agent", { providerId: "google", modelId: "gemini-2.5-pro" });
		assert.equal(bound?.model.id, "gemini-2.5-pro");
		assert.equal(bound?.match, "binding");
		assert.equal(catalogModelFor(relay, "gpt-5.2", { providerId: "google", modelId: "missing" }), null);
	});
});
