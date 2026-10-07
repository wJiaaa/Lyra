import { useEffect, type RefObject } from "react";
import { ArrowUp, History, X } from "../../ui/icons/index.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useScopedLoading, useScopedMessages, useScopedRunning, useScopedSessionId } from "../../app/session-scope.tsx";
import { dismissRecap, requestRecap, useRecaps, type RecapOffer } from "../../store/recap.ts";

/**
 * 回到一个在你不在时干完了活的会话：它做到哪了、还剩什么、要不要你动手。
 *
 * 放在 `ResumeRow` 那一带，输入框正上方——人回来时眼睛先落在这里，读完正好接着打字。和那一行
 * 一样安静：一道细边、灰字，没有阴影。转录本身就是底，卡片不该从上面鼓出来。
 *
 * 什么时候出现见 `recap.ts`。这里只管最后一道：新内容一屏放得下，就不必回顾——往上看一眼的事。
 */
/** 转录的高度静下来多久，才认定新内容一屏放得下。 */
const SETTLE_MS = 1200;

export function RecapRow({ viewport, questions, onJump }: {
	viewport: RefObject<HTMLElement | null>;
	/** 转录里人提的每个问题在第几条，「跳到新内容」从这里挑落点。 */
	questions: readonly { index: number }[];
	onJump: (index: number) => void;
}) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const offer = useRecaps((s) => (sessionId ? s.offers[sessionId] : undefined));
	const loading = useScopedLoading();
	const running = useScopedRunning();
	const messages = useScopedMessages();
	const target = jumpTarget(questions, offer);

	/*
	 * 量「新内容有没有超过一屏」：从落点那个问题的顶到转录底。
	 *
	 * 落点不在画面里，是转录按轮开窗把它留在了前面——那它离底部至少隔着一整个窗口，算超过。
	 * 跑完的轮次里工具调用是收起的，所以一轮跑了四十次工具、收尾一段话，往往一屏放得下：那段收尾
	 * 本身就是这一轮的回顾，不必再写一份。
	 *
	 * 用 `useEffect` 而不是 layout effect：转录的滚动容器是这一行的祖先，它的 ref 在子孙的 layout
	 * effect 之后才挂上，切会话、整个转录重新挂载的那一次读到的是 null。
	 *
	 * 不是量一次就定：切回来时先画的是缓存，后台跑完的那一轮在缓存里可能还是半截，随后才从磁盘
	 * 补全——条数没变，高度变了。量到一次超过就算数；转录的高度静下来一段时间还没超过，才算一屏
	 * 放得下。量的这段时间这一行什么都不画。
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

	if (!sessionId || !offer || offer.status === "measuring" || running) return null;
	const body =
		offer.status === "loading" ? (
			<p className="flex items-center gap-1.5 text-ink-faint">
				<ActionSpinner size={12} className="text-ink-faint" />
				{t("recap.loading")}
			</p>
		) : offer.status === "failed" ? (
			<p className="text-ink-faint">{t(offer.reason === "empty" ? "recap.empty" : offer.reason === "model" ? "recap.noModel" : "recap.failed")}</p>
		) : (
			offer.text?.split("\n").map((line, index) => <p key={index}>{line}</p>)
		);

	return (
		<div data-ly-recap="" className="ly-enter mt-3 rounded-[10px] border border-line-soft px-3 pt-1.5 pb-2 text-detail text-ink-muted">
			<div className="flex items-center gap-1.5 text-caption text-ink-faint">
				<History size={12} strokeWidth={2} aria-hidden className="shrink-0" />
				<span className="min-w-0 flex-1 truncate">{t(offer.manual ? "recap.title" : "recap.whileAway")}</span>
				<IconButton size="sm" label={t("common.close")} icon={<X size={12} strokeWidth={2} />} onClick={() => dismissRecap(sessionId)} />
			</div>
			<div className="mt-0.5 flex flex-col gap-0.5 leading-[18px]">{body}</div>
			{target !== null && !offer.manual && offer.status === "ready" && (
				// 左边往外让出按钮自己的内衬，字和上面几行对齐。
				<Button variant="subtle" size="xs" className="mt-1 -ml-1.5" icon={<ArrowUp size={11} strokeWidth={2} aria-hidden />} onClick={() => onJump(target)}>
					{t("recap.jump")}
				</Button>
			)}
		</div>
	);
}

/**
 * 新内容从哪个问题开始：离开时看到的那一条所在的那一轮；不知道看到哪，就是最后一个问题。
 *
 * 按轮而不是按条：从一轮中间开始读，前面那句话问的是什么就没了。
 */
function jumpTarget(questions: readonly { index: number }[], offer: RecapOffer | undefined): number | null {
	if (!offer || offer.manual || questions.length === 0) return null;
	if (offer.since === null) return questions.at(-1)?.index ?? null;
	const since = offer.since;
	return questions.findLast((question) => question.index < since)?.index ?? questions[0].index;
}
