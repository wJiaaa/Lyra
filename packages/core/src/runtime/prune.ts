/**
 * Cutting oversized tool results down before they are sent, without asking a model.
 *
 * A single `grep` can answer with 96,000 characters — its match limit counts matches, and a match
 * in a minified file is one very long line. Two or three of those fill a 200k window on their own,
 * and by the time compaction notices, the thing it has to summarise is mostly the same file read
 * three ways. Summarising is a model call: slow, billed, and fallible exactly when the window is
 * tight. Cutting is neither.
 *
 * So this runs first and costs nothing. What survives is a head, a marker that says what was taken,
 * and a tail — the shape of a tool result being what it is: the beginning carries the answer, the
 * end carries the totals and the error, and the middle is the part you scroll past.
 *
 * Only the copy sent to the model is cut. The session log keeps the complete result, so the card in
 * the transcript still opens to everything the tool actually said, and a later replay of the log is
 * unaffected. This is a view, not an edit.
 *
 * Idempotent by construction: the replacement is strictly shorter than the threshold, so a second
 * pass over the same message finds nothing left to do.
 */

import type { Message, ToolResultMessage } from "../types.ts";

/**
 * 每份剪短的副本是从哪条消息剪出来的。
 *
 * 剪枝只改发给模型的副本，日志里是原文；下一轮从日志重建历史时，拿到的又是原文。`AgedToolPruner`
 * 按原文记住上一次发出去的副本，才能把同一份视图再发一次——前缀不断、实测 usage 也对得上。
 * 但副本不全是它自己剪的：循环外层的 `dropUneventful`、压缩里的剪枝都产出新对象，它得顺着这条链
 * 找回原文。只记身份关系，不记决定，所以放在模块级是安全的；弱引用，随消息一起回收。
 */
const parents = new WeakMap<Message, Message>();

/** 记下 `view` 是从 `source` 剪出来的，原样返回 `view`。 */
export function derive<T extends Message>(source: Message, view: T): T {
	if (view !== source) parents.set(view, source);
	return view;
}

/** 顺着剪枝链回到日志里那条原文；本来就是原文的返回它自己。 */
export function sourceOf(message: Message): Message {
	let at = message;
	for (let parent = parents.get(at); parent; parent = parents.get(at)) at = parent;
	return at;
}

/** `message` 是否就是 `ancestor`，或是从它进一步剪出来的。 */
export function descends(message: Message, ancestor: Message): boolean {
	for (let at: Message | undefined = message; at; at = parents.get(at)) if (at === ancestor) return true;
	return false;
}

/**
 * Above this, a result is cut. Below it, nothing happens at all.
 *
 * Roughly 2,300 tokens of prose or code. Large enough that ordinary results — a file read, a test
 * run, a directory listing — pass through untouched, and small enough that a handful of the
 * pathological ones cannot spend a window between them.
 */
export const PRUNE_THRESHOLD_CHARS = 8192;
/** Kept from the front, where a tool puts its answer. */
const PRUNE_HEAD_CHARS = 4096;
/** Kept from the back, where it puts totals, errors and "N more matches". */
const PRUNE_TAIL_CHARS = 1024;
/**
 * Below this, cutting a result costs more than it saves.
 *
 * The marker itself is prose — it runs to a couple of hundred characters. Cutting a 300-character
 * result to insert it saves nothing at all, and pays for that nothing by rewriting the middle of
 * the conversation, which invalidates the provider's prefix cache from that point on. The next
 * request then re-bills every token above it.
 */
export const PRUNE_FLOOR_CHARS = 200;

/**
 * Says what happened, in the model's own reading order, and how much is missing.
 *
 * `address` 是那段被剪掉的内容的地址。有它的时候这句话从「完整结果留在会话里」变成
 * 「完整结果在这儿，自己去取」——前者对模型来说等于没有，它读不到转录。
 */
function marker(omitted: number, address?: string): string {
	const where = address
		? `the full result is at \`${address}\` — \`read ${address}\` if you need the middle`
		: "the full result is kept in the session and shown in the transcript. Narrow the search or read a specific file if you need the middle";
	return `\n\n… [${omitted.toLocaleString("en-US")} characters omitted by Lyra to fit the context window; ${where}.] …\n\n`;
}

/**
 * The text of a tool result, cut to size, or `null` if it was already small enough.
 *
 * Split on code points rather than UTF-16 units, so a surrogate pair is never left half-written —
 * a lone surrogate is not text any provider will accept. A grapheme cluster can still be split;
 * that costs one malformed emoji at a boundary, where the alternative is a scan of the whole
 * string for a saving nobody can see.
 */
export function pruneText(text: string, threshold = PRUNE_THRESHOLD_CHARS, address?: string): string | null {
	const points = [...text];
	if (points.length <= threshold) return null;
	/*
	 * A threshold below the marker's own length would make cutting a net loss.
	 *
	 * Reachable only through a caller passing a small threshold, which the recovery path does. The
	 * marker runs to a couple of hundred characters, so cutting a 300-character result to insert
	 * it saves nothing and rewrites the middle of the conversation to do it.
	 */
	if (points.length <= PRUNE_FLOOR_CHARS) return null;
	return cutTo(points, threshold, address);
}

/**
 * `points` cut so that head, marker and tail together take at most `room` code points.
 *
 * A room that holds the default head and tail gets exactly those, so a lone result is cut the way
 * it always was. A smaller one — a block sharing the threshold with its neighbours — keeps the same
 * four-to-one split of what is left once the marker is paid for. Never below the floor: a cut that
 * keeps less than the marker is all marker.
 */
function cutTo(points: string[], room: number, address?: string): string | null {
	const keep = Math.max(PRUNE_FLOOR_CHARS, Math.min(PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS, room - [...marker(points.length, address)].length));
	const head = Math.min(PRUNE_HEAD_CHARS, Math.ceil(keep * 0.8));
	const tail = Math.min(PRUNE_TAIL_CHARS, keep - head);
	const note = marker(points.length - head - tail, address);
	// Only reachable with a room below the marker's own length; a "cut" that grows the text is not one.
	if (head + tail + [...note].length >= points.length) return null;
	return `${points.slice(0, head).join("")}${note}${points.slice(points.length - tail).join("")}`;
}

/**
 * The largest per-block allowance under which `sizes`, each held to it, sum to at most `budget`.
 *
 * Water-filling: blocks smaller than the allowance keep all of theirs and leave the remainder to
 * the ones that are not, so a small block beside a huge one is never touched.
 */
export function allowance(sizes: number[], budget: number): number {
	const ordered = [...sizes].sort((a, b) => a - b);
	let left = budget;
	for (let i = 0; i < ordered.length; i++) {
		const share = Math.floor(left / (ordered.length - i));
		if (ordered[i] > share) return share;
		left -= ordered[i];
	}
	return Number.POSITIVE_INFINITY;
}

/**
 * One message, with any oversized text cut down. Returns the same object when nothing changed.
 *
 * Identity is the signal callers use to decide whether anything happened, so it matters that an
 * untouched message comes back as itself rather than as an equal copy.
 */
/**
 * 把剪掉的原文存起来，换回一个地址。
 *
 * 传进来而不是在这里建：存在哪儿是会话的事，而这个模块是纯的——它现在唯一的副作用就是这个
 * 回调，而它是可选的。没有它的时候剪枝的行为跟以前一模一样。
 */
export interface ArtifactSink {
	keep(tool: string, content: string): string;
}

function pruneMessage(message: Message, threshold: number, artifacts?: ArtifactSink): Message {
	if (message.role !== "toolResult") return message;

	/*
	 * Measured over the text blocks together, and cut back inside that same total.
	 *
	 * A result is usually one text block, but it does not have to be. Judging each block on its own
	 * would let ten blocks of eight thousand characters through, and cutting every block to an equal
	 * share would mangle a small block sitting beside a huge one. So the threshold is shared out by
	 * `allowance`: small blocks keep everything, the big ones split what is left.
	 */
	const texts = message.content.flatMap((block, index) => (block.type === "text" ? [{ index, points: [...block.text] }] : []));
	const total = texts.reduce((sum, block) => sum + block.points.length, 0);
	if (total <= threshold) return message;
	const tool = message.toolName ?? "工具";
	const level = allowance(texts.map((block) => block.points.length), threshold);
	const content = [...message.content];

	/*
	 * Too many big blocks to give each its own marker and still keep a readable head: cut them as one.
	 *
	 * Measured against the marker without an address, which is longer than one with an
	 * `artifact://` address, so the decision does not have to store anything first.
	 */
	if (level - [...marker(total)].length < PRUNE_FLOOR_CHARS) {
		const joined = texts.map((block) => block.points.join("")).join("\n\n");
		const address = artifacts ? artifacts.keep(tool, joined) : undefined;
		const cut = cutTo([...joined], threshold, address);
		if (cut === null) return message;
		content[texts[0].index] = { type: "text", text: cut };
		const dropped = new Set(texts.slice(1).map((block) => block.index));
		return derive(message, { ...message, content: content.filter((_, index) => !dropped.has(index)) } as ToolResultMessage);
	}

	let cut = false;
	for (const block of texts) {
		if (block.points.length <= level) continue;
		/*
		 * 先存原文，再剪。
		 *
		 * 反过来的话存进去的就是剪过的那份，而那正是模型已经有的东西——一个取回来跟手上一样的
		 * 地址，比没有这个地址更浪费。只存真要剪的块：没剪的块模型手上就是全文。
		 */
		const text = (message.content[block.index] as { text: string }).text;
		const address = artifacts ? artifacts.keep(tool, text) : undefined;
		const pruned = cutTo(block.points, level, address);
		if (pruned === null) continue;
		cut = true;
		content[block.index] = { ...message.content[block.index], text: pruned } as ToolResultMessage["content"][number];
	}
	if (!cut) return message;
	return derive(message, { ...message, content } as ToolResultMessage);
}

/**
 * The conversation as it should be sent: every oversized tool result cut, everything else as it was.
 *
 * Returns the same array when nothing needed cutting, so the common case allocates nothing and a
 * caller can tell at a glance whether this pass did anything.
 */
export function pruneToolResults(messages: Message[], threshold = PRUNE_THRESHOLD_CHARS, artifacts?: ArtifactSink): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		const pruned = pruneMessage(message, threshold, artifacts);
		if (pruned !== message) changed = true;
		return pruned;
	});
	return changed ? next : messages;
}

/**
 * The same cut, taken all the way: an oversized result becomes one line saying it was there.
 *
 * The last resort, and only reached after a provider has already refused the request — the
 * `rejectedContent(assistant)` branch in `agent/loop.ts`. Only retries when this actually removed
 * something (`stripped !== messages`): a "recovery" that changed nothing would ask the same
 * question again and be refused the same way. Cutting to a head and a tail is the right trade almost
 * always, because the head is where the answer is. It is the wrong trade in one case: when the
 * *content* is what the far end cannot handle, a head of it is still that content.
 *
 * That case is real. A 60,000-character JSON body from `gh api` made one relay's Gemini
 * translation emit a malformed request — `Unknown name "safetySettings" at 'request.contents[42]'`
 * — on every attempt, so the conversation could not be continued, retried, or escaped from. The
 * same history with that one result replaced went through immediately; the same history with an
 * equally long *plain text* result also went through, which is how we know it was never the size.
 *
 * We cannot know what any given gateway chokes on, and guessing would be a list that goes stale.
 * What we can do is stop sending the thing it choked on, and say so where the model can read it.
 */
export function stripOversizedToolResults(messages: Message[], threshold = PRUNE_THRESHOLD_CHARS): Message[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const size = message.content.reduce((sum, block) => sum + (block.type === "text" ? [...block.text].length : 0), 0);
		if (size <= threshold) return message;
		changed = true;
		return derive(message, {
			...message,
			content: [
				{
					type: "text" as const,
					text:
						`[${size.toLocaleString("en-US")} characters of output withheld: the provider rejected the request ` +
						`while it was included. The full result is in the session and visible in the transcript — ` +
						`run the tool again more narrowly if you need it.]`,
				},
			],
		} as ToolResultMessage);
	});
	return changed ? next : messages;
}

/**
 * How long a conversation must have been idle before rewriting its middle is free.
 *
 * Editing history invalidates a provider's prefix cache from the edit onwards, so a prune that
 * saves tokens this turn can cost more than it saved on the next one. Once the cache has expired
 * on its own there is nothing left to invalidate.
 *
 * Five minutes is the conservative reading: Anthropic's default TTL is five minutes and OpenAI's
 * automatic caching is a few. A session using a longer TTL loses nothing by this — it only means
 * the other condition (a small suffix) is what lets a prune through.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * How much may sit below a prune before the lost cache outweighs it.
 *
 * Everything after the edit has to be re-sent uncached. A short tail is cheap to re-send; a long
 * one is the whole saving handed back.
 */
export const CHEAP_SUFFIX_CHARS = 32_000;

export interface PruneTiming {
	/** When the last request went out, for judging whether the cache is still warm. */
	lastRequestAt?: number;
	/** Now, injectable for tests. */
	now?: number;
}

/**
 * Whether rewriting history at `index` is worth what it breaks.
 *
 * Two ways to say yes, and they are the same reason twice: either the cache below the edit is
 * small, or it is already gone.
 */
/**
 * Characters a size-prune actually removes, so the cache check can weigh the rewrite against
 * the saving. Zero means the result is already under the threshold and must not be touched.
 */
export function sizePruneSaving(chars: number): number {
	if (chars <= PRUNE_THRESHOLD_CHARS) return 0;
	return Math.max(0, chars - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS - MARKER_CHARS);
}

/** 占位标记大约多长，算节省时扣掉。 */
const MARKER_CHARS = 280;

/**
 * 一条新结果最多多长，`AgedToolPruner` 才不会在模型看到它之前就剪掉。
 *
 * 超过它的节省大于 `CHEAP_SUFFIX_CHARS`，算作「炸开的输出」，不等二十轮就剪成头尾——对 `read`
 * 这意味着模型只看到前 4k 和后 1k，而工具已把整段记成读过，`edit` 会放行它没见过的行。
 * 会自己记「已显示」的工具要把输出控制在这以内（见 `tools/read.ts`）。
 */
export const FRESH_RESULT_MAX_CHARS = CHEAP_SUFFIX_CHARS + PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS + MARKER_CHARS;

/**
 * The leftmost rewrite we can afford this request.
 *
 * Once the prefix breaks at `L`, every later cut rides for free. Checking each candidate
 * alone refuses a pile of small superseded reads that together outrun the tail; taking the
 * earliest *individual* pass would also refuse a later 1.7 MB cut because a 400-character
 * stale read sat in front of it. Walk left to right and keep the first `L` whose remaining
 * saving already beats its suffix.
 */
export function firstAffordableCut(messages: Message[], cuts: ReadonlyArray<{ index: number; saving: number }>, timing: PruneTiming = {}): number | undefined {
	if (cuts.length === 0) return undefined;
	const ordered = [...cuts].sort((a, b) => a.index - b.index);
	const remaining = new Map<number, number>();
	let total = 0;
	for (let i = ordered.length - 1; i >= 0; i--) {
		total += ordered[i].saving;
		remaining.set(ordered[i].index, total);
	}
	for (const cut of ordered) {
		if (worthPruning(messages, cut.index, timing, remaining.get(cut.index) ?? 0)) return cut.index;
	}
	return undefined;
}

export function worthPruning(messages: Message[], index: number, timing: PruneTiming = {}, saving = 0): boolean {
	const now = timing.now ?? Date.now();
	if (timing.lastRequestAt !== undefined && now - timing.lastRequestAt >= CACHE_TTL_MS) return true;

	let suffix = 0;
	for (let at = index + 1; at < messages.length; at += 1) {
		for (const block of messages[at].content) {
			if (block.type === "text") suffix += block.text.length;
			/*
			 * Refuse once the tail is both expensive to resend *and* larger than this cut.
			 *
			 * A 1.7 MB grep sitting under 50 k of later text used to stay forever: the 32 k
			 * suffix cap fired regardless of how much the cut saved. If the saving already
			 * exceeds the tail, the next request is cheaper even after the cache break.
			 */
			if (suffix > CHEAP_SUFFIX_CHARS && suffix >= saving) return false;
		}
	}
	return saving > suffix || suffix <= CHEAP_SUFFIX_CHARS;
}

/**
 * Empty out the results that were never going to be read again.
 *
 * Emptied in place, never removed. A `tool_use` whose `tool_result` is missing makes Anthropic
 * reject the request — and not just that request: every later one carrying the same history, which
 * includes the one sent to recover from it. One orphan does not spoil a turn, it spoils the
 * conversation.
 */
export function dropUneventful(messages: Message[], timing: PruneTiming = {}): Message[] {
	let changed = false;
	const next = messages.map((message, index) => {
		if (message.role !== "toolResult" || !message.uneventful) return message;
		const size = message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
		if (size <= PRUNE_FLOOR_CHARS) return message;
		if (!worthPruning(messages, index, timing)) return message;
		changed = true;
		return derive(message, { ...message, content: [{ type: "text" as const, text: "[无结果]" }] } as ToolResultMessage);
	});
	return changed ? next : messages;
}
