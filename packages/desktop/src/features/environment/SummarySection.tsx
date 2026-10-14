/**
 * 一段话的会话摘要。
 *
 * 这里不决定什么时候生成：主进程在每轮结束、静下来一分钟后自己去要（`electron/session-summary.ts`
 * 的 `summarizeAfterTurn`），卡片只读存着的那份、听它推来的新一份。原先由这里掐表去要，点开一个
 * 早就停下的旧会话就立刻花一次。
 *
 * 还没有摘要时整节不占位，只在后台真在生成的那几秒画骨架。失败了留一个「重试」给人点。
 */

import { useEffect, useMemo, useState } from "react";
import type { Message } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useScopedMessages, useScopedRunning } from "../../app/session-scope.tsx";
import { SkeletonBar } from "../../ui/primitives/Skeleton.tsx";
import { exactTime, shortRelativeTime } from "../../lib/relative-time.ts";
import type { StoredSummary } from "../../../electron/session-summary.ts";
import { Section, SectionLabel } from "./rows.tsx";

/** 最后一条人或 agent 说出来的话是什么时候——只有它会让摘要过期，工具调用不会。 */
function lastSpoken(messages: readonly Message[]): number | null {
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (!message || message.role === "toolResult") continue;
		if (message.role === "user" && message.synthetic) continue;
		if (message.content.some((block) => block.type === "text" && block.text.trim())) return message.timestamp;
	}
	return null;
}

/** 「2 分钟前更新」。刚生成的那一刻说「刚刚更新」——「刚刚前」不成话，所以不套同一个句子。 */
function UpdatedAt({ at }: { at: number }) {
	const { t } = useI18n();
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);
	const iso = new Date(at).toISOString();
	return (
		<span className="tabular-nums" data-ly-tip={exactTime(iso)}>
			{now - at < 60_000 ? t("environment.summaryJustNow") : t("environment.summaryUpdated", { time: shortRelativeTime(iso, now) })}
		</span>
	);
}

type State = { sessionId: string; summary: StoredSummary | null; pending: boolean; error: string | null };

/** 留更新的那份：读盘的那一下可能比后台推来的新一份还晚回来。 */
const newer = (held: StoredSummary | null, next: StoredSummary | null | undefined) =>
	next && (!held || next.updatedAt >= held.updatedAt) ? next : held;

export function SummarySection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const messages = useScopedMessages();
	const running = useScopedRunning();
	const latest = useMemo(() => lastSpoken(messages), [messages]);
	const [state, setState] = useState<State>({ sessionId, summary: null, pending: false, error: null });
	const current = state.sessionId === sessionId ? state : { sessionId, summary: null, pending: false, error: null };

	useEffect(() => {
		let live = true;
		setState({ sessionId, summary: null, pending: false, error: null });
		void bridge.sessions.summary(sessionId).then(
			(summary) => live && setState((now) => (now.sessionId === sessionId ? { ...now, summary: newer(now.summary, summary) } : now)),
			() => {},
		);
		const off = bridge.sessions.onSummaryChanged((update) => {
			if (update.sessionId !== sessionId) return;
			setState((now) => (now.sessionId !== sessionId ? now : { ...now, pending: update.pending, summary: newer(now.summary, update.summary), error: update.pending ? null : (update.error ?? null) }));
		});
		return () => {
			live = false;
			off();
		};
	}, [sessionId]);

	const stale = latest !== null && current.summary !== null && latest > current.summary.upto;
	const retry = () => {
		setState((now) => ({ ...now, pending: true, error: null }));
		void bridge.sessions.summarize(sessionId).then(
			(result) => setState((now) => (now.sessionId !== sessionId ? now : { ...now, pending: false, summary: newer(now.summary, result.summary), error: result.error ?? null })),
			(error: unknown) => setState((now) => (now.sessionId !== sessionId ? now : { ...now, pending: false, error: String(error) })),
		);
	};

	if (!current.summary && !current.pending && !current.error) return null;

	return (
		<Section name="summary">
			<SectionLabel>{t("environment.summary")}</SectionLabel>
			<div className="px-2 pb-1">
				{current.summary ? (
					<p data-ly-environment-summary className="text-detail leading-relaxed text-ink-muted">{current.summary.text}</p>
				) : current.error ? null : (
					<div className="flex flex-col gap-1.5 py-1" aria-hidden>
						<SkeletonBar width="100%" />
						<SkeletonBar width="92%" />
						<SkeletonBar width="60%" />
					</div>
				)}
				<div className="mt-1.5 flex items-center gap-1.5 text-caption text-ink-faint">
					{current.error ? (
						<>
							<span className="min-w-0 truncate" data-ly-tip={current.error}>{t("environment.summaryFailed")}</span>
							<button type="button" className="shrink-0 text-accent hover:underline" onClick={retry}>
								{t("common.retry")}
							</button>
						</>
					) : current.summary && stale && (running || current.pending) ? (
						<>
							<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
							<span className="truncate">{running ? t("environment.summaryAfterTurn") : t("environment.summaryUpdating")}</span>
						</>
					) : current.summary ? (
						<UpdatedAt at={current.summary.updatedAt} />
					) : null}
				</div>
			</div>
		</Section>
	);
}
