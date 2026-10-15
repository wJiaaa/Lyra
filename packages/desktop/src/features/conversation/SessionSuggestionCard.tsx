/**
 * 一次 `spawn_session` 在对话里画成的那张卡片：建议另开一个会话，在这里决定开不开。
 *
 * 站在调用的位置、自成一行，不和前后的工具并成一段（`grouping.ts` 的 `shows`）：一张等人点「开始」的
 * 卡片折进过程就没人点了。参数还在写时只是一行过程行（标题写到哪画到哪、扫光），写完整张卡片一次出现。
 * 写的时候就画卡片框是试过的：先冒出图标、空标题和一颗按不动的「开始」，说明再一行行把框撑高，像坏了。
 *
 * 开始以后缩成一行，和其他过程行同一个骨架（`FlowRow`）：行首是新会话的图标，在跑时摘要上扫光，点了
 * 过去。行首不放侧栏那枚状态点、行尾不写「进行中」「已完成」——扫光已经说了在跑，同一件事说两遍是吵；
 * 看过之后状态清掉，剩下的那句「已开始」更是什么都没说。只有没跑完要说，它改变人接下来做什么。
 * 第一轮还在跑时，行尾挂着「交回这里」，开始以后也能改主意；第一轮一结束它就走了，那时改什么都不算。
 * 跑完要交回的，交回那一刻在主会话里另有一行（`DeliveryRow`）。
 *
 * ADR-0049 曾把卡片挪进环境卡片，理由是它会被后面的输出顶到几屏之上。那件事现在由侧栏兜着——开出来
 * 的会话挂在这个对话下面——环境卡片里那一节也还在，做第二个入口；两处读同一份状态，开始、收起一起变。
 */

import { useState, type ReactNode } from "react";
import type { AssistantContent, AssistantMessage, Message } from "@plume/core";
import { SPAWN_SESSION_TOOL, type SessionSuggestionDetails } from "../../../shared/session-suggestion.ts";
import { focusScreenOf, useScopedFromMessages, useScopedSessionId, useScopedWorkspace } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { bridge } from "../../services/index.ts";
import { useApp, type ToolRun } from "../../store/index.ts";
import { dismissSuggestion, startedFrom, useDismissedSuggestions, type SessionSuggestion } from "../../store/session-suggestions.ts";
import { ChevronRight, Reply, SquarePen, X } from "../../ui/icons/index.ts";
import { WorktreeToggle } from "../../ui/inputs/WorktreeToggle.tsx";
import { Button } from "../../ui/primitives/Button.tsx";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { FlowRow } from "./FlowRow.tsx";
import { toolCardFallback } from "./tool-status.ts";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

/** 由这条建议开出来的会话的 id；建议被开始时重画，侧栏每变一次不重画。 */
function useStartedId(sessionId: string | null, callId: string): string | null {
	return useApp((s) => (sessionId ? (startedFrom(s.sessions, sessionId, callId)?.id ?? null) : null));
}

/**
 * 「开始」那一排：按钮、工作树开关、交回开关。对话里的卡片和环境卡片那一节共用一份，两处问的是同一个问题。
 *
 * 两个开关各自从一个默认起步：工作树跟输入框同一个设置，交回跟模型提建议时说的（`reportBack`）。
 */
export function SuggestionStart({ sessionId, suggestion, disabled }: { sessionId: string; suggestion: SessionSuggestion; disabled?: boolean }) {
	const { t } = useI18n();
	const { callId, details } = suggestion;
	const { workspace } = useScopedWorkspace();
	const worktreeByDefault = useApp((s) => Boolean(s.settings?.worktrees?.autoCreateOnNewSession));
	const [worktreePick, setWorktreePick] = useState<boolean | null>(null);
	const [reportBack, setReportBack] = useState(details.reportBack === true);
	const [starting, setStarting] = useState(false);
	const inWorktree = worktreePick ?? worktreeByDefault;
	const offersWorktree = Boolean(workspace?.isGitRepo);

	const start = async () => {
		if (starting) return;
		setStarting(true);
		try {
			// 新会话叫建议的标题，不叫那段写给模型的提示词的前六十个字。
			await useApp.getState().startSession(details.prompt, { sessionId, toolCallId: callId, ...(reportBack ? { reportBack: true } : {}) }, { title: details.title, ...(offersWorktree ? { worktree: inWorktree } : {}) });
		} finally {
			setStarting(false);
		}
	};

	return (
		<div className="flex items-center gap-1.5">
			<Button size="sm" variant="primary" loading={starting} disabled={disabled} label={t("sessionOps.startTip")} onClick={() => void start()} data-ly-suggestion-action="start">
				{t("sessionOps.start")}
			</Button>
			{offersWorktree && <WorktreeToggle size="sm" on={inWorktree} onChange={setWorktreePick} />}
			<ReportBackToggle on={reportBack} disabled={disabled} onChange={setReportBack} />
		</div>
	);
}

/** 「交回这里」：和工作树开关同一个样子，只有图标是「不」，图标加名字、染强调色是「要」。 */
function ReportBackToggle({ on, disabled, compact, onChange }: { on: boolean; disabled?: boolean; compact?: boolean; onChange: (on: boolean) => void }) {
	const { t } = useI18n();
	const tip = on ? t("sessionOps.reportBackOn") : t("sessionOps.reportBackOff");
	return (
		<button
			type="button"
			data-ly-suggestion-report={on ? "on" : "off"}
			aria-pressed={on}
			aria-label={tip}
			data-ly-tip={tip}
			data-ly-tip-side="top"
			disabled={disabled}
			onClick={() => onChange(!on)}
			// 挂在 24px 的过程行后面时矮一档，不把那一行撑高。
			className={`flex shrink-0 items-center gap-1 rounded-lg px-[6px] text-label transition-colors duration-[var(--ly-t-quick)] disabled:opacity-45 ${compact ? "h-[22px] min-w-[22px]" : "h-[26px] min-w-[26px]"} ${
				on ? "bg-accent/10 text-accent hover:bg-accent/15" : "text-ink-faint hover:bg-card-hover hover:text-ink active:bg-elevated"
			}`}
		>
			<Reply size={compact ? 14 : 16} strokeWidth={1.8} className="shrink-0" aria-hidden />
			{on && <span className="whitespace-nowrap pr-0.5">{t("sessionOps.reportBack")}</span>}
		</button>
	);
}

/** 对话里那一张。没有可画的（参数被退回、这一轮在写完之前停了）就交回普通的工具行。 */
export function SessionSuggestionCard({ block, run, stopReason, turnRunning, fallback }: {
	block: ToolCall;
	run?: ToolRun;
	stopReason: AssistantMessage["stopReason"];
	turnRunning: boolean;
	fallback: ReactNode;
}) {
	const sessionId = useScopedSessionId();
	const details = run?.status === "done" ? (run.result?.details as SessionSuggestionDetails | undefined) : undefined;
	if (details?.kind === "session_suggestion" && sessionId) return <Suggested sessionId={sessionId} suggestion={{ callId: block.id, details }} />;
	if (block.name !== SPAWN_SESSION_TOOL || (run?.status ?? toolCardFallback(stopReason, turnRunning)) !== "running") return fallback;
	return <Writing block={block} />;
}

/**
 * 这次调用此刻在转录里的样子。从转录里读、不用传进来的那一份：这一行只在转录的形状变了时重画
 * （`sameRun`），参数每多写一段并不重画，传进来的那一份停在它刚出现时写到的地方（同 `PreviewCall`）。
 * 只看最后几条：正在写的调用在正在写的那条回复里。
 */
function liveCall(messages: Message[], id: string): ToolCall | null {
	for (let at = messages.length - 1; at >= Math.max(0, messages.length - 4); at--) {
		const message = messages[at]!;
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall" && block.id === id) return block;
	}
	return null;
}

/**
 * 写到一半的标题。写着的时候 `arguments` 还是空的，只有 `argumentsText` 在长（见 `preview-pages.ts`），
 * 所以读原文：前面不是 `\` 的 `"title"` 只可能是键。末尾写了一半的转义先去掉，不然整句解析不了。
 */
function writtenTitle(block: ToolCall): string {
	if (typeof block.arguments?.title === "string") return block.arguments.title;
	const found = /(?<!\\)"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(block.argumentsText ?? "");
	if (!found) return "";
	const raw = found[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
	try {
		return JSON.parse(`"${raw}"`) as string;
	} catch {
		return raw;
	}
}

/** 还在写：和别的过程行一样一行，参数边写边解析，标题有多少画多少。 */
function Writing({ block }: { block: ToolCall }) {
	const { t } = useI18n();
	// 选出来的是字符串：标题变了才重画，说明、提示词往下写时不动。
	const title = useScopedFromMessages((messages) => writtenTitle(liveCall(messages, block.id) ?? block));
	return (
		<div data-ly-session-suggestion="writing" data-ly-suggestion-call={block.id}>
			<FlowRow icon={<SquarePen size={13} strokeWidth={1.8} />} title={<span className="font-normal">{t("sessionOps.suggesting")}</span>} summary={title ? <span data-ly-suggestion-title>{title}</span> : undefined} running />
		</div>
	);
}

function Frame({ title, summary, callId, actions, aside }: { title: string; summary: string; callId: string; actions?: ReactNode; aside?: ReactNode }) {
	return (
		<section data-ly-session-suggestion="suggested" data-ly-suggestion-call={callId} aria-label={title} className="flex w-full max-w-[420px] items-start gap-2.5 rounded-xl border border-line bg-card/30 py-2.5 pr-1.5 pl-3 text-label">
			<SquarePen size={15} strokeWidth={1.7} aria-hidden className="mt-[2px] shrink-0 text-ink-muted" />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-ink" data-ly-suggestion-title>
					{title}
				</p>
				{summary && (
					<p className="mt-0.5 line-clamp-3 text-caption text-ink-muted" data-ly-suggestion-summary>
						{summary}
					</p>
				)}
				<div className="mt-2">{actions}</div>
			</div>
			{aside}
		</section>
	);
}

function Suggested({ sessionId, suggestion }: { sessionId: string; suggestion: SessionSuggestion }) {
	const { t } = useI18n();
	const { callId, details } = suggestion;
	const startedId = useStartedId(sessionId, callId);
	const dismissed = useDismissedSuggestions((s) => s.ids.includes(callId));
	if (startedId) return <Started sessionId={sessionId} callId={callId} title={details.title} startedId={startedId} />;
	// 收起只是一句记录：建议还在日志里，这里不再催人。
	if (dismissed)
		return (
			<div data-ly-session-suggestion="dismissed" data-ly-suggestion-call={callId}>
				<FlowRow icon={<SquarePen size={13} strokeWidth={1.8} />} title={<span className="font-normal">{t("sessionOps.noted")}</span>} summary={details.title} trailing={t("sessionOps.dismissed")} />
			</div>
		);
	return (
		<Frame
			title={details.title}
			summary={details.summary}
			callId={callId}
			actions={<SuggestionStart sessionId={sessionId} suggestion={suggestion} />}
			aside={<IconButton size="xs" label={t("sessionOps.dismiss")} icon={<X size={12} strokeWidth={1.9} />} onClick={() => dismissSuggestion(callId)} data-ly-suggestion-dismiss />}
		/>
	);
}

function Started({ sessionId, callId, title, startedId }: { sessionId: string; callId: string; title: string; startedId: string }) {
	const { t } = useI18n();
	const activity = useApp((s) => s.activity[startedId] ?? null);
	const from = useApp((s) => s.sessions.find((one) => one.id === startedId)?.spawnedFrom);
	const running = activity === "running" || activity === "waiting";
	const failed = activity === "failed";
	const open = () => {
		// 分屏时这一张可能在没聚焦的那一边：在它所在的那一屏打开。
		if (sessionId !== useApp.getState().activeSessionId) focusScreenOf(sessionId);
		void useApp.getState().openSessionById(startedId);
	};
	return (
		<div data-ly-session-suggestion="started" data-ly-suggestion-call={callId} className="flex min-w-0 items-center gap-1">
			<FlowRow
				icon={<SquarePen size={13} strokeWidth={1.8} />}
				title={<span className="font-normal">{t("sessionOps.newSession")}</span>}
				summary={<span data-ly-suggestion-title>{title}</span>}
				running={running}
				trailing={
					<>
						{failed && (
							<span className="text-danger" data-ly-suggestion-status>
								{t("sessionOps.failed")}
							</span>
						)}
						{/* 点了是去那个会话，不是就地展开：箭头自己画，和交回那一行一样。 */}
						<ChevronRight size={12} strokeWidth={2} aria-hidden />
					</>
				}
				onToggle={open}
				label={failed ? `${title} · ${t("sessionOps.failed")}` : title}
				data-ly-suggestion-action="open"
			/>
			{running && from && !from.settled && <LateReportBack startedId={startedId} on={from.reportBack === true} />}
		</div>
	);
}

/**
 * 开始以后的「交回这里」。点下去先照点的样子画，主进程答应了以 meta 为准；答「晚了」（第一轮恰好在这一下
 * 结束）就退回去，那时这个开关也跟着第一轮一起消失。
 */
function LateReportBack({ startedId, on }: { startedId: string; on: boolean }) {
	const [asked, setAsked] = useState<boolean | null>(null);
	const change = (next: boolean) => {
		setAsked(next);
		void bridge.sessions
			.reportBack(startedId, next)
			.catch(() => false)
			.finally(() => setAsked(null));
	};
	return <ReportBackToggle compact on={asked ?? on} onChange={change} />;
}
