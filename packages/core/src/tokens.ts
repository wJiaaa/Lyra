/**
 * Token estimation, kept free of any runtime the browser does not have.
 *
 * Its own module rather than part of `runtime/compaction.ts`, and reachable as
 * `@plume/core/tokens`, because both sides of the app need it: the runtime to decide when
 * to compact, and the renderer to show how full the context window is. Importing it from the
 * package root would drag in the whole kernel — the bash tool, settings, the plugin loader —
 * and the first thing that happens then is `process is not defined`, with a white window.
 */

import type { AssistantMessage, LlmContext, Message, ModelConfig, ToolSpec, Usage } from "./types.ts";
import { requestUsage } from "./types/message.ts";

/**
 * What a conversation actually spent, as opposed to what it re-read.
 *
 * `Usage.total` weighs all four buckets equally. That is the right answer to "how many tokens
 * crossed the wire" and the wrong answer to the question anyone actually asks of it, because cache
 * reads bill at a tenth of the input rate and, in a long agentic run, outnumber everything else
 * twenty to one. A session that re-read a 220k context two thousand times reported half a billion
 * tokens beside a 95% hit rate — two figures describing the same fact, the alarming one first —
 * when the fresh input behind it was under thirty million.
 *
 * Cache *writes* count as fresh: that is the first, full-price pass over the content, not a re-read
 * of it. Only `cacheRead` is left out.
 *
 * Beside `total` rather than replacing it. `total` is what was written to every historical log, and
 * a stored field that means one thing before a date and another after is worse than either.
 *
 * Here rather than next to `Usage` in `types/message.ts` for the reason at the top of this file:
 * the renderer needs it, and may not reach the package root to get it.
 */
export function freshTokens(usage: Pick<Usage, "input" | "output" | "cacheWrite">): number {
	return usage.input + usage.cacheWrite + usage.output;
}

export function estimateTokens(messages: Message[]): number {
	let chars = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const c of message.content) {
				if (c.type === "text") chars += c.text.length;
				else if (c.type === "thinking") chars += c.thinking.length;
				else chars += (c.argumentsText ?? JSON.stringify(c.arguments)).length + c.name.length;
			}
		} else {
			for (const c of message.content) {
				// A base64 image is worth roughly 1500 tokens regardless of its byte length.
				chars += c.type === "text" ? c.text.length : 6000;
			}
		}
	}
	// ~3.5 characters per token averaged over code and prose.
	return Math.ceil(chars / 3.5);
}

/** What a tool costs on the wire: the schema the provider is given, every single request. */
export function toolTokens(tools: ToolSpec[]): number {
	if (tools.length === 0) return 0;
	const text = tools
		.map((tool) => `${tool.name}${tool.description}${JSON.stringify(tool.parameters)}`)
		.join("");
	return Math.ceil(text.length / 3.5);
}

export function textTokens(text: string): number {
	return text ? Math.ceil(text.length / 3.5) : 0;
}

/** Model output limits are ceilings, not space that can be spent twice in a shared window. */
export function contextMaxTokens(model: ModelConfig, context: LlmContext, requested = model.maxOutputTokens, estimateOnly = false): number {
	const maximum = Math.min(requested, model.maxOutputTokens);
	// Summary requests have a different prompt and rewritten history; old provider usage is invalid.
	const total = estimateOnly ? { tokens: estimateTokens(context.messages), measured: false } : measureTotal(context.messages);
	const input = total.tokens + (total.measured ? 0 : textTokens(context.systemPrompt) + toolTokens(context.tools));
	// Reserve for estimation/wire overhead without consuming a fixed 1k of a small model's window.
	const margin = Math.max(1, Math.min(1000, Math.floor(model.contextWindow * 0.01)));
	const available = Math.floor(model.contextWindow - input - margin);
	// A local estimate cannot prove overflow. Keep provider rejection/recovery authoritative.
	return available > 0 ? Math.min(maximum, available) : maximum;
}

/**
 * What the conversation actually weighs, preferring the provider's own count.
 *
 * Exported because compaction needs the same number this reports. It used to decide on
 * `estimateTokens` alone — characters over 3.5 — which is a guess that runs low on CJK and on
 * dense JSON, and which counts only the messages while the request also carries the system prompt
 * and every tool schema. Between the two, a conversation that had filled its window read as barely
 * two thirds full, so the one mechanism for staying inside the window never ran.
 *
 * `usage.input + cacheRead + cacheWrite` is the whole request as the provider measured it, overhead included,
 * so anything after the last settled reply is estimated and added on top.
 */
export function measureTotal(messages: Message[]): { measured: boolean; tokens: number } {
	/*
	 * Nothing measured before the last compaction counts.
	 *
	 * A reply's `usage` records the request that produced it — the conversation as it was at that
	 * moment. Compaction then rewrites that conversation, and the replies kept in the tail carry on
	 * reporting the size of a history that no longer exists. Reading the newest of them gives the
	 * pre-compaction total for a post-compaction conversation.
	 *
	 * That is not merely stale, it is self-sustaining: compaction returns something well inside the
	 * window, the next check reads the old number, decides the window is still full, and compacts
	 * again. Every turn, with a summary request each time, on a conversation that had already been
	 * cut to a third of the limit.
	 *
	 * So a reply older than the newest summary is not evidence about the present. There is no new
	 * measurement to replace it with — nothing has been sent since — and the estimate is what is
	 * left, which is exactly what it is for.
	 */
	const compactedAt = lastCompactionAt(messages);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || message.stopReason === "pending") continue;
		if (compactedAt !== null && message.timestamp <= compactedAt) break;
		// Not `usage`: that also bills attempts abandoned by retries, which never shared this window.
		const usage = requestUsage(message);
		const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
		if (total <= 0) break;
		return { measured: true, tokens: total + estimateTokens(messages.slice(i + 1)) };
	}
	return { measured: false, tokens: estimateTokens(messages) };
}

/**
 * When the conversation was last rewritten by compaction, or null if it never was.
 *
 * Recognised by the summary (or the dropped-history notice) the head carries. It is written by
 * `runtime/compaction`, is always synthetic, and is the only message in a conversation that is a
 * rewrite of everything before it.
 */
function lastCompactionAt(messages: Message[]): number | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user" || !message.synthetic) continue;
		const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		// 按条丢弃（`<dropped-history>`）同样重写了它之前的一切，旧回复的 usage 一样作废。
		// 只认以记号开头的：两种压缩头都这样写，而钩子上下文、子代理报告里引用到的同名标签不是边界。
		if (text.startsWith("<session-summary>") || text.startsWith("<dropped-history>")) return message.timestamp;
	}
	return null;
}

/** 这次请求的输入总量；0 是没发出去或没报用量，诊断跳过它，前缀指纹的基准也不从它推进。 */
export function requestPrompt(message: AssistantMessage): number {
	const usage = requestUsage(message);
	return usage.input + usage.cacheRead + usage.cacheWrite;
}
