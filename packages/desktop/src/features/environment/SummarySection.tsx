/**
 * 一段话的会话摘要。
 *
 * 什么时候去要一份新的，照 Synara 的 recap 定，三条都为了不白花钱：
 *
 * - 卡片开着才要。这一节挂在卡片里，卡片关着它不存在，也就不会去要。
 * - 这一轮还在跑时不要：答到一半的话概括出来，下一秒就过期。
 * - 静下来一会儿再要：第一次等 12 秒，之后每次等 35 秒，从最后一条消息算起。一个早就停下的会话，
 *   打开卡片立刻就要；聊得正热的会话不会每一句都触发一次。
 *
 * 要不要发请求最后由主进程判断（`summaryMaterial`：上一份之后有没有新的话），这里只管时机。失败了
 * 不自动重试同一段材料，留一个「重试」给人点。
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

const FIRST_IDLE_MS = 12_000;
const REFRESH_IDLE_MS = 35_000;

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

type State = { sessionId: string; summary: StoredSummary | null; loaded: boolean; pending: boolean; error: string | null; failedAt: number | null };

export function SummarySection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const messages = useScopedMessages();
	const running = useScopedRunning();
	const latest = useMemo(() => lastSpoken(messages), [messages]);
	const [state, setState] = useState<State>({ sessionId, summary: null, loaded: false, pending: false, error: null, failedAt: null });
	const current = state.sessionId === sessionId ? state : { sessionId, summary: null, loaded: false, pending: false, error: null, failedAt: null };

	useEffect(() => {
		let live = true;
		setState({ sessionId, summary: null, loaded: false, pending: false, error: null, failedAt: null });
		void bridge.sessions.summary(sessionId).then(
			(summary) => live && setState((now) => (now.sessionId === sessionId ? { ...now, summary, loaded: true } : now)),
			() => live && setState((now) => (now.sessionId === sessionId ? { ...now, loaded: true } : now)),
		);
		return () => {
			live = false;
		};
	}, [sessionId]);

	const stale = latest !== null && (!current.summary || latest > current.summary.upto);
	const generate = () => {
		setState((now) => ({ ...now, pending: true, error: null }));
		void bridge.sessions.summarize(sessionId).then(
			(result) =>
				setState((now) =>
					now.sessionId !== sessionId
						? now
						: { ...now, pending: false, summary: result.summary ?? now.summary, error: result.error ?? null, failedAt: result.error ? latest : null },
				),
			(error: unknown) => setState((now) => (now.sessionId !== sessionId ? now : { ...now, pending: false, error: String(error), failedAt: latest })),
		);
	};

	const due = current.loaded && stale && !running && !current.pending && current.failedAt !== latest;
	useEffect(() => {
		if (!due || latest === null) return;
		const idle = current.summary ? REFRESH_IDLE_MS : FIRST_IDLE_MS;
		const timer = window.setTimeout(generate, Math.max(0, latest + idle - Date.now()));
		return () => window.clearTimeout(timer);
		// `generate` 每次渲染都是新的，时机只由这几样决定。
		// oxlint-disable-next-line exhaustive-deps
	}, [due, latest, sessionId, Boolean(current.summary)]);

	// 一句话都还没说过：没有可概括的，整节不占位置。
	if (latest === null && !current.summary) return null;

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
							<button type="button" className="shrink-0 text-accent hover:underline" onClick={generate}>
								{t("common.retry")}
							</button>
						</>
					) : stale && current.summary ? (
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
