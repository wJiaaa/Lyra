/**
 * 缓存路由键（`RequestOptions.cacheKey`）怎么带给服务商：对哪类端点、用请求体字段还是请求头。
 *
 * 缓存命中是按机器算的。同一条对话前缀的请求被负载均衡打散到别的机器（或 OpenRouter 换了一家上游），
 * 前缀再一样也是全价重算。路由键就是告诉服务商「这几次请求是同一条对话，送到同一处」。
 *
 * 两张声明表：`CACHE_CARRIERS` 说有哪几种携带方式，`CACHE_ROUTING_RULES` 说哪类端点用哪几种。
 * **新增一个服务商 = 在 `CACHE_ROUTING_RULES` 里加一行**；新增一种携带方式 = 在 `CACHE_CARRIERS`
 * 里加一行、在 `types/provider.ts` 的 `CacheCarrierId` 里加它的名字（漏一边编译不过），用户配置
 * （`ProviderConfig.cacheRouting`）随即就能点名它。各端点默认选择的依据写在每行的
 * `source` 里，长篇取舍见 `docs/architecture/context-assembly.md` 的「缓存路由键」一节。
 *
 * Anthropic 协议没有对应字段（它的缓存由 `cache_control` 断点显式声明），那条链不调 `cacheRouting`。
 *
 * 端点硬性要求的会话头（例如 OpenCode Go 的 `x-opencode-session`，缺了直接 400）不进这两张表，
 * 三种协议都要带、也不受 `cacheRouting: off` 影响，见 `sessionHeaders`。
 */

import { randomUUID } from "node:crypto";
import type { ApiFormat, CacheCarrierId, ProviderConfig } from "../types.ts";
import type { DroppedParam } from "./request-params-compat.ts";

/** 一种携带方式。 */
interface CacheCarrier {
	kind: "body" | "header";
	/** 请求体字段名或请求头名。 */
	name: string;
	/** 服务商对值的长度上限；超出时压成定长摘要，见 `fitKey`。 */
	maxLength: number;
	/**
	 * 被拒之后学会不再发的那个参数轴，见 `request-params-compat.ts`。
	 *
	 * 只有请求体字段需要：严格端点对未知字段 400，而对未知请求头几乎都是忽略。
	 */
	learnable?: DroppedParam;
	source: string;
}

const CACHE_CARRIERS = {
	prompt_cache_key: {
		kind: "body",
		name: "prompt_cache_key",
		maxLength: 64,
		learnable: "cache-key",
		source: "OpenAI 文档：Chat Completions 与 Responses 都有这个字段；上限 64 字符同 pi openai-prompt-cache.ts",
	},
	"x-session-id": {
		kind: "header",
		name: "x-session-id",
		maxLength: 256,
		source: "OpenRouter 文档 prompt-caching：sticky routing 键，≤256 字符；pi 的 sessionAffinityFormat=openrouter 同此",
	},
} as const satisfies Record<CacheCarrierId, CacheCarrier>;

/** 一类端点的默认携带方式。 */
interface CacheRoutingRule {
	/** 匹配 baseUrl 的主机名，本身或其子域都算。空数组表示兜底（匹配一切）。 */
	hosts: readonly string[];
	carriers: readonly CacheCarrierId[];
	source: string;
}

/** 从上往下第一条匹配的生效，所以兜底那一行必须在最后。 */
const CACHE_ROUTING_RULES: readonly CacheRoutingRule[] = [
	{
		hosts: ["api.openai.com"],
		carriers: ["prompt_cache_key"],
		source: "OpenAI 文档：prompt_cache_key 参与缓存路由，替代旧的 user 字段",
	},
	{
		hosts: ["openrouter.ai"],
		carriers: ["x-session-id"],
		source: "OpenRouter 文档：x-session-id 直接作为 sticky routing 键，优先于 prompt_cache_key",
	},
	{
		hosts: ["api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"],
		carriers: ["prompt_cache_key"],
		source: "Kimi Chat API 文档：prompt_cache_key，建议传会话 id",
	},
	{
		hosts: ["api.deepseek.com"],
		carriers: [],
		source: "DeepSeek 文档：硬盘缓存按前缀自动命中，没有路由参数——发了也没用",
	},
	{
		hosts: ["generativelanguage.googleapis.com"],
		carriers: [],
		source: "推断：Google API 的 JSON 解析对未知字段报 Unknown name 400；隐式缓存自动，无路由参数",
	},
	{
		hosts: [],
		carriers: ["prompt_cache_key"],
		source:
			"通用中转（new-api / one-api / LiteLLM 等）多把请求体原样转给 OpenAI 系上游，带上才有用；" +
			"严格端点对未知字段 400 时错误串会点名它，撞一次就学会不发（request-params-compat.ts 的 cache-key）",
	},
];

/** 这次请求要加到请求体和请求头里的东西。 */
export interface CacheRouting {
	body: Record<string, string>;
	headers: Record<string, string>;
}

const NONE: CacheRouting = Object.freeze({ body: Object.freeze({}), headers: Object.freeze({}) }) as CacheRouting;

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** 这个端点默认用哪几种携带方式。导出给测试和文档对照。 */
export function defaultCarriers(baseUrl: string): readonly CacheCarrierId[] {
	const host = hostOf(baseUrl);
	const rule = CACHE_ROUTING_RULES.find(
		(candidate) => candidate.hosts.length === 0 || candidate.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
	);
	return rule?.carriers ?? [];
}

/** FNV-1a 32 位，两个种子拼成 16 位十六进制。只求稳定、分散，不求抗碰撞攻击——键本身不是秘密。 */
function digest(text: string): string {
	const run = (seed: number) => {
		let hash = seed;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	};
	return run(0x811c9dc5) + run(0x050c5d1f);
}

/**
 * 键放得进这个位置就原样用；放不进（超长，或有请求头容不下的字符）就压成「可读前缀-摘要」。
 *
 * 不照抄 pi 的截断：主会话 `<会话 id>` 和子代理 `<会话 id>-sub-<n>` 这类共享长前缀的键，截到 64 字符
 * 后会变成同一个，子代理和主会话被路由成同一条对话。摘要取的是整条键，区分得开。
 * 请求头的值必须是可见 ASCII，否则 `fetch` 直接抛 TypeError——整个请求发不出去。
 */
export function fitKey(key: string, maxLength: number): string {
	if (key.length <= maxLength && /^[\x21-\x7e]+$/.test(key)) return key;
	const hash = digest(key);
	const head = key.replace(/[^\x21-\x7e]/g, "").slice(0, Math.max(0, maxLength - hash.length - 1));
	return head ? `${head}-${hash}` : hash.slice(0, maxLength);
}

/**
 * 这次请求该带什么。没有 `cacheKey`、Anthropic 协议、配置关掉、或者请求体字段已经撞墙学过，都返回空。
 *
 * `dropped` 对用户点名的方式也生效：点名了而端点拒绝，照样撤掉——否则每一轮都是同一个 400。
 */
export function cacheRouting(
	provider: Pick<ProviderConfig, "baseUrl" | "cacheRouting">,
	api: ApiFormat,
	cacheKey: string | undefined,
	dropped: ReadonlySet<DroppedParam>,
): CacheRouting {
	if (!cacheKey || api === "anthropic-messages") return NONE;
	const mode = provider.cacheRouting ?? "auto";
	if (mode === "off") return NONE;
	const carriers = mode === "auto" ? defaultCarriers(provider.baseUrl) : CACHE_CARRIERS[mode] ? [mode] : [];
	const routing: CacheRouting = { body: {}, headers: {} };
	for (const id of carriers) {
		const carrier: CacheCarrier = CACHE_CARRIERS[id];
		if (carrier.learnable && dropped.has(carrier.learnable)) continue;
		const value = fitKey(cacheKey, carrier.maxLength);
		if (carrier.kind === "body") routing.body[carrier.name] = value;
		else routing.headers[carrier.name] = value;
	}
	return routing;
}

/** OpenCode Go 的地址：目录里 `/zen/go` 和 `/zen/go/v1` 两种写法都有。Zen（`/zen/v1`）不要求会话头。 */
function isOpenCodeGo(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		const host = url.hostname.toLowerCase();
		const path = url.pathname.replace(/\/+$/, "").toLowerCase();
		return (host === "opencode.ai" || host.endsWith(".opencode.ai")) && (path === "/zen/go" || path === "/zen/go/v1");
	} catch {
		return false;
	}
}

/**
 * 端点硬性要求的会话头。三种协议都走这里，Anthropic 协议也不例外，也不看 `cacheRouting`——
 * 这不是可选的路由提示，缺了请求就发不出去。
 *
 * 目前只有 OpenCode Go 的 `x-opencode-session`（缺了直接 400），写死同 ZCode `opencode-session.ts`。
 * 没有 `cacheKey`（压缩、测试连接这类一次性请求）时换成一个随机 id 而不是不带：随机 id 只是失去路由，
 * 请求照样能发。调用方每次请求算一次，重试沿用同一个结果。
 */
export function sessionHeaders(baseUrl: string, cacheKey: string | undefined): Record<string, string> {
	if (!isOpenCodeGo(baseUrl)) return {};
	return { "x-opencode-session": fitKey(cacheKey || randomUUID(), 256) };
}
