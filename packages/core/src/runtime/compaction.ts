/**
 * Keeping a long conversation inside a context window.
 *
 * Three mechanisms, cheapest first, and each one is a different answer to a different problem:
 *
 *   1. `prune.ts` cuts oversized tool results. No model, no request, and it alone often suffices —
 *      a session that ran three greps over a large repository is mostly those three results.
 *   2. This file replaces the older half of the history with a structured summary, and hands the
 *      boundary back so the caller can *store* it.
 *   3. `recall` (a tool) reads the original log back on demand, so nothing summarised is actually
 *      lost — only moved out of the window until it is asked for.
 *
 * The third is what makes the second safe to be aggressive about. A summary is lossy by
 * construction; a summary next to a searchable transcript is not, and that is the difference
 * between compacting to a third of the window and compacting to a tenth of it.
 *
 * The second is what makes any of it durable. Compaction used to return a shorter array to the
 * running loop and nothing more — so the next prompt rebuilt its history from the log, got every
 * original message back, and compacted again from scratch. The conversation could never be smaller
 * than the log, and the log only grows. That is the whole of "stuck at 80%, compacting every turn":
 * not an arithmetic error in what to cut, but a result that was thrown away as soon as it was made.
 * So compaction now returns what was summarised and where the boundary fell, and the session
 * writes both down.
 */

import type { Compaction, CompactionVia } from "../types/compaction.ts";
import type { CompactionRequest, CompactionStrategy } from "../kernel/services.ts";
import { streamAssistant } from "../ai/index.ts";
import { dropUneventful, FRESH_RESULT_MAX_CHARS, pruneToolResults } from "../agent/prune.ts";
import { dropStaleResults } from "./stale-results.ts";
import { estimateTokens, measureTotal } from "../tokens.ts";
import { taskContextFromHistory } from "./task-context.ts";
import type { Message, ModelConfig, RequestPrefix } from "../types.ts";
import { forkable, forkSummary } from "./compaction-fork.ts";
import { droppedMessage, filesSeen, lastRequest, summaryMessages } from "./compaction-head.ts";
import { fallbackSummary, summarize } from "./compaction-summary.ts";

/**
 * Start compacting at this fraction of the context window.
 *
 * 从 80% 提到 90%：一次压缩要付摘要输出、还要整段重写缓存，线靠后压得少。代价是线上方只剩一成——
 * 200k 窗口剩 20k，一步里几个大工具结果就可能越过窗口，那时走超长恢复（`loop.ts`），而超长恢复不分叉。
 */
export const COMPACTION_RATIO = 0.9;
/**
 * OpenCode's leftover-token buffer. Kept as documentation of the A5 decision, not as a trigger.
 *
 * A 20k leftover fires at 37% of a 32k window and spends the rest of a short-context model on
 * summaries. The ratio stays a constant fraction of whatever window the model actually has.
 */
export const COMPACTION_BUFFER_TOKENS = 20_000;

/**
 * 触发线还得给摘要请求留出位置：分叉请求是完整历史加一条指令，摘要要写在窗口剩下的地方。
 *
 * 大窗口上 90% 留下的比这多，这一项不起作用；只在小窗口上把线往前挪——32k 的 90% 只剩 3.2k，
 * 放不下一份 8k 的摘要，分叉请求必然超长，每次都白发一遍再退回独立请求。
 *
 * 大窗口不再往后推到「窗口减固定预留」（opencode、pi 的做法）：每一轮都要按缓存价重读整段前缀，
 * 线越靠后，两次压缩之间的每一轮越贵。推导见 docs/architecture/agent-cost-and-stopping.md 的 A5。
 */
export function summaryHeadroom(contextWindow: number): number {
	return Math.min(8000, Math.floor(contextWindow / 4)) + Math.min(2000, Math.floor(contextWindow / 20));
}

export function compactionTriggerTokens(contextWindow: number): number {
	return Math.max(0, Math.floor(Math.min(contextWindow * COMPACTION_RATIO, contextWindow - summaryHeadroom(contextWindow))));
}
/**
 * How far under the threshold pruning alone has to land before summarising is skipped.
 *
 * The number being compared is a product of two estimates and the failure it guards against is
 * silent: a turn that believes it is inside the window, is not, and arrives at the next turn no
 * smaller than before.
 */
const PRUNE_MARGIN = 0.1;
/**
 * How much of the window the verbatim recent tail may occupy.
 *
 * By size rather than by count, because six messages is a small tail in a conversation of short
 * replies and an enormous one when a single tool result is a whole file.
 *
 * This is the number that decides whether recent work survives compaction intact, so it is not
 * pushed lower to win compression: the summary can describe what happened three hours ago, but the
 * file being edited right now has to be there in full or the next turn re-reads it. Everything
 * older is recoverable through `recall`; the current task is what must not need recovering.
 */
const KEEP_BUDGET = 0.12;
/** Never fewer than this, however big they are: the agent cannot work without its last exchange. */
const KEEP_MIN = 4;
/**
 * What the conversation must weigh once compaction is done.
 *
 * Well under the threshold that triggers it, and that gap is the point: landing just below the
 * trigger means the next few messages cross it again, so a long run spends its time summarising
 * instead of working. A summary of a few thousand tokens beside a tail of at most `KEEP_BUDGET`
 * normally lands far below this — the ceiling exists for the case where it does not.
 */
const SAFE_AFTER = 0.3;

/**
 * Which strategy is in force.
 *
 * Bound by the host at boot; unbound everywhere else, where the built-in answer is the right one.
 * Callers go through `compactWith` so that replacing the strategy is a plugin, not an edit to the
 * loop that runs out of room.
 */
let strategy: CompactionStrategy | null = null;

export function useCompaction(next: CompactionStrategy | null): void {
	strategy = next;
}

/**
 * The one way history gets shortened.
 *
 * Both paths come through here — the loop running out of room, and a person typing `/compact` —
 * and both hand over the whole request. They did not always: this took seven positional arguments
 * and forwarded four of them to the strategy, so a host that bound one (the desktop does) lost
 * the overhead and the artifact sink without a word. The request is an
 * object now so that adding to it cannot leave a caller silently short — and the built-in policy
 * takes the same object, so there is no second place that spells the fields out one by one.
 */
export function compactWith(request: CompactionRequest): Promise<Compaction | null> {
	if (strategy) return strategy.compact(request);
	return compactIfNeeded(request);
}

/**
 * The built-in policy. What each field of the request is for is documented on `CompactionRequest`;
 * the defaults are applied here and only here, so no caller has a copy of them to drift.
 */
export async function compactIfNeeded(request: CompactionRequest): Promise<Compaction | null> {
	const { model, provider, artifacts, manual, observer } = request;
	const streamFn = request.streamFn ?? streamAssistant;
	const overhead = request.overhead ?? 0;
	const force = request.force ?? false;
	let messages = request.messages;
	/*
	 * The provider's own count, not our estimate of it.
	 *
	 * `estimateTokens` is characters over 3.5: fair over English prose and code, badly low on CJK
	 * and on dense JSON. Both errors point the same way, so a conversation sitting at 200.7k of a
	 * 200k window reported something in the eighties and never crossed this line.
	 *
	 * `measureTotal` is also what the context panel shows, so what triggers compaction is the same
	 * figure the user is watching fill up. It falls back to the estimate before the first reply has
	 * landed, which is the only point at which there is nothing measured to use.
	 */
	const measured = measureTotal(messages);
	const originalMessages = messages;
	// Before the first measured reply (and after compaction), schemas and instructions still count.
	const used = measured.tokens + (measured.measured ? 0 : overhead);
	if (!force && used < compactionTriggerTokens(model.contextWindow)) return null;

	/*
	 * Cut the oversized tool results first, and see whether that was enough.
	 *
	 * Cheapest thing first, by a wide margin: cutting is string work, summarising is a model call
	 * that is slow, billed, and least reliable exactly when the window is tight.
	 */
	/*
	 * Results with nothing in them go first, before anything with content is touched.
	 *
	 * A search that matched nothing and a listing of an empty directory take up room and answer no
	 * question that will be asked again. Emptying them is free in a way that cutting a real result
	 * is not — nothing is lost, so there is no judgement about what the model might need later.
	 *
	 * 被后来的观察覆盖的结果也只在这里清：会话中途不改写已经发出去的内容，压缩本来就要重写前缀。
	 */
	const tidied = dropUneventful(messages);
	const stale = dropStaleResults(tidied);
	/*
	 * 模型还没看过的新结果（最后一条助手消息之后）只剪炸开的那种，和发送路径第一次发出前的那条线相同。
	 * `read` 把输出控制在这条线以内，并把返回的行记成读过；这里照常剪到 8k 的话，它记下的又
	 * 多于模型看到的，`edit` 会放行没见过的行。
	 */
	const unseenFrom = stale.findLastIndex((message) => message.role === "assistant") + 1;
	const seenPart = stale.slice(0, unseenFrom);
	const unseenPart = stale.slice(unseenFrom);
	const seenPruned = pruneToolResults(seenPart, undefined, artifacts);
	const unseenPruned = pruneToolResults(unseenPart, FRESH_RESULT_MAX_CHARS, artifacts);
	const pruned = seenPruned === seenPart && unseenPruned === unseenPart ? stale : [...seenPruned, ...unseenPruned];
	if (pruned !== messages) {
		/*
		 * Priced by calibrating the estimate on the view that was measured, then applying that same
		 * calibration to the cut copy. Dividing the measurement by an estimate of the cut copy instead
		 * gives back `used` for any cut at all, so this path could never be taken with a measured
		 * usage: a history estimated at 8.6k tokens cut to 1.5k still asked for a summary.
		 *
		 * `messages` stands in for what the last request sent. Every automatic caller is the loop,
		 * which passes the array it sent — `AgedToolPruner` puts back the views it sent before, so a
		 * result it already cut arrives cut and saves nothing twice — plus what arrived since. The
		 * approximation errs cautious when the pruner cut more this turn (the estimate is below what
		 * was measured, the calibration above the truth). Views an earlier compaction adopted survive
		 * a restart (`SessionLog.restoredViews`), so a result that went out cut arrives cut then too.
		 * `/compact` passes the log in full, but it forces a summary and never takes this path.
		 */
		const sent = estimateTokens(messages);
		const calibration = measured.measured && sent > 0 ? Math.max(0, used - overhead) / sent : 1;
		const next = estimateTokens(pruned) * calibration + overhead;
		/*
		 * And it has to clear the line by a margin, because both sides of that product are estimates
		 * and being wrong in the eager direction sends a turn that does not fit — which comes back
		 * the same size, with nothing left to cut.
		 */
		/*
		 * Not when compaction was asked for by name. Cutting tool output is the cheap half of this
		 * and it leaves the conversation itself untouched — which is precisely what someone typing
		 * `/compact` wants dealt with.
		 */
		if (!force && next < compactionTriggerTokens(model.contextWindow) - model.contextWindow * PRUNE_MARGIN) {
			return { messages: pruned, summary: "" };
		}
		// Not enough on its own, but everything below now works on the smaller conversation.
		messages = pruned;
	}

	// Too short to have a past worth summarising, whatever it weighs.
	if (messages.length <= KEEP_MIN + 2) {
		return pruned !== originalMessages ? { messages: pruned, summary: "" } : null;
	}

	/*
	 * The estimate corrected by however wrong it was overall, so the cut lands where it is meant to.
	 *
	 * The threshold above uses the measured total, but the budget below is spent one message at a
	 * time and there is no per-message figure from the provider to spend it against. The correction
	 * applies to the messages alone, never to the overhead: `used` covers prompt, schemas and
	 * history, `raw` estimates only the history, and dividing one by the other would bake a
	 * constant into a variable.
	 *
	 * Divided by the cut copy, not by what was sent: `/compact` hands over the log in full, which can
	 * be many times what was measured, and a scale that runs low here lets the summary request and
	 * the kept tail outgrow the window. Over the cut copy it can only run high, the safe way.
	 */
	const raw = estimateTokens(messages);
	const conversation = Math.max(0, used - overhead);
	const scale = measured.measured && raw > 0 ? conversation / raw : 1;

	// Keep recent turns until their budget is spent, then cut — never between an assistant
	// message and the tool results answering it, which both APIs reject.
	// A manual request retires completed work even when it fits comfortably in a large window.
	const keepBudget = force ? Math.min(model.contextWindow * KEEP_BUDGET, conversation * KEEP_BUDGET) : model.contextWindow * KEEP_BUDGET;
	let cut = messages.length;
	let kept = 0;
	while (cut > 1) {
		const next = estimateTokens([messages[cut - 1]]) * scale;
		if (messages.length - cut >= KEEP_MIN && kept + next > keepBudget) break;
		kept += next;
		cut--;
	}
	while (cut < messages.length && messages[cut].role === "toolResult") cut++;
	if (cut <= 1) return null;

	const older = messages.slice(0, cut);
	const recent = messages.slice(cut);

	/*
	 * 先试从主请求分叉（`compaction-fork.ts`）：同一个前缀，缓存照常命中，看到的是没剪过的完整历史。
	 * 它摘要的是整段，包括下面原样保留的尾部——那几条说两遍，比整段历史按原价重读一遍便宜得多。
	 * 没有分叉起点、换了模型、缓存凉了、放不下、或者它没交回一份摘要，就退回独立请求。
	 */
	let summary: string | null = null;
	let via: CompactionVia = "independent";
	let prefix: RequestPrefix | undefined;
	if (forkable(request.lineage, provider, model)) {
		await observer?.progress({ phase: "summarizing", provider: provider.id, model: model.id });
		const forked = await forkSummary(request.lineage, provider, model, streamFn, {
			instructions: force ? manual?.instructions : undefined,
			signal: manual?.signal ?? observer?.signal,
			observer,
		});
		if (manual?.signal?.aborted) throw new Error("压缩已取消。");
		if (observer?.signal?.aborted) return null;
		prefix = forked.prefix;
		if (forked.summary) {
			summary = forked.summary;
			via = "fork";
		}
	}
	if (!summary) {
		await observer?.progress({ phase: "summarizing", provider: provider.id, model: model.id });
		summary = await summarize(older, model, provider, streamFn, force ? manual ?? {} : undefined, observer, scale);
		if (observer?.signal?.aborted) return null;
	}
	if (!summary) {
		summary = fallbackSummary(older);
		via = "fallback";
	}
	const tagged = (result: Compaction | null): Compaction | null => (result && prefix ? { ...result, prefix } : result);
	if (!summary) return tagged(dropOldest(messages, model, overhead, scale));
	const text = summary;

	/*
	 * Keep dropping the oldest of what was kept until the result actually fits.
	 *
	 * Shrinking is not the requirement; fitting is. A window at 277k that compacts to 250k has been
	 * compacted and still cannot be sent, and the next turn arrives at a conversation that is over
	 * the line with nothing left to try.
	 *
	 * The summary is written once — that is the part that costs a request — and what varies
	 * afterwards is how much of the recent tail is kept beside it, which costs nothing to
	 * reconsider. Tool results are dropped with the call they answer, since sending one without the
	 * other is rejected outright.
	 */
	const target = Math.max(0, model.contextWindow * SAFE_AFTER - overhead);
	const scaled = (list: Message[]) => estimateTokens(list) * scale;
	let tail = recent;
	const withHead = () => {
		// Tail trimming can retire another request or plan update; keep its facts outside the summary too.
		const retired = messages.slice(0, messages.length - tail.length);
		return [...summaryMessages(text, lastRequest(retired), provider, model, filesSeen(retired), taskContextFromHistory(retired)), ...tail];
	};
	let compacted = withHead();
	while (scaled(compacted) > target && tail.length > 1) {
		let drop = 1;
		while (drop < tail.length && tail[drop].role === "toolResult") drop++;
		tail = tail.slice(drop);
		compacted = withHead();
	}

	/*
	 * A summary that did not shrink anything is not worth the message it arrived in. Compared in
	 * one unit — the scaled estimate — because comparing an estimate against a measured total lets
	 * the estimator's own error decide the answer.
	 */
	let result: Compaction | null = scaled(compacted) < scaled(messages) ? { messages: compacted, summary: text, kept: tail.length, via } : null;

	/*
	 * 尾部删光了仍在触发线以上，是摘要本身太大——多半是兜底摘要带着整段历史请求。先试按条丢弃：落到线下
	 * 就用它。都落不到的，取两份里小的那份，但它必须在窗口以内——交回一份发不出去的历史当作压缩成功，
	 * 下一轮只会原样超长。比的是触发线而不是 `target`：后者是想落到的位置，落不到那里但已在线下的结果
	 * 照样能用。光开销就占满触发线时什么历史都放不下，丢弃也救不了，不走这一步。
	 */
	const room = compactionTriggerTokens(model.contextWindow) - overhead;
	if (room > 0 && scaled(compacted) >= room) {
		const dropped = dropOldest(messages, model, overhead, scale);
		if (dropped && scaled(dropped.messages) < room) return tagged(dropped);
		if (dropped && scaled(dropped.messages) < scaled(result?.messages ?? messages)) result = dropped;
		if (result && scaled(result.messages) + overhead > model.contextWindow) return null;
	}
	return tagged(result);
}

/**
 * Getting under the line without a model, for when the summary could not be had.
 *
 * Summarising is a request, and a request fails — the relay is out of credentials, the key is
 * refused, the turn is cancelled. Answering that with `null` reads as "no compaction was needed",
 * and the caller carries on with a conversation that is over the window. The next turn measures the
 * same overfull history, asks for the same summary, and fails the same way.
 *
 * Losing the oldest exchanges outright is worse than summarising them and better than the only
 * alternative, which is a turn that cannot be sent at all. Nothing is destroyed either way: the log
 * keeps everything, and `recall` can still find it.
 *
 * Cuts on whole units. A tool result whose call has been dropped is rejected by both APIs.
 */
function dropOldest(messages: Message[], model: ModelConfig, overhead: number, scale: number): Compaction | null {
	const target = Math.max(0, model.contextWindow * SAFE_AFTER - overhead);
	const weight = (list: Message[]) => estimateTokens(list) * scale;

	// 预算的是交出去的整份：前面那条说明带着最新请求和任务上下文，中文下能有好几千 token。
	const build = (start: number) => {
		const older = messages.slice(0, start);
		const standing = lastRequest(older) ?? lastRequest(messages);
		return [droppedMessage(standing, taskContextFromHistory(older), model), ...messages.slice(start)];
	};
	if (weight(messages) <= target) return null;
	let start = 0;
	let result: Message[] = messages;
	while (start < messages.length - 1) {
		start++;
		// Never begin on an answer whose question has just been dropped.
		while (start < messages.length && messages[start].role === "toolResult") start++;
		result = build(start);
		if (weight(result) <= target) break;
	}
	if (start === 0) return null;
	// 丢到只剩最后一条仍可能放不下；放不放得下由调用方和摘要结果一起比（见 `compactIfNeeded`）。
	return { messages: result, summary: "", kept: result.length - 1, via: "dropped" };
}
