/**
 * 逐次请求的提示缓存诊断：本该命中而没命中多少 token、多花了多少钱、大概是什么原因。
 *
 * 累计命中率只能说明「整体还行」，说不出前缀是在哪一次请求被打断的。这里对一条请求序列逐次比较：
 * 上一次请求的输入总量（input + cacheRead + cacheWrite）就是这一次理应从缓存读到的前缀，
 * 实际 cacheRead 与它的差就是未命中。纯函数，只读 `Usage`，不碰各服务商字段的解析。
 *
 * 口径与取舍（演进和对照见 `docs/architecture/context-assembly.md`「缓存未命中诊断」）：
 *
 * - 期望前缀取 `min(上一次输入, 这一次输入)`：这一次比上一次短，最多也只能读到这一次的全部。
 * - 服务商从未报告过缓存（cacheRead 与 cacheWrite 一直为 0）时判不了，归 `uncached`、不计未命中；
 *   报告过之后再出现全零，才算一次整段未命中——只报 cacheRead 的 OpenAI 系正是这样。按
 *   「服务商/模型」记，而不是按服务商：中转站同一个服务商下常混着会缓存和不会缓存的模型。
 * - 压缩/撤回边界之后的第一次请求，前缀是有意改写的，原因记 `compaction` / `rewind`，
 *   不算前缀被打断；未命中量照样算出来，那是这次改写真实付出的代价。
 * - 其余的按回复上记下的前缀指纹（`AssistantMessage.prefix`，见 `ai/prefix-fingerprint.ts`）分：
 *   第一处变化落在工具、系统提示词还是消息上，就是本地改了哪里；量过而前缀没变，是服务商那边
 *   没读到。没有指纹的（旧日志、重启后的第一次请求）才是 `unknown`。
 * - 不按缓存有效期归类：各家留多久不同，中转更说不准，按一个猜的时长把未命中记成「过期」，
 *   会把真正的打断藏起来。间隔照实记在 `idleMs`，由看的人对照。
 * - 时间间隔用两次请求的开始时间相减：缓存在读写时续期，而那发生在请求一开始的预填充阶段。
 */

import { requestUsage, type AssistantMessage, type Message, type RequestPrefix, type Usage } from "../types.ts";
import { costAtRates } from "../utils/pricing.ts";

/**
 * 未命中量不超过这个数就当作命中。
 *
 * 缓存按块计：OpenAI 以 128 token 为步长、从 1024 起；DeepSeek 以 64 token 为单位；Anthropic
 * 低于 1024（Haiku 2048）的前缀不缓存。本机真实会话里，前缀完全稳定的请求也会差出几十个
 * token。这一段是粒度噪声，不是打断。
 */
export const CACHE_NOISE_FLOOR_TOKENS = 1024;

export type CacheCause =
	/** 序列里第一次请求：没有上一次可比，冷启动。 */
	| "first"
	/** 未命中量在噪声线内。 */
	| "hit"
	/** 这个服务商/模型从未报告过缓存，无从判断。 */
	| "uncached"
	/** 换了模型或服务商，缓存本来就不共享。 */
	| "model"
	/** 压缩（摘要或剪枝）之后的第一次请求，前缀被有意重写。 */
	| "compaction"
	/** 撤回历史之后的第一次请求。 */
	| "rewind"
	/** 本地请求的工具定义和上一次不同：三条协议里它都排在最前面，改一处整段重算。 */
	| "tools"
	/** 本地请求的系统提示词和上一次不同。 */
	| "prompt"
	/** 已经发出去的某条消息这次发得不一样了（剪枝、协议编码等）。 */
	| "rewrite"
	/** 前缀逐段和上一次相同，却没读到：服务商清掉了缓存，或路由到了没有它的节点。`idleMs` 帮着分辨。 */
	| "provider"
	/** 没有前缀指纹可比，或变的是请求参数（thinking 等）：分不清是本地改动还是服务商没读到。 */
	| "unknown";

export const CACHE_CAUSES: readonly CacheCause[] = ["first", "hit", "uncached", "model", "compaction", "rewind", "tools", "prompt", "rewrite", "provider", "unknown"];

/** 模型看到的历史被有意改写的位置：`at` 是它之前的那条消息在 `messages` 里的下标，与 `SessionLog.compactions` 同义。 */
export interface CacheBoundary {
	at: number;
	kind: "compaction" | "rewind";
}

export interface CacheDiagnosticsOptions {
	boundaries?: readonly CacheBoundary[];
	noiseFloorTokens?: number;
}

export interface CacheRequestDiagnosis {
	/** 这条助手消息在 `messages` 里的下标。 */
	index: number;
	/** 序列里第几次（有用量的）请求，从 1 开始。 */
	ordinal: number;
	provider: string;
	model: string;
	timestamp: number;
	/** 这一次的输入总量：input + cacheRead + cacheWrite。 */
	prompt: number;
	/** 理应从缓存读到的前缀。 */
	expected: number;
	cacheRead: number;
	/** 本该命中而没命中的 token；`hit`、`first`、`uncached` 为 0。 */
	missed: number;
	/** 这些 token 按实付单价而不是缓存读单价计费多花的美元；不知道价格时为 undefined。 */
	extraCost: number | undefined;
	/** 距上一次请求开始的毫秒数；第一次请求没有。 */
	idleMs: number | undefined;
	cause: CacheCause;
	/** 本地请求前缀从哪里开始变的；`cause` 的 `tools` / `prompt` / `rewrite` / `provider` 由它而来。 */
	prefix?: RequestPrefix;
}

/**
 * 一条请求序列诊断到哪儿了。只含可 JSON 序列化的值：用量页的扫描器把它存进增量缓存，日志长了
 * 从上次停下的地方接着诊断，而不是从头重读。
 */
export interface CacheDiagnosisState {
	/** 上一次有用量的请求。 */
	previous?: { prompt: number; key: string; timestamp: number };
	/** 报告过缓存的「服务商/模型」。 */
	reported: string[];
	/** 上一次请求之后越过的边界；两种都越过时记压缩，它改写得更彻底。 */
	crossed?: CacheBoundary["kind"];
	/** 已诊断的请求数。 */
	requests: number;
}

export function newCacheDiagnosisState(): CacheDiagnosisState {
	return { reported: [], requests: 0 };
}

/** 记下模型看到的历史在这里被有意改写，下一次请求的未命中归到它名下。 */
export function markCacheBoundary(state: CacheDiagnosisState, kind: CacheBoundary["kind"]): void {
	if (state.crossed !== "compaction") state.crossed = kind;
}

const promptOf = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;

/** 这次请求的输入总量；0 是没发出去或没报用量，诊断跳过它，前缀指纹的基准也不从它推进。 */
export function requestPrompt(message: AssistantMessage): number {
	return promptOf(requestUsage(message));
}
const keyOf = (message: AssistantMessage) => `${message.provider}/${message.model}`;

function prefixCause(prefix: RequestPrefix | undefined): CacheCause {
	if (!prefix) return "unknown";
	const segment = prefix.change?.segment;
	if (segment === undefined) return "provider";
	if (segment === "tools") return "tools";
	if (segment === "system") return "prompt";
	// thinking 档位这类参数：有的会让缓存失效、有的不会，证据不够分清，不归到服务商头上。
	if (segment === "params") return "unknown";
	return "rewrite";
}

/** 诊断序列里的下一次请求，推进 `state`。没有用量的请求（失败在发出前）不算，返回 undefined。 */
export function diagnoseRequest(
	state: CacheDiagnosisState,
	message: AssistantMessage,
	index: number,
	options: Omit<CacheDiagnosticsOptions, "boundaries"> = {},
): CacheRequestDiagnosis | undefined {
	// One request's prompt, not the retry-inclusive bill — a retried turn would read as a doubled prefix.
	const usage = requestUsage(message);
	const prompt = requestPrompt(message);
	if (!(prompt > 0)) return undefined;

	const floor = options.noiseFloorTokens ?? CACHE_NOISE_FLOOR_TOKENS;
	const previous = state.previous;
	const key = keyOf(message);
	const idleMs = previous ? Math.max(0, message.timestamp - previous.timestamp) : undefined;
	const expected = previous ? Math.min(previous.prompt, prompt) : 0;
	let missed = Math.max(0, expected - usage.cacheRead);
	let cause: CacheCause;
	if (!previous) cause = "first";
	else if (missed <= floor) cause = "hit";
	else if (state.crossed) cause = state.crossed;
	else if (previous.key !== key) cause = "model";
	else if (usage.cacheRead + usage.cacheWrite === 0 && !state.reported.includes(key)) cause = "uncached";
	else cause = prefixCause(message.prefix);
	if (cause === "first" || cause === "hit" || cause === "uncached") missed = 0;

	state.requests++;
	if (usage.cacheRead + usage.cacheWrite > 0 && !state.reported.includes(key)) state.reported.push(key);
	state.previous = { prompt, key, timestamp: message.timestamp };
	state.crossed = undefined;
	return {
		index,
		ordinal: state.requests,
		provider: message.provider,
		model: message.model,
		timestamp: message.timestamp,
		prompt,
		expected,
		cacheRead: usage.cacheRead,
		missed,
		extraCost: missed > 0 ? extraCostOf(message, missed) : 0,
		idleMs,
		cause,
		...(message.prefix ? { prefix: message.prefix } : {}),
	};
}

/** 对一条请求序列（主会话或某个子代理各自一条）逐次诊断。没有用量的请求（失败在发出前）跳过。 */
export function diagnoseCache(messages: readonly Message[], options: CacheDiagnosticsOptions = {}): CacheRequestDiagnosis[] {
	const boundaries = [...(options.boundaries ?? [])].sort((a, b) => a.at - b.at);
	const state = newCacheDiagnosisState();
	const out: CacheRequestDiagnosis[] = [];
	let nextBoundary = 0;

	for (let index = 0; index < messages.length; index++) {
		while (nextBoundary < boundaries.length && boundaries[nextBoundary].at <= index) {
			markCacheBoundary(state, boundaries[nextBoundary].kind);
			nextBoundary++;
		}
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const diagnosis = diagnoseRequest(state, message, index, options);
		if (diagnosis) out.push(diagnosis);
	}
	return out;
}

/**
 * 未命中的 token 落在 input 或 cacheWrite 里（后者在 Anthropic 还有写入溢价），按这两桶的
 * 加权实付单价计，减去同样数量按缓存读单价的花费。只用请求当时存下的费率，之后价目表更新不会
 * 改写历史；没存费率（模型没配定价）就只报 token、不报钱。
 */
function extraCostOf(message: AssistantMessage, missed: number): number | undefined {
	const usage = requestUsage(message);
	const rates = usage.cost.rates;
	if (!rates) return undefined;
	const paidTokens = usage.input + usage.cacheWrite;
	if (paidTokens <= 0) return 0;
	const paid = costAtRates({ input: usage.input, output: 0, cacheRead: 0, cacheWrite: usage.cacheWrite }, rates).total;
	const asRead = costAtRates({ input: 0, output: 0, cacheRead: paidTokens, cacheWrite: 0 }, rates).total;
	return Math.max(0, ((paid - asRead) * missed) / paidTokens);
}

export interface CacheCauseTotals {
	requests: number;
	missed: number;
	extraCost: number;
}

export interface CacheDiagnosticsSummary {
	requests: number;
	expected: number;
	cacheRead: number;
	missed: number;
	/** 有定价的那部分未命中多花的美元。 */
	extraCost: number;
	/** 没有定价、算不出钱的未命中 token。 */
	unpricedMissed: number;
	byCause: Record<CacheCause, CacheCauseTotals>;
}

export function summarizeCacheDiagnoses(diagnoses: readonly CacheRequestDiagnosis[]): CacheDiagnosticsSummary {
	const byCause = Object.fromEntries(CACHE_CAUSES.map((cause) => [cause, { requests: 0, missed: 0, extraCost: 0 }])) as Record<CacheCause, CacheCauseTotals>;
	const summary: CacheDiagnosticsSummary = { requests: 0, expected: 0, cacheRead: 0, missed: 0, extraCost: 0, unpricedMissed: 0, byCause };
	for (const item of diagnoses) {
		summary.requests++;
		summary.expected += item.expected;
		summary.cacheRead += item.cacheRead;
		summary.missed += item.missed;
		if (item.extraCost === undefined) summary.unpricedMissed += item.missed;
		else summary.extraCost += item.extraCost;
		const bucket = byCause[item.cause];
		bucket.requests++;
		bucket.missed += item.missed;
		bucket.extraCost += item.extraCost ?? 0;
	}
	return summary;
}
