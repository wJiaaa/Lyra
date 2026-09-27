/** Resolve recorded or configured rates for one historical model response. */

import { createHash } from "node:crypto";
import {
	costAtRates,
	selectPricingRates,
	type ModelPricing,
	type ProviderConfig,
	type SelectedPricingRates,
} from "@lyra/core";
import { catalogModelFor, catalogPricing, modelCatalogVersion } from "@lyra/core/model-catalog";

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

type PriceSource = "provider" | "catalog" | "manual" | "recorded";

export interface PricedUsage {
	source: PriceSource | null;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	rawCost: number;
	cacheSavings: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberAt(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function storedRates(cost: Record<string, unknown> | null): SelectedPricingRates | null {
	const rates = asRecord(cost?.rates);
	if (!rates) return null;
	const input = optionalNumberAt(rates, "input");
	const output = optionalNumberAt(rates, "output");
	const cacheRead = optionalNumberAt(rates, "cacheRead");
	const cacheWrite = optionalNumberAt(rates, "cacheWrite");
	return input !== null && output !== null && cacheRead !== null && cacheWrite !== null &&
		[input, output, cacheRead, cacheWrite].every((rate) => rate >= 0)
		? { input, output, cacheRead, cacheWrite }
		: null;
}

function storedOrCalculated(cost: Record<string, unknown> | null, key: string, calculated: number): number {
	return optionalNumberAt(cost, key) ?? calculated;
}

function rawCostFor(usage: TokenUsage, rates: SelectedPricingRates): number {
	return costAtRates(
		{ input: usage.input + usage.cacheRead + usage.cacheWrite, output: usage.output, cacheRead: 0, cacheWrite: 0 },
		rates,
	).total;
}

function configuredPricing(
	providers: ProviderConfig[],
	providerId: string,
	modelId: string,
): { pricing: ModelPricing; source: "catalog" | "manual" } | null {
	const provider = providers.find((candidate) => candidate.id === providerId);
	const configured = provider?.models.find((candidate) => candidate.modelId === modelId);
	// 配置里有价格就用配置的：从目录填进来的也是一份存下来的值，之后目录怎么变都不跟。
	if (configured?.pricing) return { pricing: configured.pricing, source: configured.pricing.source === "catalog" ? "catalog" : "manual" };
	// 没配价格（或供应商已删除）的历史记录，按目录估一个参考价。
	const catalog = catalogModelFor(provider ?? { baseUrl: "" }, modelId);
	const pricing = catalog ? catalogPricing(catalog.provider.id, catalog.model) : undefined;
	return pricing ? { pricing, source: "catalog" } : null;
}

export function priceUsage(
	usage: TokenUsage,
	stored: Record<string, unknown> | null,
	providers: ProviderConfig[],
	providerId: string,
	modelId: string,
): PricedUsage {
	const storedCost = asRecord(stored?.cost);
	const storedTotal = optionalNumberAt(storedCost, "total");
	const rates = storedRates(storedCost);
	const declared = storedCost?.source;
	const declaredSource: PriceSource | null =
		declared === "provider" || declared === "catalog" || declared === "manual" ? declared : null;

	if (rates && declaredSource) {
		const calculated = costAtRates(usage, rates);
		const cost = {
			input: storedOrCalculated(storedCost, "input", calculated.input),
			output: storedOrCalculated(storedCost, "output", calculated.output),
			cacheRead: storedOrCalculated(storedCost, "cacheRead", calculated.cacheRead),
			cacheWrite: storedOrCalculated(storedCost, "cacheWrite", calculated.cacheWrite),
			total: storedTotal ?? calculated.total,
		};
		const rawCost = rawCostFor(usage, rates);
		return { source: declaredSource, cost, rawCost, cacheSavings: rawCost - cost.total };
	}

	if (storedTotal !== null && (storedTotal > 0 || declaredSource === "provider" || declaredSource === "manual")) {
		return {
			source: declaredSource ?? "recorded",
			cost: {
				input: numberAt(storedCost, "input"),
				output: numberAt(storedCost, "output"),
				cacheRead: numberAt(storedCost, "cacheRead"),
				cacheWrite: numberAt(storedCost, "cacheWrite"),
				total: storedTotal,
			},
			rawCost: storedTotal,
			cacheSavings: 0,
		};
	}

	const matched = configuredPricing(providers, providerId, modelId);
	if (!matched) {
		return {
			source: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			rawCost: 0,
			cacheSavings: 0,
		};
	}
	const selected = selectPricingRates(usage, matched.pricing);
	const cost = costAtRates(usage, selected);
	const rawCost = rawCostFor(usage, selected);
	return { source: matched.source, cost, rawCost, cacheSavings: rawCost - cost.total };
}

export function usagePricingKey(providers: ProviderConfig[]): string {
	const pricing = providers.map((provider) => ({
		id: provider.id,
		baseUrl: provider.baseUrl,
		models: provider.models.map((model) => ({ id: model.modelId, pricing: model.pricing })),
	}));
	return createHash("sha256").update(JSON.stringify({ catalog: modelCatalogVersion(), pricing })).digest("hex");
}
