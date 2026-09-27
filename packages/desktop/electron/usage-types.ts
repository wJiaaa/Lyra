/** Data returned by the main-process usage scanner. */

import type { CacheCause } from "@lyra/core";

/**
 * 本该从缓存读到、却按全价重算的那部分，见 core 的 `runtime/cache-diagnostics.ts`。
 *
 * 只记有未命中的原因；一次都没漏过的桶不带这一项。
 */
export interface UsageCacheMiss {
	tokens: number;
	/** 有费率的那部分多花的美元，按请求当时存下的费率算。 */
	cost: number;
	/** 没存费率、算不出钱的未命中 token。 */
	unpriced: number;
	byCause: Partial<Record<CacheCause, number>>;
}

/** One day's spend on one model. The unit the page slices every way. */
export interface UsageBucket {
	/** `YYYY-MM-DD`, local. A turn at 23:00 belongs to the day you had it. */
	day: string;
	/** `${provider}/${model}` as the message recorded it, using wire names. */
	key: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost: number;
	/** The same request priced as if every cached token were ordinary input. */
	rawCost: number;
	cacheSavings: number;
	providerPricedTokens: number;
	catalogPricedTokens: number;
	manualPricedTokens: number;
	recordedPricedTokens: number;
	unpricedTokens: number;
	/** Replies, which is what token counts belong to. */
	replies: number;
	cacheMiss?: UsageCacheMiss;
}

/** One day, across every model. */
export interface UsageDay {
	day: string;
	/** Conversations that said or heard anything that day. */
	sessions: number;
	/** Messages on both sides. */
	messages: number;
}

export interface UsageScan {
	days: UsageDay[];
	buckets: UsageBucket[];
	/** How many logs were read this time, and how many were answered from the cache. */
	scanned: number;
	cached: number;
	tookMs: number;
}
