/**
 * 子智能体的结果送回来了——对话里的一行说明，不是一个人发的气泡。
 *
 * 主智能体派出子智能体就不再等它，子智能体在后台跑；跑完之后，运行时把结果作为一条消息交回
 * 主智能体，主智能体接着干（`core/runtime/sub-agent/delegation-waits.ts`）。
 * 那条消息是写给模型的：报告原文套着标签。原样画出来，读的人会看见一大段自己没说过的话落在自己
 * 那一侧；什么都不画，主智能体又会像是自己突然动了起来。
 *
 * 所以画成一行：消息来自谁。报告本身在对应的派发卡片和子智能体面板里都有，这里只说「它回来
 * 了、主智能体接着处理」，点一下面板翻到它那一页。
 *
 * 后台命令结束走的是同一条送达，画成和工具行同一个骨架的一行：它是命令，不是哪个智能体。
 * 从建议卡片上开出来、要求交回的会话也一样：画成「来自新会话 · 标题」，点了去那个会话。
 */

import type { DeliveredReport } from "@plume/core";
import { ChevronRight, CircleAlert, SquarePen, Terminal } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { translate } from "../../i18n/translate.ts";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import { useSubAgents } from "../../store/subAgents.ts";
import { useScopedSessionId } from "../../app/session-scope.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { AvatarPile } from "../../ui/avatar/AvatarPile.tsx";
import type { DispatchState } from "../../lib/dispatches.ts";
import { FlowRow } from "./FlowRow.tsx";
import { focusJob } from "../../store/job-focus.ts";
import { jumpToSession } from "./jump-to-session.ts";

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

export function DeliveryRow({ delivery, steered }: { delivery: DeliveredReport[]; steered?: boolean }) {
	const jobs = delivery.filter((report) => report.kind === "job");
	const sessions = delivery.filter((report) => report.kind === "session");
	const agents = delivery.filter((report) => report.kind === undefined);
	return (
		<>
			{agents.length > 0 && <AgentDelivery delivery={agents} steered={steered} />}
			{jobs.length > 0 && <JobDelivery jobs={jobs} />}
			{sessions.map((report) => (
				<SessionDelivery key={report.id} report={report} />
			))}
		</>
	);
}

/**
 * 建议另开的会话交回了第一轮的回复。和子智能体交回同一个题注骨架；回复本身在那个会话里，点了过去。
 * 那个会话被删了就只是一句题注，点不动。
 */
function SessionDelivery({ report }: { report: DeliveredReport }) {
	const { t } = useI18n();
	const sessionId = useScopedSessionId();
	const failed = report.status === "failed";
	return (
		<div className="-mb-1.5" data-delivery-row="" data-delivery-kind="session">
			<FlowRow
				icon={failed ? <CircleAlert size={13} strokeWidth={1.8} className="text-danger" /> : <SquarePen size={13} strokeWidth={1.8} />}
				title={<span className="font-normal">{t("sessionReturn.from")}</span>}
				summary={report.description}
				trailing={
					<>
						{failed && <span className="text-danger">{t("sessionOps.failed")}</span>}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => void jumpToSession(sessionId, report.id)}
				label={report.description}
			/>
		</div>
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

/**
 * 子智能体的结果到了：主智能体接下来那段话的题注——「消息来自 @谁」。
 *
 * 派出即放手以后（`core/runtime/sub-agent/delegation-waits.ts`），每回来一个，主智能体就就着它说
 * 一段。这一行说的是「下面这段话是因为谁回来了」，所以和来信、后台命令同一个骨架，不是一颗按钮：
 * 从前它是一颗带底色的胶囊，一轮里回来三个就是三颗，比主智能体自己的话还显眼。
 */
function AgentDelivery({ delivery, steered }: { delivery: DeliveredReport[]; steered?: boolean }) {
	const { t } = useI18n();
	const avatarOf = useAgentAvatars();
	const sessionId = useScopedSessionId();
	if (delivery.length === 0) return null;
	const one = delivery.length === 1 ? delivery[0] : null;
	const failed = delivery.filter((report) => report.status === "failed").length;
	const tip = delivery.map((report) => t("subAgentReturn.tipLine", { name: report.description || report.agent, agent: report.agent, outcome: outcome(report) })).join("\n");
	return (
		/*
		 * 题注贴着它引出的那段话：转录里行与行之间是 10px（`data-ly-transcript-rows` 的 `gap-2.5`），
		 * 往下收 6px，字到字剩 4px。
		 *
		 * 上面那段空白要自己出，除非前面是上一轮的结尾。叫醒会话的送达开新一轮，上一轮收尾那句话底下
		 * 有一排悬停才显示的操作（24px，`-mt-1.5`），看不见但占着位置，字到题注 38px；再加就叠成两段空。
		 * 一轮中间到达的（`steered`）收在过程里，上面是工具行、没有那排操作，只剩 10px，和工具行挤成
		 * 一串——这里补 28px 凑齐同一个 38px。
		 */
		<div className={steered ? "mt-7 -mb-1.5" : "-mb-1.5"} data-delivery-row="" data-delivery-kind="agent" data-ly-avatar-host="">
			<FlowRow
				icon={one ? (
					<AgentAvatar avatar={avatarOf(one.agent)} size={14} mood={moodOf(one)} seed={one.agent} host="[data-ly-avatar-host]" />
				) : (
					<AvatarPile faces={delivery.map((report) => ({ key: report.id, avatar: avatarOf(report.agent), mood: moodOf(report), seed: report.agent }))} size={14} max={4} />
				)}
				/* 装的是名字，和来信那一行一样不加粗——见 `PeerLetterRow`。 */
				title={<span className="font-normal">{one ? t("subAgentReturn.fromOne", { agent: one.agent }) : t("subAgentReturn.fromMany", { n: delivery.length })}</span>}
				summary={one ? one.description : delivery.map((report) => `@${report.agent}`).join(" · ")}
				trailing={
					<>
						{failed > 0 && <span className="text-danger">{one ? t("subAgentReturn.failed") : t("subAgentReturn.failedCount", { n: failed })}</span>}
						{/* 点开是去面板，不是就地展开：箭头自己画，`FlowRow` 那枚只给能展开的行。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={() => useSubAgents.getState().reveal(delivery[0].id, sessionId)}
				label={tip}
				data-ly-tip={tip}
			/>
		</div>
	);
}
