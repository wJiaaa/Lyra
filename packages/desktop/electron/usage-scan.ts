/**
 * What was actually spent, by day and by model.
 *
 * The session index already carries a total per conversation, and that is the wrong shape for
 * every question worth asking: it is stamped with `updatedAt`, so a refactor spread over three
 * days lands entirely on the third, and it has no idea which model did the spending — which is
 * the one thing you want to know when four relays are configured and one of them is expensive.
 *
 * So the logs themselves are read. They are append-only, which makes that cheap to keep doing:
 * a file whose size has grown is read from where the last scan stopped rather than from the top,
 * and one that has not changed at all is not opened. First pass over a real home here — 264MB
 * across 185 conversations — takes a couple of seconds; every pass after it is a few kilobytes.
 */

import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	diagnoseRequest,
	plumeHome,
	markCacheBoundary,
	newCacheDiagnosisState,
	type AssistantMessage,
	type CacheCause,
	type CacheDiagnosisState,
	type ProviderConfig,
} from "@plume/core";
import { freshTokens } from "@plume/core/tokens";
import { readUsageCache, USAGE_CACHE_VERSION, type UsageFileEntry, type UsageFiles } from "./usage-cache.ts";
import { priceUsage, usagePricingKey, type TokenUsage } from "./usage-pricing.ts";
import type { UsageBucket, UsageCacheMiss, UsageDay, UsageScan } from "./usage-types.ts";

export type { UsageBucket, UsageCacheMiss, UsageDay, UsageScan } from "./usage-types.ts";

/** Local date key, deliberately not ISO/UTC. Mirrors `dayKey` in the settings page. */
function dayKey(ms: number): string {
	const date = new Date(ms);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value)) : null;
}

function numberAt(record: Record<string, unknown> | null, key: string): number {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyEntry(mtimeMs: number, size: number): UsageFileEntry {
	return { mtimeMs, size, buckets: [], days: {}, cacheStreams: {} };
}

function streamOf(entry: UsageFileEntry, id: string): CacheDiagnosisState {
	return (entry.cacheStreams[id] ??= newCacheDiagnosisState());
}

function bucketFor(entry: UsageFileEntry, day: string, key: string, provider: string, model: string): UsageBucket {
	const found = entry.buckets.find((each) => each.day === day && each.key === key);
	if (found) return found;
	const fresh: UsageBucket = {
		day,
		key,
		provider,
		model,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		cost: 0,
		inputCost: 0,
		outputCost: 0,
		cacheReadCost: 0,
		cacheWriteCost: 0,
		rawCost: 0,
		cacheSavings: 0,
		providerPricedTokens: 0,
		catalogPricedTokens: 0,
		manualPricedTokens: 0,
		recordedPricedTokens: 0,
		unpricedTokens: 0,
		replies: 0,
	};
	entry.buckets.push(fresh);
	return fresh;
}

/**
 * `[cursor.at, to)` 里以换行结尾的完整行；每交出一行，游标就推进到那一行的换行之后。
 *
 * 两条边界都是为了「游标记在哪，就恰好读到哪」：
 * - **上界 `to`**：扫描前 `stat` 到的大小。不设上界时，扫描期间追加的内容这次被读到、算进去，
 *   游标却停在旧大小，下一次从旧大小再读一遍——同一条回复算两次，而且被缓存住。
 * - **末尾没有换行的半行不交出、游标不越过它**：它可能是正在写的一条记录。按半行解析失败跳过、
 *   游标却越过去的话，下一次从行中间读起，剩下那半截也解析失败，这条记录就永远丢了。
 *
 * 按字节切而不是按解码后的字符串数，游标才和文件偏移对得上（多字节字符、`\r\n` 都不会让它漂）。
 */
async function* completeLines(path: string, cursor: { at: number }, to: number): AsyncGenerator<string> {
	const stream = createReadStream(path, { start: cursor.at, end: to - 1 });
	let rest: Buffer = Buffer.alloc(0);
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			const buffer = rest.length > 0 ? Buffer.concat([rest, chunk]) : chunk;
			let start = 0;
			for (let newline = buffer.indexOf(0x0a); newline !== -1; newline = buffer.indexOf(0x0a, start)) {
				const end = newline > start && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
				const line = buffer.toString("utf8", start, end);
				cursor.at += newline + 1 - start;
				start = newline + 1;
				yield line;
			}
			rest = buffer.subarray(start);
		}
	} finally {
		stream.destroy();
	}
}

/**
 * Read one log, from `entry.size` up to `size`, and leave `entry.size` at the end of the last
 * complete line read (see `completeLines`).
 *
 * A line that fails to parse is skipped rather than thrown on, because a log truncated by a crash
 * mid-write is a thing that happens and losing one turn's numbers is not worth losing the page
 * over. 崩溃留下的半行会停在游标之后，直到写入端下次追加前补上换行（`SessionStore.append`），
 * 它才成为一行坏行被跳过。
 */
async function readLog(path: string, entry: UsageFileEntry, size: number, providers: ProviderConfig[]): Promise<void> {
	const cursor = { at: entry.size };
	if (size <= cursor.at) return;

	try {
		for await (const line of completeLines(path, cursor, size)) {
			/*
			 * Cheaper than parsing: most records in a busy log are events, not messages.
			 *
			 * 子 Agent 的消息是这条快速通道的例外——它落盘成 `type: "event"` 里的 `subagent_message`，
			 * 所以按 `"type":"message"` 筛会把它连同别的 event 一起跳过。这一行**在 `JSON.parse` 之前**，
			 * 于是下面认得再准也够不着：改完扫描逻辑之后打点量过，`event` 记录命中 0 条。
			 *
			 * 只放行这一种 event，别的照旧跳过——这条通道的价值就在于不去解析那些跟花销无关的行。
			 */
			if (
				!line.includes('"type":"message"') &&
				!line.includes('"type":"usage"') &&
				!line.includes('"subagent_message"') &&
				// 缓存诊断要知道前缀在哪儿被有意改写：压缩（主会话和子代理）与撤回。
				!line.includes('"compacted"') &&
				!line.includes('"type":"truncate"')
			)
				continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const record = asRecord(parsed);
			if (!record) continue;
			const event = record.type === "event" ? asRecord(record.event) : null;
			if (record.type === "truncate") markCacheBoundary(streamOf(entry, "main"), "rewind");
			if (event?.type === "compacted") markCacheBoundary(streamOf(entry, "main"), "compaction");
			if (event?.type === "subagent_event" && asRecord(event.event)?.type === "compacted") {
				markCacheBoundary(streamOf(entry, `sub:${String(event.id)}`), "compaction");
			}
			/*
			 * 三个来源，都是花出去的钱。
			 *
			 * `usage` 是辅助调用（自动起标题那种），它有花销但不算一条对话消息。`message` 是主 Agent 自己
			 * 说的话。第三个是**子 Agent**——它的消息落盘成 `type: "event"` 里的 `subagent_message`，从前
			 * 这里够不着，于是一整个委派的用量在用量页上不存在。实测漏掉的量不小：用户的一个会话里子 Agent
			 * 比主 Agent 还多烧 40%，统计里少了 58%。
			 *
			 * 和辅助调用一样按 `auxiliary` 处理，因为它们在「是不是一条对话消息」这件事上是同一类：算钱，
			 * 不算条数。子 Agent 的往返是委派内部的事，混进日活消息数会让一次委派看起来像聊了几十轮。
			 */
			const subagent = event?.type === "subagent_message" ? asRecord(event.message) : null;
			const auxiliary = record.type === "usage" || subagent !== null;
			const message =
				record.type === "usage"
					? { role: "assistant", timestamp: record.ts, provider: record.providerId, model: record.modelId, usage: record.usage }
					: (subagent ?? (record.type === "message" ? asRecord(record.message) : null));
			if (!message) continue;

			const at = typeof message.timestamp === "number" ? message.timestamp : 0;
			if (!at) continue;
			const day = dayKey(at);
			entry.days[day] = (entry.days[day] ?? 0) + (auxiliary ? 0 : 1);

			if (message.role !== "assistant") continue;
			const usage = asRecord(message.usage);
			const provider = String(message.provider ?? "unknown");
			const model = String(message.model ?? "unknown");
			const bucket = bucketFor(entry, day, `${provider}/${model}`, provider, model);
			const tokens: TokenUsage = {
				input: numberAt(usage, "input"),
				output: numberAt(usage, "output"),
				cacheRead: numberAt(usage, "cacheRead"),
				cacheWrite: numberAt(usage, "cacheWrite"),
			};
			const priced = priceUsage(tokens, usage, providers, provider, model);
			// Fresh tokens, matching what the page reports as its total — these figures are shown as
			// percentages *of* that total, and counting cache reads in one but not the other would
			// put 「未计价」 over 100%.
			const tokenTotal = freshTokens(tokens);
			bucket.input += tokens.input;
			bucket.output += tokens.output;
			bucket.cacheRead += tokens.cacheRead;
			bucket.cacheWrite += tokens.cacheWrite;
			bucket.reasoning += numberAt(usage, "reasoning");
			bucket.cost += priced.cost.total;
			bucket.inputCost += priced.cost.input;
			bucket.outputCost += priced.cost.output;
			bucket.cacheReadCost += priced.cost.cacheRead;
			bucket.cacheWriteCost += priced.cost.cacheWrite;
			bucket.rawCost += priced.rawCost;
			bucket.cacheSavings += priced.cacheSavings;
			if (priced.source === "provider") bucket.providerPricedTokens += tokenTotal;
			else if (priced.source === "catalog") bucket.catalogPricedTokens += tokenTotal;
			else if (priced.source === "manual") bucket.manualPricedTokens += tokenTotal;
			else if (priced.source === "recorded") bucket.recordedPricedTokens += tokenTotal;
			else bucket.unpricedTokens += tokenTotal;
			bucket.replies += 1;
			/*
			 * 辅助调用（`usage` 记录）不在任何一条请求序列里，不诊断。主会话和每个子代理各是一条序列，
			 * 前缀互不相干，和 `pnpm audit:sessions` 第 10 节同一个分法。
			 */
			if (record.type !== "usage") {
				const stream = streamOf(entry, subagent ? `sub:${String(event?.id)}` : "main");
				const request = { ...message, provider, model, timestamp: at, usage: { ...tokens, cost: asRecord(usage?.cost) ?? {} } };
				const diagnosis = diagnoseRequest(stream, request as unknown as AssistantMessage, 0);
				if (diagnosis && diagnosis.missed > 0) {
					const miss = (bucket.cacheMiss ??= { tokens: 0, cost: 0, unpriced: 0, byCause: {} });
					miss.tokens += diagnosis.missed;
					if (diagnosis.extraCost === undefined) miss.unpriced += diagnosis.missed;
					else miss.cost += diagnosis.extraCost;
					miss.byCause[diagnosis.cause] = (miss.byCause[diagnosis.cause] ?? 0) + diagnosis.missed;
				}
			}
		}
	} finally {
		entry.size = cursor.at;
	}
}

/**
 * Every session log under `~/.plume/sessions`, as `projectId/session.jsonl`.
 *
 * **`~/.plume/sidechats` 不在这里，而且不该加进来。** 那个目录看着像一整块没人统计的花销——本机
 * 上是 241 条助手消息、3.7M 输入 token——但侧边聊天每说一句都会往它所属的主对话日志里补一条
 * `type: "usage"` 的记录（`source: "side-chat"`，上面 `readLog` 认得它）。两边逐条对过：13 个
 * 会话里条数和 token 一个不差。把快照也扫进来就是把这 222 条算两遍。
 *
 * 对不上的只有 2026-09-15 那条机制上线之前的 19 条，合计三万 token。补它们要去重，而去重的依据
 * 只有时间戳和 token 数——为一次性的三万 token 冒双重计价的险，不划算。
 */
async function logPaths(root: string): Promise<string[]> {
	const out: string[] = [];
	const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const files = await readdir(join(root, project.name)).catch(() => []);
		for (const file of files) {
			if (file.endsWith(".jsonl")) out.push(join(project.name, file));
		}
	}
	return out;
}

function addCacheMiss(into: UsageCacheMiss | undefined, add: UsageCacheMiss): UsageCacheMiss {
	const out = into ?? { tokens: 0, cost: 0, unpriced: 0, byCause: {} };
	out.tokens += add.tokens;
	out.cost += add.cost;
	out.unpriced += add.unpriced;
	for (const [cause, tokens] of Object.entries(add.byCause) as [CacheCause, number][]) out.byCause[cause] = (out.byCause[cause] ?? 0) + tokens;
	return out;
}

/**
 * Everything spent, by day and by model.
 *
 * The cache is an optimisation and never a source of truth: a file whose mtime or size disagrees
 * with what was recorded is re-read from scratch — including one that shrank, which means it was
 * rewritten rather than appended to and nothing about the old numbers can be trusted.
 */
export async function scanUsage(home = plumeHome(), providers: ProviderConfig[] = []): Promise<UsageScan> {
	const started = Date.now();
	const root = join(home, "sessions");
	const cachePath = join(home, "usage-cache.json");
	const currentPricingKey = usagePricingKey(providers);
	const cache = await readUsageCache(cachePath, currentPricingKey);

	const next: UsageFiles = {};
	const days = new Map<string, UsageDay>();
	const totals = new Map<string, UsageBucket>();
	let scanned = 0;
	let cached = 0;

	for (const relative of await logPaths(root)) {
		const path = join(root, relative);
		const info = await stat(path).catch(() => null);
		if (!info) continue;

		const known = cache[relative];
		/*
		 * Three cases, and the middle one is the whole reason this is fast.
		 *
		 * Untouched: not opened at all. Grown: read from where the last pass stopped, because the
		 * log is append-only and the previous size is a line boundary. Anything else — smaller,
		 * or the same size under a different mtime — means it was rewritten rather than appended
		 * to, and nothing recorded about it can be trusted, so it is read from the top.
		 */
		const untouched = known !== undefined && known.mtimeMs === info.mtimeMs && known.size === info.size;
		const grown = known !== undefined && !untouched && info.size > known.size;
		const entry = untouched || grown ? structuredClone(known) : emptyEntry(info.mtimeMs, 0);

		if (untouched) cached += 1;
		else {
			await readLog(path, entry, info.size, providers);
			scanned += 1;
		}
		// `entry.size` 由 `readLog` 定在最后一个完整行之后，不能拿 `info.size` 覆盖：那会越过末尾的半行。
		entry.mtimeMs = info.mtimeMs;
		next[relative] = entry;

		for (const [day, messages] of Object.entries(entry.days)) {
			const seen = days.get(day) ?? { day, sessions: 0, messages: 0 };
			// One log is one conversation, so its presence on a day is one active conversation.
			seen.sessions += 1;
			seen.messages += messages;
			days.set(day, seen);
		}
		for (const bucket of entry.buckets) {
			const id = `${bucket.day}\u0000${bucket.key}`;
			const seen = totals.get(id);
			if (!seen) {
				totals.set(id, { ...bucket, cacheMiss: bucket.cacheMiss && addCacheMiss(undefined, bucket.cacheMiss) });
				continue;
			}
			seen.input += bucket.input;
			seen.output += bucket.output;
			seen.cacheRead += bucket.cacheRead;
			seen.cacheWrite += bucket.cacheWrite;
			seen.reasoning += bucket.reasoning;
			seen.cost += bucket.cost;
			seen.inputCost += bucket.inputCost;
			seen.outputCost += bucket.outputCost;
			seen.cacheReadCost += bucket.cacheReadCost;
			seen.cacheWriteCost += bucket.cacheWriteCost;
			seen.rawCost += bucket.rawCost;
			seen.cacheSavings += bucket.cacheSavings;
			seen.providerPricedTokens += bucket.providerPricedTokens;
			seen.catalogPricedTokens += bucket.catalogPricedTokens;
			seen.manualPricedTokens += bucket.manualPricedTokens;
			seen.recordedPricedTokens += bucket.recordedPricedTokens;
			seen.unpricedTokens += bucket.unpricedTokens;
			seen.replies += bucket.replies;
			if (bucket.cacheMiss) seen.cacheMiss = addCacheMiss(seen.cacheMiss, bucket.cacheMiss);
		}
	}

	// Best effort: a cache that cannot be written costs a re-scan, which is not worth failing over.
	await writeFile(cachePath, JSON.stringify({ version: USAGE_CACHE_VERSION, pricingKey: currentPricingKey, files: next }), "utf8").catch(() => {});

	return {
		days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
		buckets: [...totals.values()].sort((a, b) => a.day.localeCompare(b.day)),
		scanned,
		cached,
		tookMs: Date.now() - started,
	};
}
