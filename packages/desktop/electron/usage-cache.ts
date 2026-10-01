/** Validation for the incremental usage cache. Invalid or old caches are simply rebuilt. */

import { readFile } from "node:fs/promises";
import type { CacheDiagnosisState } from "@plume/core";
import type { UsageBucket } from "./usage-types.ts";

/** Everything folded in so far, and where the next pass picks up. */
export interface UsageTally {
	/** The last spend row folded in; the next pass reads what comes after it. */
	afterId: number;
	/** How many rows that was. */
	rows: number;
	buckets: UsageBucket[];
	/** Per request sequence (`<session>\0main`, `<session>\0sub:<id>`), where diagnosis left off. */
	streams: Record<string, CacheDiagnosisState>;
}

interface UsageCache extends UsageTally {
	version: typeof USAGE_CACHE_VERSION;
	pricingKey: string;
	/** The database `afterId` points into (`SessionStorage.storeId`). */
	source: string;
}

/**
 * 缓存的格式版本。**改了「扫什么」就要加一。**
 *
 * 这张缓存按「读过的行不再读」工作，快是快在这里，代价是它记的是**上一版扫描器的结论**。所以凡是
 * 改变了从一行里读出什么的改动，都必须在这里加一，否则数字永远停在旧口径上——读过的行不会再被重算。
 */
export const USAGE_CACHE_VERSION = 10 as const;

const BUCKET_NUMBERS: (keyof UsageBucket)[] = [
	"input", "output", "cacheRead", "cacheWrite", "reasoning", "cost", "inputCost", "outputCost",
	"cacheReadCost", "cacheWriteCost", "rawCost", "cacheSavings", "providerPricedTokens",
	"catalogPricedTokens", "manualPricedTokens", "recordedPricedTokens", "unpricedTokens", "replies",
];

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

function isUsageBucket(value: unknown): value is UsageBucket {
	const bucket = asRecord(value);
	if (!bucket || typeof bucket.day !== "string" || typeof bucket.key !== "string" || typeof bucket.provider !== "string" || typeof bucket.model !== "string") return false;
	return (
		BUCKET_NUMBERS.every((key) => {
			const field = bucket[key];
			return typeof field === "number" && Number.isFinite(field);
		}) &&
		(bucket.cacheMiss === undefined || isCacheMiss(bucket.cacheMiss))
	);
}

function isCacheMiss(value: unknown): boolean {
	const miss = asRecord(value);
	const byCause = asRecord(miss?.byCause);
	return (
		Boolean(miss && byCause) &&
		[miss?.tokens, miss?.cost, miss?.unpriced, ...Object.values(byCause ?? {})].every((field) => typeof field === "number" && Number.isFinite(field))
	);
}

function isUsageCache(value: unknown, expectedPricingKey: string, expectedSource: string): value is UsageCache {
	const cache = asRecord(value);
	if (!cache || cache.version !== USAGE_CACHE_VERSION || cache.pricingKey !== expectedPricingKey || cache.source !== expectedSource) return false;
	const streams = asRecord(cache.streams);
	return (
		typeof cache.afterId === "number" &&
		typeof cache.rows === "number" &&
		Array.isArray(cache.buckets) &&
		cache.buckets.every(isUsageBucket) &&
		Boolean(streams) &&
		Object.values(streams ?? {}).every((state) => Array.isArray(asRecord(state)?.reported) && typeof asRecord(state)?.requests === "number")
	);
}

/** The cached tally, or an empty one to read the table from the top. `source` is the database the cursor must belong to. */
export async function readUsageCache(path: string, expectedPricingKey: string, source: string): Promise<UsageTally> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (isUsageCache(parsed, expectedPricingKey, source)) return { afterId: parsed.afterId, rows: parsed.rows, buckets: parsed.buckets, streams: parsed.streams };
	} catch {
		// Missing or unreadable: start over.
	}
	return { afterId: 0, rows: 0, buckets: [], streams: {} };
}
