/**
 * magpie（usemagpie.ai）接管 Plume 模型时写进 `settings.json` 的那一块，以及它变成的供应商。
 *
 * magpie 的 Agent 插件（仓库里的 `integrations/magpie`）只会按点分路径原地改 JSON 的对象键，
 * 定位不到 `providers` 数组里的某一项；而 `providers` 里的 `apiKey` 每次存盘都会被挪进 vault、
 * 文件里只剩空串，magpie 恰恰靠「它写的 key 还在原处」判断这一行是否仍然接着。所以 magpie 写的是
 * 顶层的 `magpie` 对象，这里在读入时把它合成一个供应商，写盘时再拿掉——合成的那一项从不落进
 * `providers`，也不进 vault，开关全由 magpie 管。
 */

import { DEFAULT_MODEL_LIMITS } from "../model-catalog.ts";
import { thinkingOptionsFor } from "../ai/thinking-options.ts";
import type { ModelConfig, ProviderConfig, ThinkingLevel } from "../types.ts";

const MAGPIE_PROVIDER_ID = "magpie";

/** magpie 交给 Agent 插件 `connect` 的模型，原样写进文件。 */
interface MagpieModel {
	/** 网关认的 `<供应商>/<模型>`，或路由组的名字。 */
	id: string;
	name?: string;
	/** 0 表示 magpie 也不知道。 */
	context?: number;
	output?: number;
	images?: boolean;
	// magpie 不知道档位时是 null
	efforts?: string[] | null;
}

export interface MagpieGateway {
	/** 不带 `/v1` 的网关地址；适配器拼路径时会处理 `/v1`（`ai/endpoint.ts`）。 */
	baseUrl: string;
	/** magpie 给 Plume 的 key（本机是 `magpie-plume`），用量按它记在 Plume 名下。 */
	apiKey: string;
	models: MagpieModel[];
}

/**
 * 文件里的 `magpie` 块对应的供应商；不完整就是没接。
 *
 * magpie 断开时逐键删除，删空的父对象会留成 `{}`，所以缺字段是常态而不是损坏。
 */
export function magpieProvider(gateway: unknown): ProviderConfig | null {
	if (!gateway || typeof gateway !== "object") return null;
	const { baseUrl, apiKey, models } = gateway as Partial<MagpieGateway>;
	if (typeof baseUrl !== "string" || !baseUrl || typeof apiKey !== "string" || !apiKey) return null;
	return {
		id: MAGPIE_PROVIDER_ID,
		name: "Magpie",
		baseUrl,
		// 网关对 Chat Completions、Responses、Anthropic Messages 都代为翻译（magpie 的 docs/integrating.md），
		// 一个供应商只能选一种，选哪种都通。
		api: "openai-responses",
		apiKey,
		enabled: true,
		models: (Array.isArray(models) ? models : []).filter((model) => typeof model?.id === "string" && model.id).map(toModel),
	};
}

function toModel(model: MagpieModel): ModelConfig {
	// magpie 把「不思考」叫 none，Plume 叫 off；其余档位名两边相同，不认识的由 thinkingOptionsFor 丢掉。
	const levels = (model.efforts ?? []).map((effort): ThinkingLevel => (effort === "none" ? "off" : effort));
	return {
		id: `${MAGPIE_PROVIDER_ID}/${model.id}`,
		providerId: MAGPIE_PROVIDER_ID,
		modelId: model.id,
		name: model.name || model.id,
		contextWindow: model.context || DEFAULT_MODEL_LIMITS.contextWindow,
		maxOutputTokens: model.output || DEFAULT_MODEL_LIMITS.maxOutputTokens,
		// 档位未知时按目录外模型的规矩全开（见 DEFAULT_MODEL_LIMITS），用默认四档。
		supportsThinking: DEFAULT_MODEL_LIMITS.supportsThinking,
		...(levels.length > 0 ? { thinkingOptions: thinkingOptionsFor(levels) } : {}),
		supportsImages: model.images ?? DEFAULT_MODEL_LIMITS.supportsImages,
		supportsTools: DEFAULT_MODEL_LIMITS.supportsTools,
	};
}

/** 读入后：把 magpie 的供应商排在用户自己的后面。 */
export function withMagpieProvider<T extends { providers: ProviderConfig[]; magpie?: unknown }>(settings: T): T {
	const provider = magpieProvider(settings.magpie);
	if (!provider) return settings;
	return { ...settings, providers: [...withoutMagpieProvider(settings.providers), provider] };
}

/** 写盘前：合成的那一项不进文件。 */
export function withoutMagpieProvider(providers: ProviderConfig[]): ProviderConfig[] {
	return providers.filter((provider) => provider.id !== MAGPIE_PROVIDER_ID);
}
