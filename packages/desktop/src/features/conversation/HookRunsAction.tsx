/**
 * 回复底下那排操作里的「钩子」：这一轮跑过哪些钩子、各自怎么收场。
 *
 * 照 ZCode 放在操作排里、点开才看，而不是画进转录：大多数钩子是静静跑完的格式化和日志，一行一行
 * 摆出来只会把回答挤开。拦下了什么、哪条失败了，才是点开时要一眼看到的。
 */

import type { HookRun } from "@lyra/core";
import { Anchor, Ban, Check, CircleSlash, CircleX, Clock } from "lucide-react";
import { useMemo } from "react";
import { useScopedHookRuns } from "../../app/session-scope.tsx";
import { useI18n, type MessageKey } from "../../i18n/index.ts";
import { ActionSpinner } from "../../ui/motion/loaders.tsx";
import { Popover, usePopover } from "../../ui/overlay/Popover.tsx";

const STATUS: Record<Exclude<HookRun["status"], "success">, MessageKey> = {
	running: "hooks.statusRunning",
	blocked: "hooks.statusBlocked",
	failed: "hooks.statusFailed",
	timed_out: "hooks.statusTimedOut",
	cancelled: "hooks.statusCancelled",
};

function StatusIcon({ status }: { status: HookRun["status"] }) {
	if (status === "running") return <ActionSpinner size={13} />;
	if (status === "success") return <Check size={13} className="text-ok" aria-hidden />;
	if (status === "blocked") return <Ban size={13} className="text-accent" aria-hidden />;
	if (status === "failed") return <CircleX size={13} className="text-danger" aria-hidden />;
	if (status === "timed_out") return <Clock size={13} className="text-danger" aria-hidden />;
	return <CircleSlash size={13} className="text-ink-faint" aria-hidden />;
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "";
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `from` 是这一轮开口的那条消息，`to` 是收尾那条回复之后的位置；钩子的 `at` 落在两者之间就归这一轮。 */
export function HookRunsAction({ from, to }: { from: number; to: number }) {
	const { t } = useI18n();
	const all = useScopedHookRuns();
	const runs = useMemo(() => all.filter((run) => run.at > from && run.at <= to), [all, from, to]);
	const popover = usePopover();
	if (runs.length === 0) return null;
	const troubled = runs.some((run) => run.status === "blocked" || run.status === "failed" || run.status === "timed_out");

	return (
		<>
			<button
				type="button"
				data-ly-tip={t("hooks.runs")}
				aria-label={t("hooks.runs")}
				aria-expanded={popover.open}
				onClick={popover.toggle}
				className={`flex h-6 items-center gap-1 rounded-lg px-1.5 text-caption transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink ${troubled ? "text-accent" : "text-ink-faint"}`}
			>
				<Anchor size={12.5} strokeWidth={1.8} aria-hidden />
				<span className="tabular-nums">{runs.length}</span>
			</button>
			{popover.open && (
				<Popover anchor={popover.anchor} onClose={popover.close} placement="top" align="start" width={360} role="dialog" label={t("hooks.runs")}>
					<div className="flex flex-col gap-1 p-1">
						{runs.map((run) => (
							<div key={run.id} className="rounded-lg px-2.5 py-2">
								<div className="flex items-center gap-2">
									<StatusIcon status={run.status} />
									<span className="text-label font-medium text-ink">{run.event}</span>
									{run.toolName && <span className="truncate font-mono text-detail text-ink-faint">{run.toolName}</span>}
									<span className="ml-auto shrink-0 text-detail text-ink-faint">
										{run.source === "project" ? t("hooks.sourceProject") : t("hooks.sourceUser")}
										{run.durationMs !== undefined && ` · ${duration(run.durationMs)}`}
									</span>
								</div>
								<p className="mt-1 truncate font-mono text-detail text-ink-faint">{run.statusMessage ?? run.command}</p>
								{run.status !== "success" && (
									<p className={`mt-1 text-detail ${run.status === "running" || run.status === "cancelled" ? "text-ink-muted" : "text-danger"}`}>
										{t(STATUS[run.status])}
									</p>
								)}
								{run.reason && run.status !== "success" && <p className="mt-0.5 text-detail break-words whitespace-pre-wrap text-ink-muted">{run.reason}</p>}
							</div>
						))}
					</div>
				</Popover>
			)}
		</>
	);
}
