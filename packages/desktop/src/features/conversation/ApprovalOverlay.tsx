import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/messages/index.ts";
import { translate } from "../../i18n/translate.ts";
import { MessageCircle, TriangleAlert } from "../../ui/icons/index.ts";
import { Collapse } from "../../ui/layout/Collapse.tsx";
import { Caret } from "../../ui/primitives/Caret.tsx";
import { Scroller } from "../../ui/scroll/Scroller.tsx";
import { useLayout } from "../../app/layout.tsx";
import { useApp } from "../../store/index.ts";
import { useDockScope, useScopedApprovals, useScopedSessionId } from "../../app/session-scope.tsx";
import { openPlanInScreen } from "../../app/plan-opener.ts";
import { usePlanReview } from "../../store/plan-review.ts";
import { useAgentAvatars } from "../../store/agent-avatars.ts";
import { AgentAvatar } from "../../ui/avatar/AgentAvatar.tsx";
import { QuestionChoices } from "./QuestionChoices.tsx";
import { PermissionChoices } from "./PermissionChoices.tsx";
import { FormChoices } from "./FormChoices.tsx";
import { approvalReason, riskSentence } from "./approval-content.ts";
import { PlanApproval } from "./PlanApproval.tsx";

/** What is being asked for, by kind. Keys — this table is built at import time. */
const KIND_LABEL: Record<string, MessageKey> = {
	bash: "approval.bash",
	write: "approval.write",
	edit: "approval.edit",
	read: "approval.read",
	mcp: "approval.mcp",
	network: "approval.network",
};

/**
 * How long this question has left, ticking.
 *
 * A pending decision has always had a deadline — the gate resolves it into a refusal when nobody
 * answers — and the card never said so. A question that expires without warning is worse than one
 * that waits forever: the run ends having been told "no" by someone who never saw it asked.
 *
 * Its own component so the second hand does not re-render `QuestionChoices` underneath it, which
 * is where an answer is being typed.
 */
function Expiry({ at }: { at: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const left = at - now;
	/*
	 * 走到零就不说了。
	 *
	 * 正常情况下这一刻卡片自己也没了——gate 同时把它收掉。留这一行是为了另一种：一轮崩在半路，
	 * 没有 `agent_end` 收尾，转录重放出来的那张卡片带着一个早就过去的截止时刻。「0:00 后失效」
	 * 是这次修复最不该自己再造一遍的那种句子。
	 */
	if (left <= 0) return null;
	const minutes = Math.floor(left / 60_000);
	const seconds = Math.floor((left % 60_000) / 1000);
	return <span className="shrink-0 tabular-nums text-caption text-ink-faint">{translate("question.expiresIn", { time: `${minutes}:${String(seconds).padStart(2, "0")}` })}</span>;
}

/**
 * Keep the transcript readable while a decision blocks only the composer.
 *
 * 计划模式交上来的计划（core 的 `submit_plan`）是另一张卡，见 `PlanApproval`。`renderPlan` 画它的正文，由
 * `Conversation` 交进来而不是这里 import `Markdown`，理由见 `rows.tsx` 的 `planMarkdown`。
 */
export function ApprovalOverlay({ renderPlan }: { renderPlan: (text: string) => ReactNode }) {
	const sessionId = useScopedSessionId();
	const approvals = useScopedApprovals();
	const respond = useApp(s => s.respondToApproval);
	const avatarOf = useAgentAvatars();
	const { compact } = useLayout();
	/*
	 * Subscribed, not only read through `translate`: the card sits under the memoised
	 * `Conversation`, and a context is what reaches through that when the language changes.
	 */
	const { t } = useI18n();
	const [collapsedId, setCollapsedId] = useState<string | null>(null);
	const screen = useDockScope();
	const request = approvals[0];
	const planId = request?.kind === "interactive" && request.subject === "submit_plan" ? request.id : null;
	/*
	 * 计划交上来时，右栏替人打开计划面板：读和划线评论都在那里，卡片只管回答。每份计划只开一次，人关掉
	 * 以后不追着开。窄窗口不开：那时右栏一次只摆一格，开了就把这张等人回答的卡片整个盖住——计划画在卡里。
	 */
	const planText = planId ? request.detail : null;
	useEffect(() => {
		if (!sessionId || !planId || planText === null) return;
		if (usePlanReview.getState().show(sessionId, planId, planText) && !compact) openPlanInScreen(screen ?? undefined);
	}, [sessionId, planId, planText, compact, screen]);
	if (!request) return null;
	const gutter = `flex shrink-0 justify-center pb-2 ${compact ? "ly-content-gutter-compact" : "ly-content-gutter"}`;
	const expiry = request.expiresAt !== undefined && <Expiry at={request.expiresAt} />;
	if (planId) return <div data-approval-region className={gutter}>
		<PlanApproval key={planId} request={request} sessionId={sessionId} compact={compact} renderPlan={renderPlan} openPlan={() => openPlanInScreen(screen ?? undefined)} tags={expiry} />
	</div>;
	const collapsed = collapsedId === request.id;
	const interactive = request.kind === "interactive";
	// MCP 服务器要人填表：和提问一样是要人给答案，不是要许可。
	const form = request.kind === "form" && request.fields ? request.fields : null;
	const asking = interactive || form !== null;
	const Icon = asking ? MessageCircle : TriangleAlert;
	const reason = approvalReason(request.reason, request.detail);
	// On top of the command, where the gate used to write it into the text in one language.
	const risk = riskSentence(request.risk, t);
	const context = <>
		{reason && <p className="mb-2.5 whitespace-pre-wrap break-words text-label leading-relaxed text-ink">{reason}</p>}
		<pre className={`whitespace-pre-wrap break-words ${asking ? "font-sans text-label leading-relaxed text-ink" : "font-mono text-code text-ink-muted"}`}>{risk ? `${risk}\n\n${request.detail}`.trim() : request.detail}</pre>
	</>;
	const tags = <>
		{!asking && <span className="shrink-0 text-caption text-ink-faint">{KIND_LABEL[request.kind] ? translate(KIND_LABEL[request.kind]) : request.kind}</span>}
		{expiry}
		{approvals.length > 1 && <span className="shrink-0 text-caption text-ink-faint">+{approvals.length - 1}</span>}
	</>;
	return <div data-approval-region className={gutter}>
		<div data-approval-card className="ly-glass flex max-h-[min(560px,calc(100dvh-14rem))] w-full max-w-[var(--ly-content)] flex-col overflow-hidden rounded-xl border border-line">
			{/* 标题栏整条是收放的按钮，不只是右端那颗箭头：点在标题上也能收起，键盘也落得到。里面没有别的可点的东西。 */}
			<button
				type="button"
				aria-expanded={!collapsed}
				onClick={() => setCollapsedId(collapsed ? null : request.id)}
				className="group/head flex w-full shrink-0 cursor-pointer items-center gap-2 px-4 py-2.5 text-left"
				data-ly-avatar-host=""
				data-approval-head=""
			>
				{/*
				 * 子智能体在问的，脸替掉那枚警告图标，标题下面一行小字说是谁。
				 *
				 * 子智能体的授权一直是送到这张卡上的，只是卡片说不出是谁在要：同一句「写入 src/a.ts」可能
				 * 来自主智能体，也可能来自后台四个子智能体里的任何一个，而人要据此决定的恰恰是「这个活
				 * 该不该由它来干」。
				 */}
				{request.from ? (
					<AgentAvatar avatar={avatarOf(request.from.agent)} size={18} seed={request.from.agent} host="[data-ly-avatar-host]" />
				) : (
					<Icon size={15} strokeWidth={1.8} className="shrink-0 text-accent" />
				)}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="break-words text-label font-medium text-ink" data-approval-title="">{interactive ? translate("question.title") : form ? translate("form.title", { server: request.title }) : request.title}</span>
					{request.from && (
						<span className="truncate text-caption text-ink-faint" data-approval-from="">
							{translate("approval.fromSubAgent", { name: request.from.description, agent: request.from.agent })}
						</span>
					)}
				</span>
				{tags}
				<span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center text-ink-faint transition-colors duration-[var(--ly-t-quick)] group-hover/head:text-ink"><Caret open={!collapsed} size={15} /></span>
			</button>
			<Collapse open={!collapsed} keepMounted className="min-h-0" bodyClassName="flex min-h-0 flex-col overflow-hidden">{form ? <>
				<p className="shrink-0 px-4 pb-1 text-caption text-ink-muted">{translate("form.note", { server: request.title })}</p>
				<FormChoices key={request.id} fields={form} answer={decision => respond(request.id, decision, sessionId ?? undefined)}>{context}</FormChoices>
			</> : interactive ? <>
				<p className="shrink-0 px-4 pb-1 text-caption text-ink-muted">{translate("question.fullAccessNote")}</p>
				<QuestionChoices key={request.id} options={request.options ?? []} allowCustomInput={request.allowCustomInput !== false} selectionMode={request.selectionMode} allowSkip={request.allowSkip !== false} defaultOptionIndex={request.defaultOptionIndex} answer={decision => respond(request.id, decision, sessionId ?? undefined)}>{context}</QuestionChoices>
			</> : <>
				<Scroller className="ly-approval-scroll mx-2 max-h-[min(280px,30dvh)]" contentClassName="px-2 py-2">{context}</Scroller>
				<PermissionChoices key={request.id} subject={request.subject} onceOnly={request.escalation !== undefined} answer={decision => respond(request.id, decision, sessionId ?? undefined)} />
			</>}</Collapse>
		</div>
	</div>;
}
