/**
 * 这个会话派出去的子 Agent：一行一个，在跑的排前面，写着它领的任务和跑了多久。
 *
 * 和输入框上方那条栏不是一回事：那条只说「此刻还有什么没交回来」，交回来就收起；这里是这个会话
 * 派过谁的名单，结束的也留着，点一行和那条栏的单子一样——面板翻到它那一页。名单长了只放前几个，
 * 剩下的去面板里看。
 */

import { useEffect, useState } from "react";
import type { SubAgentSummary } from "@plume/core";
import { useI18n } from "../../i18n/index.ts";
import { rosterOrder, useSubAgents } from "../../store/subAgents.ts";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import { stateOf } from "../../lib/dispatches.ts";
import { useDockScope, useScopedSubAgents } from "../../app/session-scope.tsx";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { openScopedPanel } from "../dock/index.ts";
import { elapsedSince, ranFor, statusWord } from "../subagents/index.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

const SHOWN = 5;

function stateLine(one: SubAgentSummary): string {
	if (one.status === "running") return elapsedSince(one.startedAt);
	if (one.status === "queued") return statusWord(one.status);
	return `${statusWord(one.status)} · ${ranFor(one)}`;
}

export function SubAgentsSection() {
	const { t } = useI18n();
	const scope = useDockScope();
	const roster = useScopedSubAgents();
	const avatarOf = useAgentAvatars();
	const running = roster.some((one) => one.status === "running");
	// 在跑的那几行写着秒表，一秒走一格；都停了就不必再画。
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
		return () => window.clearInterval(timer);
	}, [running]);
	if (!roster.length) return null;

	const ordered = rosterOrder(roster);
	const shown = ordered.length <= SHOWN ? ordered : ordered.slice(0, SHOWN - 1);
	const open = (id?: string) => {
		if (id) useSubAgents.getState().focus(id);
		openScopedPanel("subagents", scope ?? undefined);
	};

	return (
		<Section name="subAgents">
			<SectionLabel>{t("subAgent.title")}</SectionLabel>
			{shown.map((one) => (
				<button
					key={one.id}
					type="button"
					data-ly-environment-sub-agent={one.id}
					data-ly-avatar-host=""
					data-ly-tip={`@${one.agent} · ${one.description}`}
					className={ROW}
					onClick={() => open(one.id)}
				>
					<AgentAvatar avatar={avatarOf(one.agent)} size={16} mood={stateOf(one)} seed={one.agent} host="[data-ly-avatar-host]" />
					<span className={`min-w-0 flex-1 truncate ${one.status === "queued" ? "text-ink-muted" : ""}`}>{one.description}</span>
					<span className={`shrink-0 text-caption tabular-nums ${one.status === "failed" ? "text-danger" : "text-ink-faint"}`}>{stateLine(one)}</span>
				</button>
			))}
			{shown.length < ordered.length && (
				<button type="button" className={`${ROW} text-ink-faint`} onClick={() => open()}>
					<span className="w-4 shrink-0" />
					{t("environment.moreSubAgents", { n: ordered.length - shown.length })}
				</button>
			)}
		</Section>
	);
}
