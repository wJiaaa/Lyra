import { useI18n } from "../../i18n/index.ts";
import { ChevronRight, Copy, ExternalLink, Globe, Server, Square, X, CircleAlert } from "../../ui/icons/index.ts";
import { useEffect, useRef, useState } from "react";
import { JobOutput } from "./JobOutput.tsx";
import { useJobFocus } from "../../store/job-focus.ts";
import type { SessionServices as Services } from "../../../shared/session-services.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { commandBrowser } from "../browser/index.ts";

const cache = new Map<string, Services>();
export function SessionServices() {
	const { t } = useI18n();
	// This screen's conversation — the services a task panel lists are the ones its session started.
	const sessionId = useScopedSessionId();
	const [snapshot, setSnapshot] = useState<{ id: string; value: Services } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const confirm = useConfirmer();
	useEffect(() => {
		if (!sessionId) return;
		let live = true, timer: ReturnType<typeof setTimeout>, seen = 0;
		const refresh = async () => {
			clearTimeout(timer);
			try {
				if (!document.hidden && root.current?.getBoundingClientRect().width) {
					const value = await bridge.services.list(sessionId);
					if (live) { cache.set(sessionId, value); setSnapshot({ id: sessionId, value }); }
				}
			} catch (error) {
				if (live) setSnapshot({ id: sessionId, value: { jobs: cache.get(sessionId)?.jobs ?? [], discoveryError: String(error) } });
			} finally { if (live) timer = setTimeout(() => void refresh(), 2000); }
		};
		void refresh();
		const ro = new ResizeObserver(() => {
			const width = root.current?.getBoundingClientRect().width ?? 0;
			if (seen === 0 && width > 0) void refresh();
			seen = width;
		});
		if (root.current) {
			seen = root.current.getBoundingClientRect().width;
			ro.observe(root.current);
		}
		return () => { live = false; clearTimeout(timer); ro.disconnect(); };
	}, [sessionId]);
	const value = sessionId ? snapshot?.id === sessionId ? snapshot.value : cache.get(sessionId) : undefined;
	/*
	 * Ended jobs stay, after the running ones, newest first.
	 *
	 * They used to drop off the moment they exited, which is exactly when their output is wanted —
	 * the build failed, and the only place it said why had just disappeared.
	 */
	const jobs = [
		...(value?.jobs.filter((job) => job.finishedAt === undefined) ?? []),
		...(value?.jobs.filter((job) => job.finishedAt !== undefined).reverse() ?? []),
	];
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = (id: string) => setOpen((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; });
	/*
	 * Asked to show one job (the conversation's "background command failed" line): open it and bring
	 * it into view, once per request. Only after a list has arrived — before that, "not there" means
	 * "not loaded yet", not "gone".
	 */
	const focus = useJobFocus((state) => state.focus);
	useEffect(() => {
		if (!focus || focus.sessionId !== sessionId || !value) return;
		// Spent once answered: a panel mounted later must not replay it.
		useJobFocus.setState({ focus: null });
		if (!value.jobs.some((job) => job.id === focus.jobId)) {
			useApp.getState().notify(t("services.outputGone"), "info");
			return;
		}
		setOpen((now) => new Set(now).add(focus.jobId));
		requestAnimationFrame(() => root.current?.querySelector(`[data-service-id="${focus.jobId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
	}, [focus, sessionId, value, t]);
	const stop = async (id: string, force: boolean) => {
		if (!sessionId) return;
		setBusy(id);
		try {
			if (!await bridge.services.stop(sessionId, id, force)) throw new Error(t("services.exited"));
			const value = await bridge.services.list(sessionId); cache.set(sessionId, value); setSnapshot({ id: sessionId, value });
		} catch (error) { useApp.getState().notify(String(error), "error"); }
		finally { setBusy(null); }
	};
	return <div ref={root} data-session-services>
		{jobs.length > 0 && <div className="flex items-center gap-1.5 px-1.5 pt-3 pb-1 text-caption text-ink-faint"><Server size={12} />{t("services.title")}<span className="ml-auto tabular-nums">{jobs.length}</span>{value?.discoveryError && <span data-ly-tip={t("services.portFailed", { reason: value.discoveryError })}><CircleAlert size={12} /></span>}</div>}
		{jobs.map((job) => {
			const ended = job.finishedAt !== undefined;
			const expanded = open.has(job.id);
			const outcome = !ended
				? job.status === "stopping" ? t("services.stopping") : job.pid
				: job.status === "failed" ? job.exitCode === null ? t("services.killed") : t("services.exitCode", { code: job.exitCode }) : t("services.done");
			return <div key={job.id} data-service-id={job.id} data-service-ended={ended ? "" : undefined} className="group/service rounded-lg px-1.5 py-1.5">
			<div className="flex items-center gap-1.5">
				{/* The whole label is the toggle, so the output opens from where the eye already is. */}
				<button type="button" aria-expanded={expanded} data-ly-tip={job.command} onClick={() => toggle(job.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
					<ChevronRight size={11} strokeWidth={2} className={`shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-quick)] ${expanded ? "rotate-90" : ""}`} aria-hidden />
					<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${job.status === "failed" ? "bg-danger" : ended ? "bg-ink-faint/60" : "bg-ok/70"}`} />
					<ScrollText text={job.description || job.command} className={`min-w-0 flex-1 text-detail ${ended ? "text-ink-faint" : "text-ink-muted"}`} />
				</button>
				<span className={`text-caption tabular-nums ${job.status === "failed" ? "text-danger" : "text-ink-faint"}`} data-service-outcome="" data-ly-tip={ended ? undefined : t("services.pid", { pid: job.pid ?? t("common.unknown") })}>{outcome}</span>
				{!ended && <div className="flex shrink-0 opacity-0 transition-opacity group-hover/service:opacity-100 group-focus-within/service:opacity-100">
					<IconButton size="sm" label={t("services.stop")} disabled={busy === job.id || job.status === "stopping"} icon={<Square size={12} />} onClick={() => void stop(job.id, false)} />
					<IconButton size="sm" label={t("services.kill")} disabled={busy === job.id} tone="danger" icon={<X size={13} />} onClick={() => confirm.ask({ title: t("services.killConfirm"), detail: job.command, confirmLabel: t("services.killLabel"), onConfirm: () => void stop(job.id, true) })} />
				</div>}
			</div>
			{job.endpoints.map((endpoint) => <div key={`${endpoint.pid}:${endpoint.address}:${endpoint.port}`} className="flex items-center gap-1.5 pl-3 text-caption text-ink-faint">
				<ScrollText text={`${endpoint.address}:${endpoint.port}`} className="min-w-0 flex-1 font-mono" />
				{endpoint.url && <><IconButton size="sm" label={t("services.openBuiltin")} icon={<Globe size={12} />} onClick={() => void commandBrowser({ type: "open", url: endpoint.url!, sessionId, newTab: true })} /><IconButton size="sm" label={t("services.openSystem")} icon={<ExternalLink size={12} />} onClick={() => void bridge.system.openExternal(endpoint.url!)} /></>}
				<IconButton size="sm" label={t("services.copyUrl")} icon={<Copy size={12} />} onClick={() => void bridge.clipboard.write(endpoint.url ?? `${endpoint.address}:${endpoint.port}`)} />
			</div>)}
			{job.error && <p className="pl-3 text-caption text-danger">{job.error}</p>}
			{expanded && sessionId && <JobOutput sessionId={sessionId} jobId={job.id} command={job.command} />}
		</div>;
		})}
		{confirm.element}
	</div>;
}
