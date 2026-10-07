/**
 * 后台子智能体的结果送回来了——对话里的一行说明，不是一个人发的气泡。
 *
 * 人在主智能体等子智能体的时候插了话，主智能体先去回应人，子智能体留在后台接着跑；跑完之后，
 * 运行时把结果作为一条消息交回主智能体，主智能体接着干（`core/runtime/delegation-waits.ts`）。
 * 那条消息是写给模型的：报告原文套着标签。原样画出来，读的人会看见一大段自己没说过的话落在自己
 * 那一侧；什么都不画，主智能体又会像是自己突然动了起来。
 *
 * 所以画成一行：谁的结果回来了。报告本身在对应的派发卡片和子智能体面板里都有，这里只说「它回来
 * 了、主智能体接着处理」，点一下面板翻到它那一页。
 *
 * 后台命令结束走的是同一条送达，画成和工具行同一个骨架的一行：它是命令，不是哪个智能体。
 */

import type { DeliveredReport } from "@plume/core";
import { CircleAlert, Terminal } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { translate } from "../../i18n/translate.ts";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import { useSubAgents } from "../../store/subAgents.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { AvatarPile } from "../../ui/avatar/AvatarPile.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import type { DispatchState } from "../../lib/dispatches.ts";
import { FlowRow } from "./FlowRow.tsx";
import { focusJob } from "../../store/job-focus.ts";

/** 一份报告是什么表情：和派发卡片、输入框上方那条用同一套。 */
function moodOf(report: DeliveredReport): DispatchState {
	if (report.status === "failed") return "failed";
	if (report.status === "aborted" || report.incomplete) return "stopped";
	return "done";
}

function outcome(report: DeliveredReport): string {
	if (report.status === "failed") return translate("subAgentReturn.failed");
	if (report.incomplete) return translate("subAgentReturn.partial");
	return translate("subAgentReturn.done");
}

export function DeliveryRow({ delivery }: { delivery: DeliveredReport[] }) {
	const jobs = delivery.filter((report) => report.kind === "job");
	const agents = delivery.filter((report) => report.kind !== "job");
	return (
		<>
			{agents.length > 0 && <AgentDelivery delivery={agents} />}
			{jobs.length > 0 && <JobDelivery jobs={jobs} />}
		</>
	);
}

function JobDelivery({ jobs }: { jobs: DeliveredReport[] }) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	// The output lives in the task panel's list of background tasks; this line is the way there.
	// The composer opens the panel (`useJobReveal`); the panel opens the job.
	const show = () => {
		if (sessionId) focusJob(sessionId, jobs.find((job) => job.status === "failed")?.id ?? jobs[0].id);
	};
	const failed = jobs.filter((job) => job.status === "failed").length;
	const one = jobs.length === 1 ? jobs[0] : null;
	/*
	 * 标题先说结果，摘要说是哪件事，完整命令只在悬停时出现。
	 *
	 * 第一版是「后台命令已结束 · sleep 2; echo …; exit 1」：成败只能从一个灰色小图标去猜，而那串
	 * shell 不是写给人读的——看的人说「看不懂」。
	 */
	const title = one ? t(one.status === "failed" ? "jobReturn.failed" : "jobReturn.done") : t("jobReturn.many", { n: jobs.length });
	const trailing = one
		? one.status === "failed"
			? one.exitCode == null ? t("jobReturn.killed") : t("jobReturn.exitCode", { code: one.exitCode })
			: undefined
		: failed > 0 ? t("jobReturn.failedCount", { n: failed }) : undefined;
	return (
		<div data-delivery-row="" data-delivery-kind="job">
			<FlowRow
				/* 只染图标：标题和摘要有自己的墨色，整行标红盖不过它们，也会让一行说明喊得比回答还响。 */
				icon={failed > 0 ? <CircleAlert size={13} strokeWidth={1.8} className="text-danger" /> : <Terminal size={13} strokeWidth={1.8} />}
				title={title}
				summary={jobs.map((job) => job.description).join(" · ")}
				trailing={trailing}
				onToggle={show}
				data-ly-tip={jobs.map((job) => job.command ?? job.description).join("\n")}
			/>
		</div>
	);
}

function AgentDelivery({ delivery }: { delivery: DeliveredReport[] }) {
	const { t } = useI18n();
	const avatarOf = useAgentAvatars();
	const sessionId = useScopedSessionId();
	if (delivery.length === 0) return null;
	const one = delivery.length === 1 ? delivery[0] : null;
	const failed = delivery.filter((report) => report.status === "failed").length;
	const text = one ? t("subAgentReturn.one", { name: one.description || one.agent }) : t("subAgentReturn.many", { n: delivery.length });
	const tip = delivery.map((report) => t("subAgentReturn.tipLine", { name: report.description || report.agent, agent: report.agent, outcome: outcome(report) })).join("\n");
	return (
		<div className="my-2 flex" data-delivery-row="">
			<Button
				variant="subtle"
				size="sm"
				label={tip}
				onClick={() => useSubAgents.getState().reveal(delivery[0].id, sessionId)}
				className="min-w-0 max-w-full"
				data-ly-avatar-host=""
			>
				{one ? (
					<AgentAvatar avatar={avatarOf(one.agent)} size={18} mood={moodOf(one)} seed={one.agent} host="[data-ly-avatar-host]" />
				) : (
					<AvatarPile faces={delivery.map((report) => ({ key: report.id, avatar: avatarOf(report.agent), mood: moodOf(report), seed: report.agent }))} size={20} max={4} />
				)}
				<span className="min-w-0 truncate">{text}</span>
				{failed > 0 && <span className="shrink-0 text-danger">· {t("subAgentReturn.failedCount", { n: failed })}</span>}
			</Button>
		</div>
	);
}
