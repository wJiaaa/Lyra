import type { RetryPolicySource } from "../config/retry-policy.ts";
import type { Failure } from "../ai/failure.ts";
/**
 * Models, providers, and the stream a request comes back as.
 *
 * Lyra speaks two wire formats and no others. Everything above this line is expressed in the
 * neutral message shape; everything below it is a provider's own idea of a request.
 */

import type { AssistantMessage, Message } from "./message.ts";
import type { ToolSpec } from "./tool.ts";

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

/**
 * Wire formats Lyra speaks. Chat Completions is deliberately excluded: the product
 * targets Responses and Anthropic Messages only.
 */
export type ApiFormat = "openai-responses" | "anthropic-messages" | "openai-chat-completions";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | (string & {});

export interface ThinkingOption {
	id: ThinkingLevel;
	label: string;
	detail: string;
	isDefault?: boolean;
	/** Required for a nonstandard effort name on the budget-based Anthropic adapter. */
	budgetTokens?: number;
}

export interface ModelPricing {
	/** USD per million tokens. */
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Higher rates selected when one request crosses a context threshold. */
	tiers?: ModelPricingTier[];
	/** Manual values always take precedence over catalogue defaults. */
	source?: "manual" | "catalog";
	catalogProvider?: string;
	catalogVersion?: string;
	/** The exact reference entry, including when the endpoint uses a relay alias. */
	catalogModel?: string;
}

export interface ModelPricingTier {
	aboveTokens: number;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelConfig {
	/** Stable local id, unique across providers: `${providerId}/${modelId}`. */
	id: string;
	providerId: string;
	/** Id sent to the provider. */
	modelId: string;
	/** Label shown in the UI. */
	name: string;
	contextWindow: number;
	maxOutputTokens: number;
	supportsThinking: boolean;
	supportsImages: boolean;
	supportsTools: boolean;
	pricing?: ModelPricing;
	/**
	 * 这个模型可选的思考档位，从模型目录填入或在模型编辑器里勾选；不填用默认四档。
	 * 列表里没有 `off` 表示关不掉思考：选「关闭」时落到最浅的一档。
	 */
	thinkingOptions?: ThinkingOption[];
	/** Extra sampling parameters merged verbatim into the request body. */
	samplingParams?: Record<string, unknown>;
}

/**
 * 缓存路由键的携带方式。每一个都在 `ai/cache-routing.ts` 的 `CACHE_CARRIERS` 里有一行声明——那张表用
 * `satisfies Record<CacheCarrierId, …>` 约束，这里加了名字而那边没加行，编译不过。
 *
 * 名字写在这里而不是从那边推出来：那边要 import 本文件的类型，反过来引就成环了。
 */
export type CacheCarrierId = "prompt_cache_key" | "x-session-id";

/** `auto` 按端点自动选；`off` 一律不带；点名一种方式就只用它。 */
export type CacheRoutingMode = "auto" | "off" | CacheCarrierId;

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	api: ApiFormat;
	apiKey: string;
	enabled: boolean;
	/**
	 * 缓存路由键（`RequestOptions.cacheKey`）怎么带。缺省等于 `auto`：按端点自动选，见 `ai/cache-routing.ts`。
	 * `off` 给那种拒绝未知字段、错误里又不点名字段的严格端点——自动学习认不出它，只能手动关。
	 */
	cacheRouting?: CacheRoutingMode;
	models: ModelConfig[];
}

export interface RequestOptions {
	signal?: AbortSignal;
	maxTokens?: number;
	temperature?: number;
	thinking?: ThinkingLevel;
	/** Merged over `ModelConfig.samplingParams`. */
	samplingParams?: Record<string, unknown>;
	fetch?: typeof globalThis.fetch;
	/**
	 * 同一条对话前缀的稳定标识，让服务商把这些请求路由到同一处缓存（OpenAI 的 `prompt_cache_key`、
	 * OpenRouter 的 `x-session-id` 等，按端点选择见 `ai/cache-routing.ts`）。
	 *
	 * 前缀不同的对话要用不同的键：主会话传会话 id，子代理传各自区分开的 id——共用一个键会把不相干的
	 * 前缀挤到同一台机器上，互相顶掉缓存。不传就什么都不带。
	 */
	cacheKey?: string;
	/** Inspect or rewrite the outgoing body — used by the request inspector in the UI. */
	onPayload?: (payload: unknown) => void;
	/**
	 * How many times to attempt the request, including the first.
	 *
	 * Only the connection is retried, never a stream already in flight. 1 disables it.
	 */
	retryAttempts?: number;
	retryPolicy?: RetryPolicySource;
	/** Told about each wait, so the UI can say why a turn is taking longer than usual. */
	onRetry?: (info: { attempt: number; delayMs: number; reason: string; failure?: Failure }) => void;
}

export interface LlmContext {
	systemPrompt: string;
	messages: Message[];
	tools: ToolSpec[];
}

// ---------------------------------------------------------------------------
// Streaming events emitted by provider adapters
// ---------------------------------------------------------------------------

export type StreamEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; index: number }
	| { type: "text_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; index: number }
	| { type: "thinking_start"; index: number }
	| { type: "thinking_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; index: number }
	| { type: "toolcall_start"; index: number; id: string; name: string }
	| { type: "toolcall_delta"; index: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; index: number; partial: AssistantMessage }
	| { type: "done"; message: AssistantMessage }
	| { type: "error"; error: string; message: AssistantMessage };

export interface Provider {
	readonly api: ApiFormat;
	stream(
		provider: ProviderConfig,
		model: ModelConfig,
		context: LlmContext,
		options: RequestOptions,
	): AsyncGenerator<StreamEvent, AssistantMessage>;
}
