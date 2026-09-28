/** Validation for the incremental usage cache. Invalid or old caches are simply rebuilt. */

import { readFile } from "node:fs/promises";
import type { CacheDiagnosisState } from "@lyra/core";
import type { UsageBucket } from "./usage-types.ts";

export interface UsageFileEntry {
	mtimeMs: number;
	size: number;
	buckets: UsageBucket[];
	days: Record<string, number>;
	/** 每条请求序列（主会话 `main`、子代理 `sub:<id>`）的缓存诊断进度，日志长了从这里接着诊断。 */
	cacheStreams: Record<string, CacheDiagnosisState>;
}

export type UsageFiles = Record<string, UsageFileEntry>;

interface UsageCache {
	version: typeof USAGE_CACHE_VERSION;
	pricingKey: string;
	files: UsageFiles;
}

/**
 * 缓存的格式版本。**改了「扫什么」就要加一。**
 *
 * 这张缓存按「文件的 mtime + size 没变就不重读」工作，快是快在这里，代价是它记的是**上一版扫描器的
 * 结论**。所以凡是改变了从一行日志里读出什么的改动，都必须在这里加一，否则老用户的数字永远停在旧口径
 * 上——文件不再增长，缓存就再也不会被重算。
 *
 * 3: 计价 token 从每个桶都算，改成只算新鲜 token。
 * 4: 子 Agent 的用量开始算进来（它的消息落盘成 `type: "event"` 里的 `subagent_message`，从前够不着）。
 *    这一版的漏算不小：用户的一个会话里子 Agent 比主 Agent 还多烧 40%。
 * 5: 逐次请求的缓存未命中（`UsageBucket.cacheMiss`），要从头诊断每条请求序列。
 * 6: 未命中不再按猜的缓存有效期归成「空闲过期」，旧缓存里记在 `idle` 名下的要重新归类。
 * 7: 按回复上记下的前缀指纹把原来的「原因不明」拆开（工具、提示词、改写历史、服务商没读到），
 *    已经记在 `unknown` 名下的要重新归类。
 * 8: 读取不再越过扫描前取得的大小和末尾的半行。旧版在扫描期间日志被追加时会把追加的部分算两次，
 *    文件之后不再增长的话这个多算会一直留在缓存里，所以要从头重扫。
 *
 * 上面那个 `version: 2` 曾经和这里的 3 对不上——接口写死一个字面量、常量另写一个，两边谁也不管谁。
 * 现在接口直接引常量，只能一起改。
 */
export const USAGE_CACHE_VERSION = 8 as const;

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

function isFileEntry(value: unknown): value is UsageFileEntry {
	const entry = asRecord(value);
	if (!entry || typeof entry.mtimeMs !== "number" || typeof entry.size !== "number" || !Array.isArray(entry.buckets)) return false;
	const days = asRecord(entry.days);
	const streams = asRecord(entry.cacheStreams);
	return (
		Boolean(days) &&
		Object.values(days ?? {}).every((count) => typeof count === "number") &&
		entry.buckets.every(isUsageBucket) &&
		Boolean(streams) &&
		Object.values(streams ?? {}).every((state) => Array.isArray(asRecord(state)?.reported) && typeof asRecord(state)?.requests === "number")
	);
}

function isUsageCache(value: unknown, expectedPricingKey: string): value is UsageCache {
	const cache = asRecord(value);
	if (!cache || cache.version !== USAGE_CACHE_VERSION || cache.pricingKey !== expectedPricingKey) return false;
	const files = asRecord(cache.files);
	return Boolean(files) && Object.values(files ?? {}).every(isFileEntry);
}

export async function readUsageCache(path: string, expectedPricingKey: string): Promise<UsageFiles> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isUsageCache(parsed, expectedPricingKey) ? parsed.files : {};
	} catch {
		return {};
	}
}
