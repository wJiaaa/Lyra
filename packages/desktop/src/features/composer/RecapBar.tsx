import { useRef } from "react";
import { X } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useScopedRunning, useScopedSessionId } from "../../app/session-scope.tsx";
import { dismissRecap, useRecaps, type RecapOffer } from "../../store/recap.ts";

/**
 * 回到一个在你不在时干完了活的会话：一句话说它做到哪了、还剩什么。
 *
 * 和 `SubAgentBar` 同一种横条，同一个位置：输入框上方，不随转录滚走——人回来时眼睛先落在这里，
 * 读完正好接着打字。什么时候出现见 `store/recap.ts`；新内容一屏放得下就不出现，那一道在转录那边
 * 量（`conversation/recap-measure.ts`）。
 */
export function RecapBar() {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const offer = useRecaps((s) => (sessionId ? s.offers[sessionId] : undefined));
	const running = useScopedRunning();
	const live = sessionId && offer && offer.status !== "measuring" && !running ? offer : undefined;

	// 收起的那一段还画着最后那一份，字和盒子一起走，不是先空掉再合上。
	const last = useRef<RecapOffer | undefined>(live);
	if (live) last.current = live;
	const drawn = live ?? last.current;

	const text =
		drawn?.status === "loading" ? (
			<span className="flex items-center gap-1.5 text-ink-faint">
				<ActionSpinner size={12} className="text-ink-faint" />
				{t("recap.loading")}
			</span>
		) : drawn?.status === "failed" ? (
			<span className="text-ink-faint">{t(drawn.reason === "empty" ? "recap.empty" : drawn.reason === "model" ? "recap.noModel" : "recap.failed")}</span>
		) : (
			drawn?.text
		);

	return (
		<Collapse open={live !== undefined} className="w-full" bodyClassName="pb-1.5">
			{drawn && (
				<div data-ly-recap="" className="flex w-full items-start gap-2 rounded-[12px] border border-line-soft bg-card/60 py-0.5 pr-2 pl-2.5 text-detail text-ink-muted">
					<span aria-hidden className="shrink-0 py-1">※</span>
					{/* 一句话最多 120 字，一行放不下就折到第二行，再多才省略。 */}
					<p className="line-clamp-2 min-w-0 flex-1 py-1" data-ly-tip={drawn.status === "ready" ? drawn.text : undefined}>
						{text}
					</p>
					{/* 和第一行等高的盒子（行高 1.5em，同样的上下内衬）里居中：折成两行时叉跟着第一行，不掉到两行中间。 */}
					<span className="flex h-[1.5em] shrink-0 items-center box-content py-1">
						<IconButton size="sm" label={t("common.close")} icon={<X size={12} strokeWidth={2} />} onClick={() => sessionId && dismissRecap(sessionId)} />
					</span>
				</div>
			)}
		</Collapse>
	);
}
