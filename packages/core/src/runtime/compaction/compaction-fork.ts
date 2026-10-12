/**
 * 摘要请求从主请求分叉：上一次请求原样再发一遍，末尾多一条指令。
 *
 * 压缩的那一下往往是整段对话里最贵的一次请求——上下文快满了，摘要请求要是对不上缓存，十几万 token
 * 就按原价重读一遍。独立的摘要请求（自己的系统提示词、不带工具、改写过的历史）从第一个 token 起就
 * 对不上；分叉请求的工具、系统提示词、thinking、缓存键和消息都和上一次一样，只在末尾往后接，缓存
 * 照常命中，模型看到的也是没剪过的完整历史。
 *
 * 只在三件事都成立时走这条路，否则退回独立请求（`compaction.ts` 的 `summarize`）：
 *
 * - 同一个模型。缓存按模型分，上一次请求之后换了模型，就没有可读的前缀。
 * - 缓存还热。凉了的话分叉读不到任何东西，还要按完整历史付原价——比剪短后的独立请求更贵。
 * - 放得下。完整历史加指令加摘要要在窗口以内；超长恢复那条路本来就放不下，调用方不给分叉起点。
 *
 * 发出前核对前缀：请求体切段后和上一次比，上一次不是它的前缀就当场作废、不发出去。这一步拦的是
 * 「以为在分叉、其实拼出了另一份请求」——Claude Code 有过工具数差一个、每次压缩整段重写的事故。
 */

import { classifyFailure, failureOf } from "../../ai/failure.ts";
import { comparePrefix, payloadSegments } from "../../ai/prefix-fingerprint.ts";
import type { streamAssistant } from "../../ai/index.ts";
import { contextMaxTokens, measureTotal, textTokens, toolTokens } from "../../tokens.ts";
import type { CompactionFault, CompactionLineage, CompactionObserver } from "../../types/compaction.ts";
import type { AssistantMessage, LlmContext, Message, ModelConfig, ProviderConfig, RequestPrefix, StreamEvent } from "../../types.ts";
import { forkInstruction, hasSummary } from "./compaction-prompts.ts";

/**
 * 离上一次请求开始多久以内算缓存还热。
 *
 * 常见服务商里最短的有效期是 Anthropic 默认的 5 分钟，留一成余量（同 pi 的判断）。别家留得更久，
 * 超过这条线时它们的缓存多半还在——但那时退回的独立请求就是改动前的做法，不会比原来更贵。
 */
export const FORK_HOT_MS = 270_000;

export interface ForkOutcome {
	summary: string | null;
	/** 发出前的前缀核对；没核对（宿主替换了请求、没有上一次的指纹）时没有。 */
	prefix?: RequestPrefix;
	/** 为什么没拿到摘要，只为观察；调用方照样退回独立请求。 */
	fault?: CompactionFault;
}

/** 分叉起点能不能用：同一个模型、缓存还热。放不放得下在 `forkSummary` 里按实际请求算。 */
export function forkable(
	lineage: CompactionLineage | undefined,
	provider: ProviderConfig,
	model: ModelConfig,
	now = Date.now(),
): lineage is CompactionLineage {
	if (!lineage) return false;
	if (lineage.sent.providerId !== provider.id || lineage.sent.modelId !== model.id) return false;
	return now - lineage.sent.at <= FORK_HOT_MS;
}

export async function forkSummary(
	lineage: CompactionLineage,
	provider: ProviderConfig,
	model: ModelConfig,
	streamFn: typeof streamAssistant,
	options: { instructions?: string; signal?: AbortSignal; observer?: CompactionObserver },
): Promise<ForkOutcome> {
	const { sent } = lineage;
	const instruction: Message = {
		role: "user",
		content: [{ type: "text", text: forkInstruction(hasSummary(lineage.messages), options.instructions) }],
		timestamp: Date.now(),
		synthetic: true,
	};
	const context: LlmContext = { systemPrompt: sent.systemPrompt, tools: sent.tools, messages: [...lineage.messages, instruction] };

	/*
	 * 摘要要的位置和独立请求一样多（`summarize` 的 `reply`）。不够就不发：发出去要么被拒、要么摘要
	 * 写到一半被截断，两样都白付一整段历史的钱。
	 */
	const total = measureTotal(context.messages);
	const input = total.tokens + (total.measured ? 0 : textTokens(context.systemPrompt) + toolTokens(context.tools));
	const reply = Math.min(8000, model.maxOutputTokens, Math.floor(model.contextWindow * 0.25));
	if (model.contextWindow - input < reply) return { summary: null };

	// 输出上限照主循环的算法折算（`streamTurn`）：thinking 的预算跟着它走，算法不同前缀就不同。
	const maxTokens = contextMaxTokens(model, context, sent.maxTokens);
	const mismatch = new AbortController();
	let prefix: RequestPrefix | undefined;
	const onPayload = lineage.segments
		? (body: unknown) => {
			prefix = comparePrefix(lineage.segments!, payloadSegments(body));
			// 在发出之前：fetch 拿到一个已经中止的信号就不会出门。
			if (prefix.change) mismatch.abort();
		}
		: undefined;
	const signal = options.signal ? AbortSignal.any([options.signal, mismatch.signal]) : mismatch.signal;
	const observer = options.observer;
	let pending = Promise.resolve();
	let recordError: unknown;

	let message: AssistantMessage;
	try {
		const stream = streamFn(provider, model, context, {
			thinking: sent.thinking, temperature: sent.temperature, maxTokens, cacheKey: sent.cacheKey, signal, onPayload,
			onRetry: observer ? ({ delayMs, failure }) => {
				const fault: CompactionFault = failure ? { kind: failure.kind, hint: failure.hint } : { kind: "unknown" };
				pending = pending.then(() => observer.progress({ phase: "retrying", delayMs, fault })).catch((error: unknown) => { recordError = error; });
			} : undefined,
		});
		let next: IteratorResult<StreamEvent, AssistantMessage>;
		do { next = await stream.next(); } while (!next.done);
		message = next.value;
	} catch (cause) {
		await pending;
		if (recordError) throw recordError;
		if (options.signal?.aborted || prefix?.change) return { summary: null, prefix };
		const failure = failureOf(cause);
		return { summary: null, prefix, fault: { kind: failure.kind, hint: failure.hint } };
	}
	await pending;
	if (recordError) throw recordError;

	if (options.signal?.aborted || prefix?.change) return { summary: null, prefix };
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		const failure = message.failure ?? classifyFailure({ from: "stream", message: message.errorMessage });
		return { summary: null, prefix, fault: { kind: failure.kind, hint: failure.hint } };
	}
	// 说了不要调工具还是调了：这次回复不是摘要，丢掉。
	if (message.content.some((part) => part.type === "toolCall")) return { summary: null, prefix, fault: { kind: "unknown" } };
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text ? { summary: text, prefix } : { summary: null, prefix, fault: { kind: "empty" } };
}
