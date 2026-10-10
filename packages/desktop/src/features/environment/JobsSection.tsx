/**
 * 这个会话还在跑的后台任务：一行一个，有端口就带上。
 *
 * 只列在跑的。结束了的输出要去任务面板看——那里留着它们，还能展开读日志；这张卡片回答的是
 * 「现在有什么挂着」。点一行就是去任务面板看它的输出，和对话里那行「后台命令结束」走的是同一条
 * 路（`focusJob`）。悬停出现停止。
 *
 * 卡片开着才问主进程，两秒一次，和任务面板的节奏一样；窗口藏起来时不问。
 */

import { useEffect, useState } from "react";
import { Square } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import { focusJob } from "../../store/job-focus.ts";
import { useDockScope } from "../../app/session-scope.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { openScopedPanel } from "../dock/index.ts";
import type { SessionServices } from "../../../shared/session-services.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

type Job = SessionServices["jobs"][number];

function useRunningJobs(sessionId: string): Job[] {
	const [jobs, setJobs] = useState<{ id: string; list: Job[] }>({ id: sessionId, list: [] });
	useEffect(() => {
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				if (!document.hidden) {
					const value = await bridge.services.list(sessionId);
					if (live) setJobs({ id: sessionId, list: value.jobs.filter((job) => job.finishedAt === undefined) });
				}
			} catch {
				// 问不到就照旧显示上一次的；任务面板会把错误说出来，这里不重复。
			} finally {
				if (live) timer = setTimeout(() => void refresh(), 2000);
			}
		};
		void refresh();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [sessionId]);
	return jobs.id === sessionId ? jobs.list : [];
}

export function JobsSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const scope = useDockScope();
	const jobs = useRunningJobs(sessionId);
	const [busy, setBusy] = useState<string | null>(null);
	if (!jobs.length) return null;

	const reveal = (job: Job) => {
		openScopedPanel("tasks", scope ?? undefined);
		focusJob(sessionId, job.id);
	};
	const stop = async (job: Job) => {
		setBusy(job.id);
		try {
			if (!(await bridge.services.stop(sessionId, job.id, false))) throw new Error(t("services.exited"));
		} catch (error) {
			useApp.getState().notify(String(error), "error");
		} finally {
			setBusy(null);
		}
	};

	return (
		<Section name="jobs">
			<SectionLabel>{t("services.title")}</SectionLabel>
			{jobs.map((job) => {
				const port = job.endpoints[0]?.port;
				return (
					<div key={job.id} data-ly-environment-job={job.id} className="group/job relative">
						<button type="button" className={ROW} data-ly-tip={job.command} onClick={() => reveal(job)}>
							<span className={`h-1.5 w-1.5 shrink-0 rounded-full ${job.status === "stopping" ? "bg-ink-faint" : "bg-ok/70"}`} aria-hidden />
							<span className="min-w-0 flex-1 truncate font-mono text-detail">{job.description || job.command}</span>
							{port !== undefined && <span className="shrink-0 text-caption tabular-nums text-ink-faint group-hover/job:opacity-0">:{port}</span>}
						</button>
						<div className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/job:opacity-100 group-focus-within/job:opacity-100">
							<IconButton
								size="sm"
								label={t("services.stop")}
								disabled={busy === job.id || job.status === "stopping"}
								icon={<Square size={11} />}
								onClick={() => void stop(job)}
							/>
						</div>
					</div>
				);
			})}
		</Section>
	);
}
