/**
 * 智能配置：按模型 ID、API 格式和 Base URL 给出推荐的上限与能力。
 *
 * 规则移植自 ZCode 的内置推荐配置（Apache-2.0），由 `scripts/update-model-rules.mjs` 生成
 * `catalog/model-rules.json`。解析时从前往后逐条叠加，命中一条就覆盖它给出的字段，所以越靠后越
 * 具体：先是只按模型 ID 的通用规则，再是限定 API 格式的，最后是限定站点的。第一条必须是 `.*` 兜底
 * 且五项齐全，于是任何模型都能得到一份完整的推荐。
 *
 * 用户改过的字段记在 `ModelConfig.overrides`，逐项脱离推荐；其余字段在规则更新后自动跟着变。
 * 价格不在这里：用量估价仍查 models.dev 快照，见 `model-catalog.ts`。
 *
 * 这个文件不碰文件系统和网络——渲染进程也要用它预览推荐值。远程更新见 `model-rules-sync.ts`。
 */

import bundledJson from "./catalog/model-rules.json" with { type: "json" };
import type { ModelConfig, ProviderConfig, SmartField } from "./types/provider.ts";

export const SMART_FIELDS: readonly SmartField[] = ["contextWindow", "maxOutputTokens", "supportsThinking", "supportsImages", "supportsTools"];

export type RecommendedConfig = Pick<ModelConfig, SmartField>;

export interface ModelRule {
	/** 模型 ID 的正则，整串匹配，忽略大小写。 */
	model: string;
	/** API 格式的正则，缺省不限。 */
	api?: string;
	/** Base URL 的正则，缺省不限。 */
	baseUrl?: string;
	config: Partial<RecommendedConfig>;
}

export interface ModelRulesDocument {
	schema: 1;
	source: {
		name: string;
		repository: string;
		revision: number;
		commit: string;
		/** 比较新旧用的时间戳：远程规则只在比当前的新时才替换。 */
		updatedAt: string;
		license: string;
	};
	rules: ModelRule[];
}

interface CompiledRule {
	model: RegExp;
	api?: RegExp;
	baseUrl?: RegExp;
	config: Partial<RecommendedConfig>;
}

const NUMBER_FIELDS = new Set<SmartField>(["contextWindow", "maxOutputTokens"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pattern(value: unknown, where: string): RegExp {
	if (typeof value !== "string" || !value) throw new Error(`${where}: 缺少匹配正则`);
	return new RegExp(`^(?:${value})$`);
}

function ruleConfig(value: unknown, where: string): Partial<RecommendedConfig> {
	if (!isRecord(value)) throw new Error(`${where}: config 不是对象`);
	const config: Partial<Record<SmartField, number | boolean>> = {};
	for (const [key, field] of Object.entries(value)) {
		if (!SMART_FIELDS.includes(key as SmartField)) throw new Error(`${where}: 不认识的字段 ${key}`);
		const ok = NUMBER_FIELDS.has(key as SmartField) ? Number.isInteger(field) && (field as number) > 0 : typeof field === "boolean";
		if (!ok) throw new Error(`${where}: ${key} 的值不合法`);
		config[key as SmartField] = field as number | boolean;
	}
	return config as Partial<RecommendedConfig>;
}

/**
 * 校验一份规则文档。远程拉来的内容走同一道校验，不合法就整份拒绝，不会半套生效。
 */
export function parseModelRules(value: unknown): ModelRulesDocument {
	if (!isRecord(value) || value.schema !== 1) throw new Error("不支持的规则格式");
	const source = value.source;
	if (!isRecord(source) || typeof source.updatedAt !== "string" || Number.isNaN(Date.parse(source.updatedAt))) {
		throw new Error("规则来源缺少 updatedAt");
	}
	if (!Array.isArray(value.rules) || value.rules.length === 0) throw new Error("规则为空");
	const rules = value.rules.map((rule, index): ModelRule => {
		const where = `rules[${index}]`;
		if (!isRecord(rule)) throw new Error(`${where}: 不是对象`);
		for (const key of ["model", "api", "baseUrl"] as const) {
			if (key === "model" || rule[key] !== undefined) pattern(rule[key], `${where}.${key}`);
		}
		return {
			model: rule.model as string,
			...(rule.api === undefined ? {} : { api: rule.api as string }),
			...(rule.baseUrl === undefined ? {} : { baseUrl: rule.baseUrl as string }),
			config: ruleConfig(rule.config, where),
		};
	});
	const fallback = rules[0];
	if (fallback.model !== ".*" || fallback.api || fallback.baseUrl || SMART_FIELDS.some((field) => fallback.config[field] === undefined)) {
		throw new Error("第一条规则必须是五项齐全的 .* 兜底");
	}
	return { schema: 1, source: source as unknown as ModelRulesDocument["source"], rules };
}

function compile(document: ModelRulesDocument): CompiledRule[] {
	return document.rules.map((rule) => ({
		model: new RegExp(`^(?:${rule.model})$`, "i"),
		...(rule.api ? { api: pattern(rule.api, "api") } : {}),
		...(rule.baseUrl ? { baseUrl: pattern(rule.baseUrl, "baseUrl") } : {}),
		config: rule.config,
	}));
}

const BUNDLED = parseModelRules(bundledJson);
let active = BUNDLED;
let compiled = compile(active);

/** 当前生效的规则：打包的那份，或更新过的远程版本。 */
export function activeModelRules(): ModelRulesDocument {
	return active;
}

/**
 * 换上一份规则，只在它比当前的新时生效。返回是否真的换了。
 *
 * 按 `updatedAt` 比而不是无条件替换：应用升级后打包的规则可能比本地缓存的远程版本还新。
 */
export function installModelRules(document: ModelRulesDocument): boolean {
	if (Date.parse(document.source.updatedAt) <= Date.parse(active.source.updatedAt)) return false;
	compiled = compile(document);
	active = document;
	return true;
}

/** 测试用：回到打包的规则。 */
export function resetModelRules(): void {
	active = BUNDLED;
	compiled = compile(active);
}

/**
 * Base URL 的几种等价写法。
 *
 * Lyra 的请求地址是 `baseUrl` 再补 `/v1/...`（已经以 `/v1` 结尾就不重复），所以 `https://x/v1`
 * 和 `https://x` 指的是同一个端点；规则里有的带 `/v1`（OpenAI 系）有的不带（Anthropic 系），两种都试。
 */
function baseUrlVariants(baseUrl: string): string[] {
	let normalized: string;
	try {
		const url = new URL(baseUrl);
		normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
	} catch {
		return [];
	}
	return normalized.endsWith("/v1") ? [normalized, normalized.slice(0, -3)] : [normalized, `${normalized}/v1`];
}

/**
 * 这个模型的推荐配置。`specific` 表示除兜底外还有规则命中——没有的话推荐值只是通用默认。
 */
export function resolveModelRules(
	provider: Pick<ProviderConfig, "baseUrl" | "api">,
	modelId: string,
): { config: RecommendedConfig; specific: boolean } {
	const id = modelId.trim();
	const urls = baseUrlVariants(provider.baseUrl);
	let config = {} as RecommendedConfig;
	let hits = 0;
	for (const rule of compiled) {
		if (!rule.model.test(id)) continue;
		if (rule.api && !rule.api.test(provider.api)) continue;
		if (rule.baseUrl && !urls.some((url) => rule.baseUrl!.test(url))) continue;
		config = { ...config, ...rule.config };
		hits++;
	}
	return { config, specific: hits > 1 };
}

/** 旧版导入写下的那组固定值：没有来源标记、200K/16K、三样能力全开。它们一直是跟随目录的。 */
function legacyImport(model: ModelConfig): boolean {
	return !model.metadataSource && model.contextWindow === 200_000 && model.maxOutputTokens === 16_384 &&
		model.supportsThinking && model.supportsImages && model.supportsTools;
}

/**
 * 按智能配置补全一个模型。设置每次读写都会经过这里，所以必须幂等。
 *
 * 旧数据迁移：`metadataSource: "catalog"`（跟随 models.dev 目录）和旧导入的固定值都转成智能配置；
 * 其余没有标记的旧模型是人手定的值，原样保留。
 */
export function withSmartConfig(provider: Pick<ProviderConfig, "baseUrl" | "api">, model: ModelConfig): ModelConfig {
	const smart = model.metadataSource === "smart" || (model.metadataSource as string) === "catalog" || legacyImport(model);
	if (!smart) return model;
	const { config } = resolveModelRules(provider, model.modelId);
	const pinned = new Set(model.overrides ?? []);
	const next: ModelConfig = { ...model, metadataSource: "smart" };
	for (const field of SMART_FIELDS) {
		if (!pinned.has(field)) Object.assign(next, { [field]: config[field] });
	}
	// 推荐的输出上限可能比用户手动定的窗口还大；输出跟随推荐时不能超过窗口。
	if (!pinned.has("maxOutputTokens")) next.maxOutputTokens = Math.min(next.maxOutputTokens, next.contextWindow);
	return next;
}
