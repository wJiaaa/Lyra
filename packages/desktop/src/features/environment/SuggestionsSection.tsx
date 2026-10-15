/**
 * 「建议的新会话」：模型在这个对话里建议另开的会话（`spawn_session`），在这里开始、收起、打开。
 *
 * 卡片本身画在对话里调用的位置（`conversation/SessionSuggestionCard.tsx`）。这一节是第二个入口：它不随
 * 对话滚动，提完建议模型接着干活、卡片被顶到几屏之上时，还没处理的由标题栏按钮上的圆点提醒
 * （`EnvironmentToggle`），在这里也能开始。两处读同一份状态，「开始」那一排也是同一个组件。
 *
 * 等人决定的排在前面；开始以后缩成一行，说那个会话在做什么，点了过去。收起的不再列出。「已开始」读的是
 * 会话列表里的 `spawnedFrom`，所以重启后照样对。见 ADR-0049。
 */

import { useI18n } from "../../i18n/index.ts";
import { focusScreenOf, useScopedToolRuns } from "../../app/session-scope.tsx";
import { useApp } from "../../store/index.ts";
import { dismissSuggestion, startedFrom, suggestionStatus, suggestionsIn, useDismissedSuggestions, type SessionSuggestion } from "../../store/session-suggestions.ts";
import { SquarePen, X } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";
import { SessionStatus, SuggestionStart } from "../conversation/index.ts";
import { ROW, Section, SectionLabel } from "./rows.tsx";

export function SuggestionsSection({ sessionId }: { sessionId: string }) {
	const { t } = useI18n();
	const runs = useScopedToolRuns();
	const sessions = useApp((s) => s.sessions);
	const dismissed = useDismissedSuggestions((s) => s.ids);
	const all = suggestionsIn(runs).filter((one) => !dismissed.includes(one.callId));
	if (!all.length) return null;
	const started = all.flatMap((one) => {
		const meta = startedFrom(sessions, sessionId, one.callId);
		return meta ? [{ ...one, startedId: meta.id }] : [];
	});
	const pending = all.filter((one) => !started.some((done) => done.callId === one.callId));

	return (
		<Section name="suggestions">
			<SectionLabel>{t("sessionOps.suggested")}</SectionLabel>
			{pending.map((one) => (
				<Pending key={one.callId} sessionId={sessionId} suggestion={one} />
			))}
			{started.map((one) => (
				<Started key={one.callId} sessionId={sessionId} suggestion={one} startedId={one.startedId} />
			))}
		</Section>
	);
}

function Pending({ sessionId, suggestion }: { sessionId: string; suggestion: SessionSuggestion }) {
	const { t } = useI18n();
	const { callId, details } = suggestion;
	return (
		<div data-ly-environment-suggestion={callId} data-state="suggested" className="flex items-start gap-2 rounded-lg px-2 py-1.5">
			<SquarePen size={14} strokeWidth={1.8} aria-hidden className="mt-[3px] shrink-0 text-ink-muted" />
			<div className="min-w-0 flex-1">
				<p className="text-label text-ink" data-ly-suggestion-title>
					{details.title}
				</p>
				<p className="mt-0.5 line-clamp-3 text-caption text-ink-muted" data-ly-suggestion-summary>
					{details.summary}
				</p>
				<div className="mt-2">
					<SuggestionStart sessionId={sessionId} suggestion={suggestion} />
				</div>
			</div>
			<IconButton size="xs" label={t("sessionOps.dismiss")} icon={<X size={12} strokeWidth={1.9} />} onClick={() => dismissSuggestion(callId)} data-ly-suggestion-dismiss />
		</div>
	);
}

function Started({ sessionId, suggestion, startedId }: { sessionId: string; suggestion: SessionSuggestion; startedId: string }) {
	const { t } = useI18n();
	const activity = useApp((s) => s.activity[startedId] ?? null);
	const status = suggestionStatus(activity);
	const open = () => {
		// 在这张卡片所在的那一屏打开：鼠标点过来时那一屏已经聚焦，键盘过来的没有。
		if (sessionId !== useApp.getState().activeSessionId) focusScreenOf(sessionId);
		void useApp.getState().openSessionById(startedId);
	};
	return (
		<button type="button" data-ly-environment-suggestion={suggestion.callId} data-state="started" data-ly-suggestion-action="open" className={ROW} onClick={open}>
			{/* 和侧栏行首同一个标记：在跑是呼吸灯，跑完是绿点，一眼读到状态，不用看右边的字。 */}
			<SessionStatus activity={activity} />
			<span className="min-w-0 flex-1 truncate" data-ly-suggestion-title>
				{suggestion.details.title}
			</span>
			<span className={`shrink-0 text-caption ${status === "sessionOps.failed" ? "text-danger" : "text-ink-faint"}`} data-ly-suggestion-status>
				{t(status)}
			</span>
		</button>
	);
}
