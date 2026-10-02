import type { Message } from "../types.ts";
import { carriesResults, derive, descends, dropUneventful, FRESH_RESULT_MAX_CHARS, pruneToolResults, sourceOf, type ArtifactSink } from "./prune.ts";

/**
 * 发给模型的视图：每条工具结果第一次发出前定下它的样子，之后原样重发，不再改写。
 *
 * 前缀缓存从被改的那条起整段失效，而改写得不得划算取决于服务商把缓存留多久——各家不同、中转更
 * 说不准，猜错一次就是整段按原价重算。所以这里不猜：会话中途不改已经发出去的内容，唯一的例外是
 * 压缩（它本来就要重写前缀）。从前的按轮老化和「被新读取覆盖就清掉」都是中途改写，已经去掉；
 * 覆盖的判断留在压缩里做（`compaction.ts` 的 `dropStaleResults`）。
 *
 * 第一次发出前能做的只有两件，都只看这条结果本身：清空「无结果」的输出，把超过
 * `FRESH_RESULT_MAX_CHARS` 的剪成头尾。所以从日志重建时——包括重启之后——会得出同一份，前缀
 * 不靠记忆也接得上（`artifact://` 地址按内容取，见 `SessionCapabilities.keepArtifact`）。
 *
 * 记忆仍然要有，为的是压缩：压缩里剪过的结果经 `adopt` 记下，否则下一轮从日志重建回原文，前缀
 * 从那里断开，而压缩判断读的是剪过之后的 usage，不会再触发，原文照发，隔轮振荡。采纳的那些经
 * `onAdopt` 交给会话写进日志，重启后由 `remember` 放回（`SessionLog.recordViews` / `restoredViews`），
 * 不然重启后的第一次请求把剪过的结果按原文重发，已经发出去的前缀就被改写了。
 */
export class AgedToolPruner {
	private readonly views = new WeakMap<Message, Message>();
	/** 压缩采纳了哪些改写：原文和发出去的那份。会话据此落盘。 */
	onAdopt?: (views: { source: Message; view: Message }[]) => void;

	prepare(messages: Message[], artifacts?: ArtifactSink): Message[] {
		const sources = messages.map(sourceOf);
		const viewed = this.withViews(messages, sources);
		let result = viewed;
		for (let index = 0; index < sources.length; index++) {
			const source = sources[index];
			// 有记录的已经发出去过（或正是记下的那份），原样重发；没记录的就是还没发过的新结果。
			if (!carriesResults(source) || this.views.has(source)) continue;
			const view = source.role === "toolResult" && source.toolName === "skill" ? source : pruneToolResults(dropUneventful([source]), FRESH_RESULT_MAX_CHARS, artifacts)[0];
			this.views.set(source, view);
			if (view === source) continue;
			if (result === viewed) result = [...viewed];
			result[index] = view;
		}
		return result;
	}

	/**
	 * 采纳别处（压缩）对已发视图做的改写，让下一轮从日志重建时换回同一份。
	 *
	 * `before` 与 `after` 按末尾对齐：只剪枝时两边等长，摘要时 `after` 的保留尾部就是 `before`
	 * 的后缀。只认同一份结果（`sameResult`），换了策略插件、对不上的位置跳过。
	 */
	adopt(before: Message[], after: Message[], count = Math.min(before.length, after.length)): void {
		const adopted: { source: Message; view: Message }[] = [];
		for (let k = 1; k <= Math.min(count, before.length, after.length); k++) {
			const was = before[before.length - k];
			const now = after[after.length - k];
			if (now === was || !sameResult(was, now)) continue;
			const source = sourceOf(was);
			this.views.set(source, derive(was, now));
			adopted.push({ source, view: now });
		}
		if (adopted.length > 0) this.onAdopt?.(adopted.reverse());
	}

	/** 放回一份从日志读回来的已发视图：对不上同一份结果的不认。 */
	remember(source: Message, view: Message): void {
		if (sameResult(source, view)) this.views.set(source, derive(source, view));
	}

	/*
	 * 记下的视图优先于从原文重新剪出的副本：上一次发出去的是它，前缀才接得上。只有在它之上
	 * 进一步剪出来的（服务商拒收后 `stripOversizedToolResults` 又剪了一次）才替换它。
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
}

/** 两条是不是同一份结果：工具结果按调用 id，后台送达按它送回的那几份报告的 id。 */
function sameResult(was: Message, now: Message): boolean {
	if (was.role === "toolResult" && now.role === "toolResult") return was.toolCallId === now.toolCallId;
	if (was.role === "user" && now.role === "user" && was.delivery && now.delivery) {
		return was.delivery.map((report) => report.id).join("\n") === now.delivery.map((report) => report.id).join("\n");
	}
	return false;
}

/** Keep the pruned prefix stable when a new user message starts another turn. */
export function sessionPruner(state: Map<string, unknown>): AgedToolPruner {
	const existing = state.get("agedToolPruner");
	if (existing instanceof AgedToolPruner) return existing;
	const pruner = new AgedToolPruner();
	state.set("agedToolPruner", pruner);
	return pruner;
}
