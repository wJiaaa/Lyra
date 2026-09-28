/**
 * Anthropic Messages API adapter.
 *
 * Maps the neutral Lyra message model onto `/v1/messages` with `stream: true`,
 * including extended thinking and its signature round-trip.
 */

import { toAnthropicMessages, toAnthropicTools, type ThinkingReplay } from "./anthropic-messages-request.ts";
import { sanitizeToolPairing } from "./sanitize-history.ts";
import { withReasoningRetry } from "./reasoning-compat.ts";
import type {
	AssistantContent,
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
} from "../types.ts";
import { addUsage, emptyUsage } from "../types.ts";
import { classifyFailure, FailureError } from "./failure.ts";
import { RetryBudget, fetchWithRetry, retryStream, toolCallId } from "./retry.ts";
import { parseToolArguments, readSseWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from "../utils/sse.ts";
import { resolveReasoningEffort } from "./thinking-options.ts";
import { failedStreamEvent, joinUrl, priceAttempt } from "./endpoint.ts";
import { compatKey, compatScope } from "./compat-key.ts";
import { applyUsage } from "./usage-fields.ts";
import { anthropicMetadata, sessionHeaders } from "./cache-routing.ts";

const THINKING_BUDGET: Record<string, number> = {
	minimal: 1024,
	low: 4096,
	medium: 12288,
	high: 24576,
	xhigh: 49152,
	max: 63999,
	ultra: 63999,
};

export const anthropicMessagesProvider: Provider = {
	api: "anthropic-messages",
	stream: streamAnthropic,
};

// ---------------------------------------------------------------------------
// 无签名思考块：这个端点接哪一档
// ---------------------------------------------------------------------------

/*
 * 「思考块回放时要不要带一个能验的签名」这件事，各家的答案互相矛盾——所以是一个问出来记住的轴，不是
 * 一个常量。
 *
 *   - 官方 `api.anthropic.com` 会**验签**。签不上的（换过模型、被剥过句柄、流断在半路）送过去就是
 *     `400 Invalid \`signature\` in \`thinking\` block`。它要的是「只发带签名的」。
 *   - DeepSeek / Z.AI / Moonshot 的 Anthropic 兼容端点**不签名**，但推理模型要求把推理带回来。它们
 *     要的是「连没签名的也发，signature 给空串」。
 *
 * 默认值按端点算：认得出来的签名端点上保持「只发带签名的」——那也正是这条链一直以来的行为，所以官方
 * 端点上什么都没变。别的端点上，推理模型默认回放（跟着 oh-my-pi `resolve.ts:861` 的同一条规则：
 * `!signingEndpoint && Boolean(spec.reasoning)`）。
 *
 * 撞了就往下走一格：`unsigned → signed-only → none`。往下走是安全方向——少发一点推理最多让模型接不回
 * 自己那条思维链，多发一格是整个请求被拒。
 *
 * 但这张表是**进程级、按模型记**的，而触发降级的常常只是某一个会话里的一段坏历史（换过模型的签名、
 * 半截的块）。只降不升的话，一次降到底就等于这个模型在所有会话里都再也不回放推理——对「要求把推理
 * 带回来」的非签名端点，那是每一轮都 400、重启进程之前无法恢复。所以有两条回头路：
 *
 *   - 端点明说「推理要带回来」（`REQUIRES_THINKING`）时回到默认那一格；
 *   - 这次请求里降过一格、降完还是失败了，就把这一格撤掉（`restoreThinkingReplay`）——降级没换来
 *     成功，就不该变成所有会话的结论。
 *
 * 记在内存里，不落盘，理由和 `reasoning-compat.ts` 里那一段一样。
 */

/** 学到的结论：`${providerId} ${modelId}` → 无签名思考块该怎么发。 */
const learnedThinkingReplay = new Map<string, ThinkingReplay>();
/** 梯子，从发得最多到发得最少。 */
const THINKING_LADDER: ThinkingReplay[] = ["unsigned", "signed-only", "none"];

const replayKey = compatKey;

const OFFICIAL_ANTHROPIC = "https://api.anthropic.com";

/**
 * 这个地址上的端点会验思考签名吗。
 *
 * 官方那条必须**精确**匹配 origin 或者后面紧跟一个 `/`——前缀匹配会把
 * `https://api.anthropic.com.evil.com` 当成官方。空地址按官方算：那是配置没填好，而按官方算等于保持
 * 现状，是两个方向里安全的那个。
 *
 * 其余几个是把 Claude 转在自己身份后面、但照样执行 Anthropic 签名协议的网关（出处：oh-my-pi
 * `catalog/src/compat/anthropic.ts:25-48`，它把这几条正则和这个判断放在一起）。
 */
export function signsThinkingSignatures(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	if (lower === OFFICIAL_ANTHROPIC || lower.startsWith(`${OFFICIAL_ANTHROPIC}/`)) return true;
	return SIGNING_GATEWAYS.some((pattern) => pattern.test(lower));
}

const SIGNING_GATEWAYS = [
	/gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i,
	/aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i,
	/(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i,
	/(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i,
];

/** 没撞过之前该发哪一档。 */
function defaultThinkingReplay(provider: ProviderConfig, model: ModelConfig): ThinkingReplay {
	if (signsThinkingSignatures(provider.baseUrl)) return "signed-only";
	// 不推理的模型手上没有思考块可发，这一档发什么都一样——留在保守的那一格。
	return model.supportsThinking ? "unsigned" : "signed-only";
}

/** 这个模型现在该发哪一档。 */
export function thinkingReplay(provider: ProviderConfig, model: ModelConfig): ThinkingReplay {
	const { providerId, modelId } = compatScope(provider, model);
	return learnedThinkingReplay.get(replayKey(providerId, modelId)) ?? defaultThinkingReplay(provider, model);
}

/**
 * 「你这个签名我不认」的两种说法——往下走一格。返回「结论变了，值得换个形状重发」。
 *
 * 两条都来自 oh-my-pi `anthropic.ts:1862-1863`，它注明了各自的出处：第一条是官方 Anthropic 和挡在它
 * 前面的中转的原话（`400 Invalid \`signature\` in \`thinking\` block`）；第二条是 Bedrock 系中转的
 * ——空串在它那边先过不了 schema 校验，于是报成
 * `messages.N.content.M.thinking.signature: Field required`。
 *
 * `[^"\n]{0,32}` 这一段是刻意收紧的：这样它只匹配同一条错误信息里紧挨着的那句，不会跨过一个引号或者
 * 换行去捞另一件事的 `required`。
 *
 * 只认这两条。多认一条的代价是把别的原因造成的 400 误判成签名问题，然后拿一个改坏了的请求去重发。
 */
export function learnThinkingReplay(providerId: string, modelId: string, error: string, from: ThinkingReplay = "unsigned"): boolean {
	const id = replayKey(providerId, modelId);
	/*
	 * 「推理要带回来」：降过的回到默认那一格，重发。没降过就不认领——那时这句话说的不是回放档位
	 * （DeepSeek 在工具排列不对时也这么说，见 `reasoning-compat.ts` 的 `REQUIRES`），交给后面的轴。
	 */
	if (REQUIRES_THINKING.test(error)) {
		if (!learnedThinkingReplay.has(id) || learnedThinkingReplay.get(id) === from) return false;
		learnedThinkingReplay.delete(id);
		return true;
	}
	if (!INVALID_THINKING_SIGNATURE.test(error) && !MISSING_THINKING_SIGNATURE.test(error)) return false;
	const now = learnedThinkingReplay.get(id) ?? from;
	const next = THINKING_LADDER[THINKING_LADDER.indexOf(now) + 1];
	if (!next) return false;
	learnedThinkingReplay.set(id, next);
	return true;
}

const INVALID_THINKING_SIGNATURE = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
const MISSING_THINKING_SIGNATURE = /thinking\.signature\b[^"\n]{0,32}\brequired\b/i;
/** 和 `reasoning-compat.ts` 的 `REQUIRES` 同一句话，多认一个 `thinking` 的说法。 */
const REQUIRES_THINKING = /(?:reasoning(?:_content|_text)?|thinking)\b.{0,40}must be passed back/i;

/**
 * 把这个模型的档位放回某次请求开始时的样子。`to` 为 undefined 表示那时还没学过。
 *
 * 给「降了一格、重发还是失败」用，理由见文件这一段开头。
 */
function restoreThinkingReplay(providerId: string, modelId: string, to: ThinkingReplay | undefined): void {
	const id = replayKey(providerId, modelId);
	if (to === undefined) learnedThinkingReplay.delete(id);
	else learnedThinkingReplay.set(id, to);
}

/** 测试用：把学到的都忘掉。 */
export function resetThinkingReplay(): void {
	learnedThinkingReplay.clear();
	learnedAdaptiveThinking.clear();
}

// ---------------------------------------------------------------------------
// 思考参数的形状：budget_tokens 还是 adaptive
// ---------------------------------------------------------------------------

/*
 * 协议里开思考有两种写法：`thinking: {type: "enabled", budget_tokens}`，和
 * `thinking: {type: "adaptive"}` 加 `output_config: {effort}`。新一些的模型只认后一种，给
 * `budget_tokens` 是 400；而这条链服务的第三方兼容端点多数只认前一种。
 *
 * 所以默认不变（budget_tokens），撞上「不认 budget_tokens / 要 adaptive」再学会换写法、重发——和
 * `request-params-compat.ts` 那一套同一个路子，记在内存里，不落盘。只有一个方向：端点从来不会因为
 * 我们发了 adaptive 而点名要 budget_tokens（默认就是它），没有反向信号可认。
 *
 * 放在这个文件而不是 `request-params-compat.ts`：那份是三条链共用的，两条 OpenAI 链根本不发
 * `thinking`，学到它对它们只会换来一次原样重发。
 */

/** 学到要用 adaptive 写法的模型。 */
const learnedAdaptiveThinking = new Set<string>();

/**
 * 「别用 budget_tokens」的几种说法。每条都要点名 `budget_tokens` / `thinking.type`，指向明确：
 *
 *   - 官方对 4.7 之后的模型的原话点名了替代写法：
 *     `` `thinking.type.enabled` is not supported for this model. Use `thinking.type.adaptive` and
 *     `output_config.effort` to control thinking behavior. ``
 *   - 中转翻译后常见的形状：`budget_tokens` 后面紧跟不支持/已弃用/不允许（**推断**，没有实测样本；
 *     `[^.\n]` 不跨句，免得把顺口提到 budget_tokens 的长错误也算进来）。
 */
const ADAPTIVE_REQUIRED = [
	/thinking\.type\.adaptive/i,
	/thinking\.type\.enabled[^.\n]{0,40}not supported/i,
	/budget_tokens[^.\n]{0,60}(?:not supported|unsupported|deprecated|no longer|not permitted|not allowed|removed)/i,
];

/** 这个模型开思考时该用 adaptive 写法吗。没撞过就是否。 */
function usesAdaptiveThinking(providerId: string, modelId: string): boolean {
	return learnedAdaptiveThinking.has(compatKey(providerId, modelId));
}

/** 从一次失败里学：端点不认 budget_tokens，改用 adaptive。返回「结论变了，值得换个形状重发」。 */
function learnAdaptiveThinking(providerId: string, modelId: string, error: string): boolean {
	if (!ADAPTIVE_REQUIRED.some((pattern) => pattern.test(error))) return false;
	const id = compatKey(providerId, modelId);
	if (learnedAdaptiveThinking.has(id)) return false;
	learnedAdaptiveThinking.add(id);
	return true;
}

/**
 * 我们的档位 → 协议的 `output_config.effort`。协议只认 `low/medium/high/xhigh/max`。
 *
 * `minimal` 和 `ultra` 是别家的档位，就近落到两端；表里没有的（模型自定义的档位名）不发
 * `output_config`，由端点用它自己的默认——发一个协议外的值只会换来一个 400。
 */
const ADAPTIVE_EFFORT: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
	ultra: "max",
};

/** 开思考时请求体里那一段。 */
function thinkingParams(adaptive: boolean, effort: string, budget: number | undefined, maxTokens: number): Record<string, unknown> {
	if (!adaptive) {
		return { thinking: { type: "enabled", budget_tokens: budget === undefined ? undefined : Math.min(budget, maxTokens - 1) } };
	}
	const mapped = ADAPTIVE_EFFORT[effort];
	return { thinking: { type: "adaptive" }, ...(mapped ? { output_config: { effort: mapped } } : {}) };
}

/**
 * 开着思考时发不出去的采样参数。
 *
 * `options.temperature` 本来就被挡在思考关闭那条分支里，但紧接着两个 `...samplingParams` 又把它放了
 * 回来——用户在模型上配一个 `samplingParams: {temperature: 0.3}` 再开思考，每一轮都 400。
 *
 * 只摘这三个键，而不是像 oh-my-pi（`anthropic.ts:4088-4095`）那样整个 `samplingParams` 都不发：Lyra
 * 的 `samplingParams` 是个「原样合并进请求体」的口子（`types/provider.ts:79`），里面放的不一定是采样
 * 参数，整块扣掉会顺手扣掉别的东西，而没有证据说别的键在开思考时发不出去。
 *
 * 证据：Opus 4.7 起这三个键**无论思考开不开**都是 400（官方迁移文档：`The temperature, top_p, and
 * top_k parameters are no longer accepted on Claude Opus 4.7`），所以摘掉它们只会少 400 不会多。至于
 * 「更早的模型上开了思考就不能改温度」这一条，官方文档里没找到现行原文（**推断**，与 oh-my-pi 的同
 * 一条判断一致，也与这个文件原本就有的 `:87-94` 那段判断一致）。
 */
const THINKING_FORBIDS_SAMPLING = ["temperature", "top_p", "top_k"];

async function* streamAnthropic(
	provider: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions,
): AsyncGenerator<StreamEvent, AssistantMessage> {
	const startTime = Date.now();
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: provider.id,
		model: model.modelId,
		usage: emptyUsage(),
		stopReason: "pending",
		timestamp: startTime,
	};

	const effort = resolveReasoningEffort(options.thinking, model);
	const thinkingEnabled = effort !== undefined;
	/** 学和查都用这一对 id，见 `compat-key.ts`。 */
	const scope = compatScope(provider, model);
	const maxTokens = options.maxTokens ?? model.maxOutputTokens;
	const budget = effort ? model.thinkingOptions?.find((option) => option.id === effort)?.budgetTokens ?? THINKING_BUDGET[effort] : undefined;
	if (thinkingEnabled && (!Number.isInteger(budget) || budget === undefined || budget < 1024 || maxTokens <= 1024)) {
		throw new Error(`Model ${model.modelId}: thinking level "${effort}" requires budgetTokens >= 1024 and maxOutputTokens > 1024.`);
	}

	/*
	 * 每次尝试重新编一遍，因为**形状可能在两次之间变掉**：无签名的思考块该怎么发是撞出来的，不是配出
	 * 来的（见上面 `thinkingReplay`）。被顶回来的那一次会记下结论、换一档重发，所以这里必须能重新编
	 * 一份，而不是把第一次编好的那份原样再发一遍。
	 */
	const buildBody = (replay: ThinkingReplay): Record<string, unknown> => ({
		model: model.modelId,
		max_tokens: maxTokens,
		stream: true,
		messages: toAnthropicMessages(sanitizeToolPairing(context.messages), {
			thinkingReplay: replay,
			supportsImages: model.supportsImages,
			// 四个断点：system 一个、工具列表一个，剩下两个在消息尾部滚动。
			cacheBreakpoints: 2,
		}),
		...(context.systemPrompt
			? {
					system: [
						{
							type: "text",
							text: context.systemPrompt,
							// Cache the system prompt: it is identical across every turn of a session.
							cache_control: { type: "ephemeral" },
						},
					],
				}
			: {}),
		...(context.tools.length > 0 ? { tools: toAnthropicTools(context.tools) } : {}),
		// 写法是学出来的，见 `learnAdaptiveThinking`。
		...(thinkingEnabled && effort ? thinkingParams(usesAdaptiveThinking(scope.providerId, scope.modelId), effort, budget, maxTokens) : {}),
		...samplingFor(thinkingEnabled, model, options),
		// 缓存路由键，见 `cache-routing.ts`。
		...anthropicMetadata(options.cacheKey),
	});

	let body = buildBody(thinkingReplay(provider, model));

	options.onPayload?.(body);

	/** Stand-in ids for calls the provider did not name, keyed by block index. */
	const inventedIds = new Map<number, string>();

	const doFetch = options.fetch ?? globalThis.fetch;
	// 在这里算一次，重试沿用同一个会话 id。
	const requiredHeaders = sessionHeaders(provider.baseUrl, options.cacheKey);

	let firstTokenTime: number | null = null;
	const blocks = new Map<
		number,
		{
			kind: "text" | "thinking" | "toolCall";
			contentIndex: number;
			raw: string;
		}
	>();
	let stopReason: string | undefined;
	/** 见过 `message_stop` 没有。这条流是正常收的尾，还是断在半路——见流末尾那一段。 */
	let sawMessageStop = false;
	/** 收到过几个能看懂的事件——用来分辨「模型没话说」和「中转发来一团别的东西」。见空回答那一段。 */
	let framesSeen = 0;
	/** 前几次失败的尝试各自花掉的 token，攒着，最后加进这条消息的用量里。见 `reset`。 */
	let spentOnRetries = emptyUsage();

	/**
	 * 上一次尝试留下的一切清掉，重新来。两层重试共用这一个——各写一份的时候漏过行（`inventedIds`），
	 * 漂移就是这么来的。
	 */
	const reset = () => {
		// 已经花掉的 token 不清零，按那一次自己的档位计价后攒着，见 Responses 适配器里同一段和 `priceAttempt`。
		spentOnRetries = addUsage(spentOnRetries, priceAttempt(partial.usage, model));
		partial.content = [];
		partial.usage = emptyUsage();
		blocks.clear();
		/*
		 * `inventedIds` 记的是我们替哪些没带 id 的 toolCall 编过号，作用是同一条流里第二次遇到同一个块时
		 * 给回同一个 id。重试要的是把上一次整个当没发生过，留着它等于让这一次的编号从上一次的位置接着走
		 * ——半截流重试正是它最常被触发的场合。
		 */
		inventedIds.clear();
		stopReason = undefined;
		sawMessageStop = false;
		framesSeen = 0;
		firstTokenTime = null;
	};

	/*
	 * 思考回放这一轴在这次请求里往哪边动过。见 `learnThinkingReplay` 上面那段：降了一格还是失败，就把
	 * 这一格撤掉；同一次请求里也不来回拉扯——端点先嫌签名、再嫌推理没带回来，说明这段历史两头都过不去，
	 * 在两格之间反复重发只是烧钱。
	 */
	const replayAtStart = learnedThinkingReplay.get(replayKey(scope.providerId, scope.modelId));
	let replayMoved: "down" | "up" | undefined;
	const learnReplay = (providerId: string, modelId: string, said: string): boolean => {
		const direction = REQUIRES_THINKING.test(said) ? "up" : "down";
		if (replayMoved && replayMoved !== direction) return false;
		const moved = learnThinkingReplay(providerId, modelId, said, defaultThinkingReplay(provider, model));
		if (moved) replayMoved = direction;
		return moved;
	};

	const retryBudget = new RetryBudget(options.retryPolicy, options.retryAttempts);
	try {
		/*
		 * 两层重试，管的是两件不同的事。
		 *
		 * 外层（`withReasoningRetry`）重发的是一个**不同的**请求：端点说「你这个签名我不认」，我们换一档
		 * 再来。它必须套在外面，因为 `retryStream` 按定义不会重试一个 400——同一个请求再发一遍还是同一个
		 * 400，它拒绝得对。
		 *
		 * 这条链从前根本没接自愈：`withReasoningRetry` 只套在两条 OpenAI 链上，所以 Anthropic 这边一旦
		 * 撞上形状问题就是死路。`learnThinkingReplay` 作为 `alsoLearn` 排在推理那条梯子前面看——指向明
		 * 确的轴先看，误判的机会小得多（见 `reasoning-compat.ts` 里 `alsoLearn` 那段说明）。
		 */
		yield* withReasoningRetry(
			scope.providerId,
			scope.modelId,
			reset,
			/*
			 * 思考写法那条排在回放档位前面：它只认点名 `budget_tokens` / `thinking.type` 的话，和签名那两句
			 * 不会抢同一句。只在开着思考时问它——关着思考时请求里没有 `thinking`，学到了也换不出新形状。
			 */
			(providerId, modelId, said) => (thinkingEnabled && learnAdaptiveThinking(providerId, modelId, said)) || learnReplay(providerId, modelId, said),
			async function* () {
				body = buildBody(thinkingReplay(provider, model));
				options.onPayload?.(body);
				// The whole exchange, not just the connection — see the same wrapper in the Responses
				// adapter for why a stream that dies part way through is worth asking for again.
				yield* retryStream(
			async function* attempt() {
				const response = await fetchWithRetry(
					doFetch,
					joinUrl(provider.baseUrl, "/v1/messages"),
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-api-key": provider.apiKey,
							"anthropic-version": "2023-06-01",
							/*
							 * 不再带 `anthropic-beta: prompt-caching-2024-07-31`：提示缓存早已 GA，`cache_control`
							 * 不需要这个头。
							 */
							...requiredHeaders,
						},
						body: JSON.stringify(body),
						signal: options.signal,
					},
					{
						budget: retryBudget,
						signal: options.signal,
						onRetry: options.onRetry,
					},
				);

				if (!response.ok) {
					// 带着结论抛：`fetchWithRetry` 已经判过了，上面那层不该拿一个字符串重新猜。
					const detail = await response.text().catch(() => "");
					throw new FailureError(classifyFailure({ from: "status", status: response.status, body: detail }));
				}

				yield { type: "start", partial: { ...partial } } as StreamEvent;

				/** 这次尝试里没能解析的帧，留一份原文，空回答时用来说明收到的到底是什么。 */
				let unparsable = "";
				/** 这条流被空闲闸掉了吗。见 `readSseWithIdleTimeout`。 */
				const idle = { tripped: false };
				for await (const frame of readSseWithIdleTimeout(response, options.signal, STREAM_IDLE_TIMEOUT_MS, idle)) {
					let event: Record<string, any>;
					try {
						event = JSON.parse(frame.data);
					} catch {
						if (!unparsable) unparsable = frame.data.slice(0, 500);
						continue;
					}
					framesSeen += 1;

					switch (event.type) {
						case "message_start": {
							applyUsage("anthropic-messages", partial.usage, event.message?.usage);
							break;
						}

						case "content_block_start": {
							const idx: number = event.index;
							const block = event.content_block ?? {};
							if (block.type === "text") {
								partial.content.push({ type: "text", text: "" });
								blocks.set(idx, {
									kind: "text",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield { type: "text_start", index: idx };
							} else if (block.type === "thinking" || block.type === "redacted_thinking") {
								partial.content.push({
									type: "thinking",
									thinking: "",
									redacted: block.type === "redacted_thinking" || undefined,
									encrypted: typeof block.data === "string" ? block.data : undefined,
								});
								blocks.set(idx, {
									kind: "thinking",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield { type: "thinking_start", index: idx };
							} else if (block.type === "tool_use") {
								partial.content.push({
									type: "toolCall",
									id: toolCallId(block.id, idx, inventedIds),
									name: String(block.name ?? ""),
									arguments: {},
									argumentsText: "",
								});
								blocks.set(idx, {
									kind: "toolCall",
									contentIndex: partial.content.length - 1,
									raw: "",
								});
								yield {
									type: "toolcall_start",
									index: idx,
									id: toolCallId(block.id, idx, inventedIds),
									name: String(block.name ?? ""),
								};
							}
							break;
						}

						case "content_block_delta": {
							if (firstTokenTime === null) firstTokenTime = Date.now();
							const idx: number = event.index;
							const tracked = blocks.get(idx);
							if (!tracked) break;
							const delta = event.delta ?? {};
							const target = partial.content[tracked.contentIndex];

							if (delta.type === "text_delta" && target?.type === "text") {
								target.text += delta.text ?? "";
								yield {
									type: "text_delta",
									index: idx,
									delta: delta.text ?? "",
									partial: { ...partial },
								};
							} else if (delta.type === "thinking_delta" && target?.type === "thinking") {
								target.thinking += delta.thinking ?? "";
								yield {
									type: "thinking_delta",
									index: idx,
									delta: delta.thinking ?? "",
									partial: { ...partial },
								};
							} else if (delta.type === "signature_delta" && target?.type === "thinking") {
								target.signature = (target.signature ?? "") + (delta.signature ?? "");
							} else if (delta.type === "input_json_delta" && target?.type === "toolCall") {
								tracked.raw += delta.partial_json ?? "";
								target.argumentsText = tracked.raw;
								yield {
									type: "toolcall_delta",
									index: idx,
									delta: delta.partial_json ?? "",
									partial: { ...partial },
								};
							}
							break;
						}

						case "content_block_stop": {
							const idx: number = event.index;
							const tracked = blocks.get(idx);
							if (!tracked) break;
							if (tracked.kind === "toolCall") {
								const target = partial.content[tracked.contentIndex];
								if (target?.type === "toolCall") {
									target.arguments = parseToolArguments(tracked.raw) ?? {};
								}
								yield {
									type: "toolcall_end",
									index: idx,
									partial: { ...partial },
								};
							} else if (tracked.kind === "text") {
								yield { type: "text_end", index: idx };
							} else {
								yield { type: "thinking_end", index: idx };
							}
							break;
						}

						case "message_delta": {
							applyUsage("anthropic-messages", partial.usage, event.usage);
							if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
							break;
						}

						case "message_stop": {
							sawMessageStop = true;
							break;
						}

						case "error": {
							/*
							 * 抛出去，由分类器决定，而不是当场放弃。
							 *
							 * 和 Responses 适配器里那一处是同一个毛病、同一个修法：中转把上游的临时
							 * 故障塞进这个事件，从前一律按「服务商本人拒绝」处理，绕过全部三层重试。
							 */
							const said = event.error?.message;
							throw new FailureError(
								classifyFailure({
									from: "stream",
									message: typeof said === "string" ? said : undefined,
									raw: JSON.stringify(event).slice(0, 4000),
									spent: partial.usage.output > 0 || partial.content.length > 0,
								}),
							);
						}
					}
				}

				/*
				 * 被空闲闸掉的，按连接问题抛，不按「空回答」。
				 *
				 * 分类成 `network`（`from: "transport"` 认不出名字时的兜底）是因为它就是连接问题，而且那
				 * 一类是可重试的——下面那层会 `reset()` 清掉半截内容再要一遍，这正是一条挂死的流该得到的
				 * 待遇。放在空回答检查**之前**：挂死时内容常常正好是空的，让空回答那条先认领会把原因说错。
				 */
				if (idle.tripped) {
					throw new FailureError(
						classifyFailure({ from: "transport", error: new Error(`流空闲超过 ${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)} 秒`) }),
					);
				}

				/*
				 * 有内容、但两个收尾信号一个都没到——这条流断在半路。
				 *
				 * 两条 OpenAI 链早就修过这件事，这条一直没有：`mapStopReason(undefined, …)` 会落到
				 * `"stop"`，于是半截回答被当成模型说完了交给 loop。半截的代价不是少几个字——半截的
				 * `toolCall` 参数照样会被 `parseToolArguments` 收下，模型「说完了」的判断会被下一轮当
				 * 成事实，而真正该发生的事（重发一遍）不会发生。
				 *
				 * 判据和 chat-completions 那条一样，连取舍一起：**两个信号都没有**才算断。Anthropic
				 * 官方两个都发，但中转不一定——只认 `message_stop` 会把只发 `message_delta` 的中转每
				 * 一轮都误判成截断。两样都不发又安静关掉连接的宿主会被漏掉，那种宿主也没给出任何能
				 * 分辨「说完了」和「断了」的东西。
				 *
				 * 排在空回答之前，和 idle 之后：没有内容的走下面那条，它的原因说得更准。
				 */
				/*
				 * 模型拒绝作答（`stop_reason: "refusal"`）是一个明确的结局，不是「说完了」也不是空回答。
				 *
				 * 从前它落进 `mapStopReason` 的兜底成了 `stop`：有内容时一段被掐断的回答被当成正常结束，
				 * 没内容时掉进下面的空回答、被当成临时故障重试好几次——同样的输入再问还是同样的拒绝。
				 * 抛成失败，措辞让 `failure.ts` 判成「内容被安全策略拒绝」（`fatal`，`hint: blocked`），
				 * 和另外两条链的 `content_filter` 同一个出口。排在截断和空回答之前，它说得最准。
				 */
				if (stopReason === "refusal") {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: REFUSAL_MESSAGE,
							spent: partial.usage.output > 0 || partial.content.length > 0,
						}),
					);
				}

				if (!sawMessageStop && stopReason === undefined && partial.content.length > 0) {
					throw new FailureError(
						classifyFailure({
							from: "stream",
							message: "回答只传了一半，连接就断了",
							spent: true,
						}),
					);
				}

				// 空回答也是失败，不是「模型没话说」——见 Responses 适配器里同一段的说明。
				if (partial.content.length === 0) {
					throw new FailureError(
						classifyFailure({
							from: "empty",
							why: unparsable ? "unparsable" : framesSeen === 0 ? "no-frames" : "no-content",
							body: unparsable || undefined,
						}),
					);
				}
			},
			{
				budget: retryBudget,
				signal: options.signal,
				onRetry: options.onRetry,
				reset,
			},
				);
			},
		);
	} catch (error) {
		// 降了一格还是没成，这一格不该留给别的会话。见 `learnThinkingReplay` 上面那段。
		if (replayMoved === "down" && !options.signal?.aborted) restoreThinkingReplay(scope.providerId, scope.modelId, replayAtStart);
		// 失败时这条消息长什么样，三条链一致——见 `failedStreamEvent`。
		yield failedStreamEvent(partial, {
			error,
			signal: options.signal,
			model,
			spentOnRetries,
			startTime,
			firstTokenTime,
		});
		return partial;
	}

	partial.durationMs = Math.max(1, Date.now() - startTime);
	if (firstTokenTime !== null) {
		partial.sseDurationMs = Math.max(1, Date.now() - firstTokenTime);
	}
	partial.stopReason = mapStopReason(stopReason, partial.content);
	// 成功了，但失败的那几次也是花过钱的——账上要有。各按各的档位计价再相加，见 `priceAttempt`。
	partial.usage = addUsage(priceAttempt(partial.usage, model), spentOnRetries);
	yield { type: "done", message: { ...partial } };
	return partial;
}

/** 这一份请求该带哪些采样参数。见 `THINKING_FORBIDS_SAMPLING`。 */
export function samplingFor(thinkingEnabled: boolean, model: Pick<ModelConfig, "samplingParams">, options: Pick<RequestOptions, "temperature" | "samplingParams">): Record<string, unknown> {
	const merged: Record<string, unknown> = {
		// 顺序和从前一样：显式配在 `samplingParams` 里的压过 `options.temperature`。
		...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
		...model.samplingParams,
		...options.samplingParams,
	};
	if (!thinkingEnabled) return merged;
	for (const key of THINKING_FORBIDS_SAMPLING) delete merged[key];
	return merged;
}

/** 拒绝作答时交给分类器的那句话。带着 `stop_reason: refusal` 原文，`failure.ts` 靠它判成内容策略。 */
const REFUSAL_MESSAGE = "模型拒绝回答这次请求（stop_reason: refusal）";

/**
 * 协议的 `stop_reason` → 我们的 `stopReason`。`refusal` 不经过这里，在流末尾就抛了。
 *
 *   - `end_turn` / `stop_sequence`：说完了（带着工具调用时仍算 `toolUse`，见函数末尾）。
 *   - `max_tokens`：输出上限截断。
 *   - `model_context_window_exceeded`：上下文窗口满了，生成被截在半路——和 `max_tokens` 是同一个结局
 *     （回答不完整，工具调用可能是半截），按 `length` 处理，loop 不会去执行半截的调用。
 *   - `pause_turn`：服务端工具跑得太久、这一轮被暂停，要原样发回去才能续上。我们不发服务端工具，正常
 *     走不到；兼容端点真发了，这一轮就是没做完的，按 `length` 如实标出来，不冒充说完了。
 *   - `tool_use`：要调工具。
 *
 * 认不出来的（或者没带的）保持从前的兜底：有工具调用算 `toolUse`，否则 `stop`。没像 Chat 链那样把
 * 未知值判成失败：兼容端点在这个字段上写自家的值并不少见，而这条链「断在半路」已经由收尾信号那条
 * 判据兜住了。
 */
function mapStopReason(raw: string | undefined, content: AssistantContent[]): AssistantMessage["stopReason"] {
	switch (raw) {
		case "max_tokens":
		case "model_context_window_exceeded":
		case "pause_turn":
			return "length";
		case "tool_use":
			return "toolUse";
	}
	// `end_turn` / `stop_sequence` 也走这里：有中转带着工具调用却报 `end_turn`，按字面判成 `stop` 会让
	// 那些调用静默不执行。
	return content.some((c) => c.type === "toolCall") ? "toolUse" : "stop";
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------
