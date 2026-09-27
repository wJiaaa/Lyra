import type { Message, ToolResultMessage } from "../types.ts";
import { CHEAP_SUFFIX_CHARS, derive, descends, firstAffordableCut, pruneToolResults, sizePruneSaving, sourceOf, type ArtifactSink, type PruneTiming } from "./prune.ts";
import { applyStaleCuts, staleCuts } from "./stale-results.ts";

// Historical carry curves flatten near 20 rounds; batch at that cadence to avoid
// rewriting the cached prefix every turn. Lower ages can evict still-useful output.
export const PRUNE_AGE_ROUNDS = 20;

interface SizedCut {
	index: number;
	saving: number;
	original: Message;
	current: Message;
}

/**
 * Batch old output without invalidating the provider's prefix on every request.
 *
 * 也是这个会话「发给模型的视图」在进程内的记录：按日志原文记住上一次发出去的副本，下一轮从日志
 * 重建出原文时换回同一份。不止记自己剪的——外层 `dropUneventful` 的清空、压缩阶段的剪枝（经
 * `adopt`）都算，否则它们下一轮回弹成原文：前缀从那里断开，而压缩判断读的是上一次剪过之后的
 * usage，不会再触发，原文照发，隔轮振荡。
 *
 * 只在进程内有效。重启后从日志重建的是原文，新的剪枝器第一次请求就是一批（`requests` 从 0 起），
 * 大多数视图会按同样的规则重新剪出来；要做到跨重启逐字一致，需要把剪枝决定写进日志。
 */
export class AgedToolPruner {
	private requests = 0;
	private readonly views = new WeakMap<Message, Message>();

	prepare(messages: Message[], timing: PruneTiming = {}, artifacts?: ArtifactSink): Message[] {
		const sources = messages.map(sourceOf);
		const viewed = this.withViews(messages, sources);
		const stale = staleCuts(viewed);
		const batch = this.requests++ % PRUNE_AGE_ROUNDS === 0;
		const sized = this.sizeCuts(sources, viewed, batch);
		const from = firstAffordableCut(viewed, [...stale, ...sized], timing);
		if (from === undefined) return viewed === messages ? messages : viewed;

		const next = applyStaleCuts(viewed, stale.filter((cut) => cut.index >= from));
		let result = next;
		for (const cut of sized) {
			if (cut.index < from) continue;
			const [view] = pruneToolResults([cut.current], undefined, artifacts);
			if (view === cut.current) continue;
			this.views.set(cut.original, view);
			if (result === next) result = [...next];
			result[cut.index] = view;
		}
		this.remember(sources, viewed, result);
		return result;
	}

	/**
	 * 采纳别处（压缩）对已发视图做的改写，让下一轮从日志重建时换回同一份。
	 *
	 * `before` 与 `after` 按末尾对齐：只剪枝时两边等长，摘要时 `after` 的保留尾部就是 `before`
	 * 的后缀。只认同一个调用的工具结果，换了策略插件、对不上的位置跳过。
	 */
	adopt(before: Message[], after: Message[], count = Math.min(before.length, after.length)): void {
		for (let k = 1; k <= Math.min(count, before.length, after.length); k++) {
			const was = before[before.length - k];
			const now = after[after.length - k];
			if (now === was || now.role !== "toolResult" || was.role !== "toolResult" || now.toolCallId !== was.toolCallId) continue;
			this.views.set(sourceOf(was), derive(was, now));
		}
	}

	private sizeCuts(originals: Message[], viewed: Message[], batch: boolean): SizedCut[] {
		const cuts: SizedCut[] = [];
		let age = 0;
		for (let index = originals.length - 1; index >= 0; index--) {
			const original = originals[index];
			const message = viewed[index];
			if (original.role === "assistant") age++;
			if (message.role !== "toolResult" || message.toolName === "skill") continue;
			const chars = message.content.reduce((sum, block) => sum + (block.type === "text" ? [...block.text].length : 0), 0);
			const saving = sizePruneSaving(chars);
			// Blow-ups do not wait for the 20-round batch: a 1.7 MB grep is already dead weight.
			if (saving <= 0 || (saving <= CHEAP_SUFFIX_CHARS ? !batch || age < PRUNE_AGE_ROUNDS : false)) continue;
			cuts.push({ index, saving, original, current: message });
		}
		return cuts;
	}

	/*
	 * 记下的视图优先于从原文重新剪出的副本：上一次发出去的是它，前缀才接得上。只有在它之上
	 * 进一步剪出来的（同一轮里外层又清空了一次）才替换它。
	 */
	private withViews(messages: Message[], sources: Message[]): Message[] {
		let next = messages;
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			const stored = this.views.get(sources[index]);
			if (stored && !descends(message, stored)) {
				if (next === messages) next = [...messages];
				next[index] = stored;
			} else if (message !== sources[index] && message !== stored) this.views.set(sources[index], message);
		}
		return next;
	}

	private remember(sources: Message[], before: Message[], after: Message[]): void {
		if (after === before) return;
		for (let index = 0; index < sources.length; index++) {
			if (after[index] !== before[index] && after[index].role === "toolResult") this.views.set(sources[index], derive(before[index], after[index] as ToolResultMessage));
		}
	}
}

/** Keep the pruned prefix stable when a new user message starts another turn. */
export function sessionPruner(state: Map<string, unknown>): AgedToolPruner {
	const existing = state.get("agedToolPruner");
	if (existing instanceof AgedToolPruner) return existing;
	const pruner = new AgedToolPruner();
	state.set("agedToolPruner", pruner);
	return pruner;
}
