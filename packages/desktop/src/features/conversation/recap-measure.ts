import { useEffect, type RefObject } from "react";
import { useScopedLoading, useScopedMessages, useScopedSessionId } from "../../app/session-scope.tsx";
import { dismissRecap, requestRecap, useRecaps, type RecapOffer } from "../../store/recap.ts";

/**
 * 回顾条出不出现的最后一道：新内容一屏放得下，就不必回顾——往上看一眼的事。
 *
 * 什么时候算「回来」见 `recap.ts`；条本身画在输入框上方，见 `composer/RecapBar.tsx`。这一段要量
 * 转录，所以留在转录这边。
 */
/** 转录的高度静下来多久，才认定新内容一屏放得下。 */
const SETTLE_MS = 1200;

export function useRecapMeasure(
	viewport: RefObject<HTMLElement | null>,
	/** 转录里人提的每个问题在第几条，新内容从哪一问开始从这里挑。 */
	questions: readonly { index: number }[],
): void {
	const sessionId = useScopedSessionId();
	const offer = useRecaps((s) => (sessionId ? s.offers[sessionId] : undefined));
	const loading = useScopedLoading();
	const messages = useScopedMessages();
	const target = newFrom(questions, offer);

	/*
	 * 量「新内容有没有超过一屏」：从那一问的顶到转录底。
	 *
	 * 那一问不在画面里，是转录按轮开窗把它留在了前面——那它离底部至少隔着一整个窗口，算超过。
	 * 跑完的轮次里工具调用是收起的，所以一轮跑了四十次工具、收尾一段话，往往一屏放得下：那段收尾
	 * 本身就是这一轮的回顾，不必再写一份。
	 *
	 * 用 `useEffect` 而不是 layout effect：切会话、整个转录重新挂载的那一次，滚动容器的 ref 要到
	 * 提交之后才稳妥地挂上。
	 *
	 * 不是量一次就定：切回来时先画的是缓存，后台跑完的那一轮在缓存里可能还是半截，随后才从磁盘
	 * 补全——条数没变，高度变了。量到一次超过就算数；转录的高度静下来一段时间还没超过，才算一屏
	 * 放得下。量的这段时间回顾条什么都不画。
	 */
	useEffect(() => {
		if (!sessionId || offer?.status !== "measuring" || loading || messages.length === 0) return;
		const el = viewport.current;
		if (!el) return;
		const exceeds = () => {
			const anchor = target === null ? null : el.querySelector<HTMLElement>(`[data-question-index="${target}"]`);
			const top = anchor ? el.scrollTop + anchor.getBoundingClientRect().top - el.getBoundingClientRect().top : -Infinity;
			return el.scrollHeight - top > el.clientHeight;
		};
		if (exceeds()) {
			void requestRecap(sessionId, false);
			return;
		}
		let quiet = window.setTimeout(() => dismissRecap(sessionId), SETTLE_MS);
		const observer = new ResizeObserver(() => {
			if (exceeds()) {
				observer.disconnect();
				window.clearTimeout(quiet);
				void requestRecap(sessionId, false);
				return;
			}
			window.clearTimeout(quiet);
			quiet = window.setTimeout(() => dismissRecap(sessionId), SETTLE_MS);
		});
		for (const child of el.children) observer.observe(child);
		return () => {
			observer.disconnect();
			window.clearTimeout(quiet);
		};
	}, [sessionId, offer?.status, loading, messages.length, target, viewport]);
}

/**
 * 新内容从哪个问题开始：离开时看到的那一条所在的那一轮；不知道看到哪，就是最后一个问题。
 *
 * 按轮而不是按条：量「新内容有没有超过一屏」要从那一轮的问题量起，从一轮中间量会少算。
 */
function newFrom(questions: readonly { index: number }[], offer: RecapOffer | undefined): number | null {
	if (!offer || offer.manual || questions.length === 0) return null;
	if (offer.since === null) return questions.at(-1)?.index ?? null;
	const since = offer.since;
	return questions.findLast((question) => question.index < since)?.index ?? questions[0].index;
}
