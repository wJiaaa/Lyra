/**
 * 一次 `spawn_session` 在对话里留下的那一行：这里建议过另开一个会话，现在怎样了。
 *
 * 只是记录，不是操作的地方。建议不拦着这一轮，模型提完接着干活，这一行很快就滚到几屏之上；开始、
 * 收起都在右上角环境卡片的「建议的新会话」那一节（`environment/SuggestionsSection.tsx`），那里不随
 * 对话滚动。这一行留着上下文：往回翻时看得到是在做哪件事时提的、后来开没开。见 ADR-0049。
 *
 * 画在这一轮的过程块外面，和浏览器、生图卡片一样（`Conversation.tsx`）：折进过程块的就没人看见了。
 */

import type { ToolCallContent } from "@plume/core";
import type { SessionSuggestionDetails } from "../../../shared/session-suggestion.ts";
import { focusScreenOf, useScopedFromToolRuns, useScopedSessionId } from "../../app/session-scope.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";
import { revealEnvironmentSection } from "../../store/environment-card.ts";
import { startedFrom, suggestionStatus, useDismissedSuggestions } from "../../store/session-suggestions.ts";
import { ChevronRight, SquarePen } from "../../ui/icons/index.ts";

export function SessionSuggestionNotes({ calls }: { calls: ToolCallContent[] }) {
	return (
		<div className="flex flex-col items-start gap-0.5" data-ly-session-suggestions>
			{calls.map((call) => (
				<SessionSuggestionNote key={call.id} call={call} />
			))}
		</div>
	);
}

function SessionSuggestionNote({ call }: { call: ToolCallContent }) {
	const { t } = useI18n();
	// 这一屏的对话：分屏时这一行可能在没聚焦的那一边。
	const sessionId = useScopedSessionId();
	const run = useScopedFromToolRuns((runs) => runs[call.id]);
	// 取 id 不取 meta：建议被开始时重画，侧栏每变一次不重画。
	const startedId = useApp((s) => (sessionId ? (startedFrom(s.sessions, sessionId, call.id)?.id ?? null) : null));
	const activity = useApp((s) => (startedId ? (s.activity[startedId] ?? null) : null));
	const dismissed = useDismissedSuggestions((s) => s.ids.includes(call.id));
	const details = run?.status === "done" ? (run.result?.details as SessionSuggestionDetails | undefined) : undefined;
	// 参数被退回的调用不留这一行：工具那一行自己说了哪里不对。
	if (!sessionId || details?.kind !== "session_suggestion") return null;

	const state = startedId ? "started" : dismissed ? "dismissed" : "suggested";
	const said = state === "started" ? `${t(suggestionStatus(activity))} · ${t("common.open")}` : state === "dismissed" ? t("sessionOps.dismissed") : t("sessionOps.pending");
	const press = () => {
		if (startedId) {
			if (sessionId !== useApp.getState().activeSessionId) focusScreenOf(sessionId);
			void useApp.getState().openSessionById(startedId);
			return;
		}
		revealEnvironmentSection("suggestions");
	};

	const body = (
		<>
			<SquarePen size={13} strokeWidth={1.9} aria-hidden className="shrink-0" />
			<span className="shrink-0">{t("sessionOps.noted")} ·</span>
			<span className="min-w-0 truncate text-ink-muted" data-ly-suggestion-title>
				{details.title}
			</span>
			<span className="shrink-0" data-ly-suggestion-status>
				· {said}
			</span>
		</>
	);
	const line = "-ml-2 inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg px-2 text-detail text-ink-faint";
	// 收起了就只是一句记录：要开始得在环境卡片里，而收起的那条已经不在那里了。
	if (state === "dismissed")
		return (
			<div data-ly-session-suggestion={state} data-ly-suggestion-call={call.id} className={line}>
				{body}
			</div>
		);
	return (
		<button
			type="button"
			data-ly-session-suggestion={state}
			data-ly-suggestion-call={call.id}
			data-ly-tip={state === "suggested" ? t("sessionOps.revealTip") : undefined}
			onClick={press}
			className={`${line} group/note transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink-muted`}
		>
			{body}
			<ChevronRight size={12} strokeWidth={1.9} aria-hidden className="shrink-0 opacity-60 group-hover/note:opacity-100" />
		</button>
	);
}
