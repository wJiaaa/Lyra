/**
 * What the bell at the top of the sidebar opens: the conversations that want you back.
 *
 * The bell had no handler at all — a button since 09-07 that did nothing when pressed. What it now
 * lists is what the app already tracks and already hints at with the dot on the sidebar toggle:
 * conversations waiting for an approval, and ones that finished or failed while you were elsewhere
 * (opening one clears its mark, as it always did). Scheduled tasks that failed unseen come last,
 * as one row that opens the schedule.
 *
 * The conversation on screen is left out: you are already looking at it.
 */

import { AlertTriangle, Bell, Check, Clock, Hand } from "../../ui/icons/index.ts";

import type { SessionActivity } from "@plume/core/activity";
import { useI18n } from "../../i18n/index.ts";
import { relativeTime } from "../../lib/relative-time.ts";
import { sessionTitle } from "../../lib/session-title.ts";
import { useApp } from "../../store/index.ts";
import { MenuBody, Popover, type Anchor } from "../../ui/overlay/Popover.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { useScheduledNotices } from "../scheduled/index.ts";
import { projectLabel } from "../../lib/project-identity.ts";

type Attention = Extract<SessionActivity, "waiting" | "failed" | "done">;
const ORDER: Attention[] = ["waiting", "failed", "done"];

export interface Notices {
	sessions: { id: string; title: string; project: string; state: Attention; updatedAt: number }[];
	scheduledFailures: number;
	/** The loudest thing in the list, for the bell's own dot. */
	top: Attention | null;
}

export function useNotices(): Notices {
	const activity = useApp((s) => s.activity);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const sessions = useApp((s) => s.sessions);
	const projects = useApp((s) => s.settings?.projects);
	const scheduledFailures = useScheduledNotices((s) => s.unseen.length);
	const listed = Object.entries(activity)
		.filter((entry): entry is [string, Attention] => entry[0] !== activeSessionId && ORDER.includes(entry[1] as Attention))
		.map(([id, state]) => {
			const meta = sessions.find((session) => session.id === id);
			return { id, state, title: sessionTitle(meta?.title), project: meta ? projectLabel(projects ?? [], meta) : "", updatedAt: meta?.updatedAt ?? 0 };
		})
		.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.updatedAt - a.updatedAt);
	const top = listed[0]?.state ?? (scheduledFailures > 0 ? "failed" : null);
	return { sessions: listed, scheduledFailures, top };
}

/** The tile carries the state, so the text beside it does not have to say it again. */
const TILE: Record<Attention | "scheduled", { Icon: typeof Check; tint: string }> = {
	waiting: { Icon: Hand, tint: "bg-accent/12 text-accent" },
	failed: { Icon: AlertTriangle, tint: "bg-danger/10 text-danger" },
	done: { Icon: Check, tint: "bg-ok/12 text-ok" },
	scheduled: { Icon: Clock, tint: "bg-danger/10 text-danger" },
};

export function NotificationsMenu({ anchor, notices, onClose }: { anchor: Anchor; notices: Notices; onClose: () => void }) {
	const { t } = useI18n();
	const count = notices.sessions.length + (notices.scheduledFailures > 0 ? 1 : 0);
	return (
		<Popover anchor={anchor} onClose={onClose} placement="bottom" align="end" width="panel" role="menu" label={t("sidebar.notifications")}>
			<MenuBody>
				<div className="flex items-baseline gap-1.5 px-2.5 pt-1.5 pb-2">
					<span className="text-label font-semibold text-ink">{t("sidebar.notifications")}</span>
					{count > 0 && <span className="text-caption text-ink-faint tabular-nums">{count}</span>}
				</div>
				{count === 0 && (
					<div data-ly-notifications-empty className="flex flex-col items-center gap-2 pt-3 pb-5 text-detail text-ink-faint">
						<span className="grid h-9 w-9 place-items-center rounded-full bg-card-hover text-ink-muted">
							<Bell size={16} strokeWidth={1.8} />
						</span>
						{t("notifications.empty")}
					</div>
				)}
				{notices.sessions.map((notice) => {
					const when = notice.updatedAt ? relativeTime(new Date(notice.updatedAt).toISOString()) : "";
					return (
						<Notice
							key={notice.id}
							kind={notice.state}
							title={notice.title}
							// Only waiting is spelled out: a hand alone does not say there is something to approve.
							status={notice.state === "waiting" ? t("notifications.waiting") : undefined}
							meta={[notice.project, when].filter(Boolean).join(" · ")}
							onClick={() => {
								onClose();
								void useApp.getState().openSessionById(notice.id);
							}}
						/>
					);
				})}
				{notices.scheduledFailures > 0 && (
					<Notice
						kind="scheduled"
						title={t("scheduled.unseenFailures", { n: notices.scheduledFailures })}
						onClick={() => {
							onClose();
							useApp.getState().setView("scheduled");
						}}
					/>
				)}
			</MenuBody>
		</Popover>
	);
}

/**
 * One notice: a tinted tile for the state, the title, and where and when beneath it.
 *
 * Not `MenuItem`: its icon column is 18px wide for a bare glyph, and the tile is what makes a
 * glance at the list enough. It keeps `ly-item` and `menuitem`, so hover, press and the arrow keys
 * behave as in every other menu.
 */
function Notice({ kind, title, status, meta, onClick }: { kind: Attention | "scheduled"; title: string; status?: string; meta?: string; onClick: () => void }) {
	const { Icon, tint } = TILE[kind];
	return (
		<button type="button" role="menuitem" data-ly-notice={kind} onClick={onClick} className="ly-scroll ly-item flex w-full items-center gap-2.5 px-2.5 py-2 text-left">
			<span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${tint}`}>
				<Icon size={14} strokeWidth={2} />
			</span>
			<span className="min-w-0 flex-1">
				<span data-ly-notice-title className="block">
					<ScrollText text={title} className="text-label leading-snug text-ink" />
				</span>
				{(status || meta) && (
					<span className="mt-0.5 block truncate text-caption leading-snug text-ink-faint">
						{status && <span className="text-accent">{status}</span>}
						{status && meta && " · "}
						{meta}
					</span>
				)}
			</span>
		</button>
	);
}

/** The bell's dot: the colour of the loudest notice, as the sidebar toggle's dot does it. */
export function NoticeDot({ top }: { top: Notices["top"] }) {
	if (!top) return null;
	return (
		<span
			aria-hidden
			data-ly-notice-dot={top}
			className={`absolute top-1 right-1 h-1.5 w-1.5 rounded-full ${top === "waiting" ? "bg-accent" : top === "failed" ? "bg-danger" : "bg-ok"}`}
		/>
	);
}
