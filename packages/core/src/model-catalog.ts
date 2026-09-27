/**
 * The offline model catalogue, used only for price estimates.
 *
 * Limits and capabilities come from the smart-config rules in `model-rules.ts`; this snapshot of
 * models.dev answers one question — what a model costs — for the model editor and usage accounting.
 * Endpoint rates take priority; relays use an identified upstream reference price.
 * Opaque aliases require an explicit binding, and the wire model id is never rewritten.
 */

import snapshotJson from "./catalog/model-catalog.json" with { type: "json" };
import type { ModelConfig, ModelPricing, ModelPricingTier, ProviderConfig } from "./types/provider.ts";

export interface CatalogModel {
	id: string;
	name: string;
	contextWindow: number;
	maxOutputTokens: number;
	inputPrice?: number;
	outputPrice?: number;
	cacheReadPrice?: number;
	cacheWritePrice?: number;
	tiers?: ModelPricingTier[];
	supportsThinking: boolean;
	supportsImages: boolean;
	supportsTools: boolean;
}

export interface CatalogProvider {
	id: string;
	name: string;
	api?: string;
	doc?: string;
	models: CatalogModel[];
}

interface ModelCatalogSnapshot {
	schema: 1;
	source: {
		name: string;
		url: string;
		repository: string;
		commit: string;
		updatedAt: string;
		license: "MIT";
	};
	providers: CatalogProvider[];
}

function schemaVersion(value: number): 1 {
	if (value !== 1) throw new Error(`Unsupported model catalogue schema: ${value}`);
	return value;
}

function catalogueLicense(value: string): "MIT" {
	if (value !== "MIT") throw new Error(`Unsupported model catalogue license: ${value}`);
	return value;
}

const snapshot: ModelCatalogSnapshot = {
	...snapshotJson,
	schema: schemaVersion(snapshotJson.schema),
	source: {
		...snapshotJson.source,
		license: catalogueLicense(snapshotJson.source.license),
	},
};
const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]));

export const MODEL_CATALOG_SOURCE = snapshot.source;
export const MODEL_CATALOG_VERSION = `2:${snapshot.source.commit.slice(0, 12)}`;
export const MODEL_CATALOG_PROVIDERS = snapshot.providers;

const EXACT_HOSTS: Record<string, string> = {
	"api.openai.com": "openai",
	"api.anthropic.com": "anthropic",
	"generativelanguage.googleapis.com": "google",
	"api.deepseek.com": "deepseek",
	"api.x.ai": "xai",
	"api.mistral.ai": "mistral",
	"api.groq.com": "groq",
	"openrouter.ai": "openrouter",
	"api.openrouter.ai": "openrouter",
	"api.githubcopilot.com": "github-copilot",
	"api.fireworks.ai": "fireworks-ai",
	"api.together.xyz": "togetherai",
	"api.cerebras.ai": "cerebras",
	"api.perplexity.ai": "perplexity",
	"api.moonshot.ai": "moonshotai",
	"api.moonshot.cn": "moonshotai-cn",
	"dashscope.aliyuncs.com": "alibaba-cn",
	"dashscope-intl.aliyuncs.com": "alibaba",
	"open.bigmodel.cn": "zhipuai",
	"api.z.ai": "zai",
	"api.minimax.chat": "minimax-cn",
	"api.minimax.io": "minimax",
	"api.minimaxi.com": "minimax-cn",
	"api.deepinfra.com": "deepinfra",
	"api.cloudflare.com": "cloudflare-workers-ai",
};

function providerIdFromHost(hostname: string): string | null {
	const exact = EXACT_HOSTS[hostname];
	if (exact) return exact;
	if (hostname.endsWith(".openai.azure.com")) return "azure";
	if (hostname === "aiplatform.googleapis.com" || hostname.endsWith("-aiplatform.googleapis.com")) return "google-vertex";
	if (/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(hostname)) return "amazon-bedrock";
	return null;
}

function configuredHostname(baseUrl: string): string | null {
	try {
		return new URL(baseUrl).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}
}

/** Resolve a configured endpoint to one catalogue provider, without guessing from its model ids. */
export function catalogProviderFor(provider: Pick<ProviderConfig, "id" | "baseUrl">): CatalogProvider | null {
	const hostname = configuredHostname(provider.baseUrl);
	if (hostname) {
		const endpoint = new URL(provider.baseUrl);
		const candidates = snapshot.providers.filter((entry) => {
			if (!entry.api || configuredHostname(entry.api) !== hostname) return false;
			const path = new URL(entry.api).pathname.replace(/\/$/, "");
			return endpoint.pathname === path || endpoint.pathname.startsWith(`${path}/`);
		}).sort((a, b) => (b.api?.length ?? 0) - (a.api?.length ?? 0));
		if (candidates[0]) return candidates[0];
		const id = providerIdFromHost(hostname);
		return id ? providers.get(id) ?? null : null;
	}
	return providers.get(provider.id.toLowerCase()) ?? null;
}

export interface CatalogMatch {
	provider: CatalogProvider;
	model: CatalogModel;
	match: "exact" | "alias" | "reference" | "binding";
}

function familyProvider(id: string): string | undefined {
	if (/^(gpt-|o[134](?:-|$))/.test(id)) return "openai";
	if (id.startsWith("claude-")) return "anthropic";
	if (id.startsWith("gemini-")) return "google";
	if (/^(kimi-|moonshot-)/.test(id)) return "moonshotai";
	if (/^(qwen|qwq|qvq)/.test(id)) return "alibaba";
	if (id.startsWith("glm-")) return "zai";
	if (id.startsWith("deepseek-")) return "deepseek";
	if (id.startsWith("grok-")) return "xai";
	if (id.startsWith("minimax-")) return "minimax";
	if (/^(mistral|magistral|codestral|devstral|ministral)/.test(id)) return "mistral";
	return undefined;
}

const modelIndexes = new Map(snapshot.providers.map((provider) => [provider.id,
	new Map(provider.models.flatMap((model) => [[model.id.toLowerCase(), model], [model.id.toLowerCase().split("/").at(-1) ?? model.id, model]])),
]));

/** Only recognised decorations may be removed; unknown versions and paid/free variants stay distinct. */
function modelCandidates(id: string): string[] {
	let current = id.trim().toLowerCase().replace(/claude-(opus|sonnet|haiku)-(\d+)\.(\d+)/, "claude-$1-$2-$3");
	const candidates = [current];
	const bare = current.split("/").at(-1);
	if (bare && bare !== current) candidates.push(bare);
	current = bare ?? current;
	const suffix = /[-_:](?:extra-low|minimal|low|medium|high|xhigh|max|ultra|thinking|reasoning|preview|latest|agent|tiered|\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
	while (suffix.test(current)) {
		current = current.replace(suffix, "");
		candidates.push(current);
	}
	return candidates;
}

export function catalogModelFor(
	provider: Pick<ProviderConfig, "id" | "baseUrl">,
	modelId: string,
	binding?: ModelConfig["catalogRef"],
): CatalogMatch | null {
	if (binding) {
		const source = providers.get(binding.providerId);
		const model = source?.models.find((entry) => entry.id === binding.modelId);
		return source && model ? { provider: source, model, match: "binding" } : null;
	}
	const endpoint = catalogProviderFor(provider);
	const candidates = modelCandidates(modelId);
	const bare = modelId.trim().toLowerCase().split("/").at(-1) ?? modelId;
	const family = familyProvider(bare);
	// OpenRouter supplies reference prices for open-weight families without an upstream API tariff.
	const sources = [...new Set([endpoint?.id, family, "openrouter"])].filter((id) => id !== undefined);
	for (const candidate of candidates) {
		for (const sourceId of sources) {
			const source = providers.get(sourceId);
			const model = modelIndexes.get(sourceId)?.get(candidate);
			if (source && model) return { provider: source, model, match: source === endpoint ? (candidate === modelId ? "exact" : "alias") : "reference" };
		}
	}
	// Some versioned APIs only publish a preview id. Never choose a version for an opaque alias.
	if (/\d/.test(bare)) {
		const source = family ? providers.get(family) : undefined;
		for (const candidate of candidates) {
			const model = source && modelIndexes.get(source.id)?.get(`${candidate}-preview`);
			if (source && model) return { provider: source, model, match: "reference" };
		}
	}
	return null;
}

export function catalogPricing(providerId: string, model: CatalogModel): ModelPricing | undefined {
	if (model.inputPrice === undefined || model.outputPrice === undefined) return undefined;
	return {
		input: model.inputPrice,
		output: model.outputPrice,
		cacheRead: model.cacheReadPrice,
		cacheWrite: model.cacheWritePrice,
		tiers: model.tiers,
		source: "catalog",
		catalogProvider: providerId,
		catalogModel: model.id,
		catalogVersion: MODEL_CATALOG_VERSION,
	};
}

/** Fill in the catalogue price; a manual price always wins. Idempotent — settings run it on every read and write. */
export function withCatalogPricing(provider: Pick<ProviderConfig, "id" | "baseUrl">, model: ModelConfig): ModelConfig {
	if (model.pricing && model.pricing.source !== "catalog") return model;
	const found = catalogModelFor(provider, model.modelId, model.catalogRef);
	return found ? { ...model, pricing: catalogPricing(found.provider.id, found.model) } : model;
}
