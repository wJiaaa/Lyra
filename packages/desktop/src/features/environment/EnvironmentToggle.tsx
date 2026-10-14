import { Layers } from "../../ui/icons/index.ts";
import { useI18n } from "../../i18n/index.ts";
import { useScopedSessionId, useScopedToolRuns } from "../../app/session-scope.tsx";
import { useApp } from "../../store/index.ts";
import { toggleEnvironmentCard, useEnvironmentCard } from "../../store/environment-card.ts";
import { pendingSuggestions, useDismissedSuggestions } from "../../store/session-suggestions.ts";
import { ToolbarButton } from "../../app/window/WindowControls.tsx";

/**
 * 标题栏上开关环境卡片的那颗。
 *
 * 和旁边几颗「只管打开」的面板按钮不同，它是开关，开着就亮：卡片就在按钮正下方，亮着的按钮和
 * 看得见的卡片说的是同一件事。
 *
 * 卡片收着、里面又有建议的新会话在等人决定时，按钮上挂一个圆点：建议不拦着这一轮，对话里那一行
 * 很快就滚走了，不说一声就等于藏起来。人把那一节关掉了就不再提醒。
 */
export function EnvironmentToggle() {
	const { t } = useI18n();
	const open = useEnvironmentCard((state) => state.open);
	const sectionHidden = useEnvironmentCard((state) => state.hidden.includes("suggestions"));
	const sessionId = useScopedSessionId();
	const runs = useScopedToolRuns();
	const sessions = useApp((s) => s.sessions);
	const dismissed = useDismissedSuggestions((s) => s.ids);
	const waiting = !open && !sectionHidden && sessionId ? pendingSuggestions(runs, sessions, sessionId, dismissed).length : 0;
	const label = waiting ? `${t("environment.title")} · ${t("environment.pendingSuggestions", { n: waiting })}` : t("environment.title");
	return (
		<ToolbarButton label={label} active={open} onClick={toggleEnvironmentCard}>
			<span data-ly-environment-toggle className="relative flex items-center justify-center">
				<Layers size={13} strokeWidth={1.9} />
				{waiting > 0 && <span aria-hidden data-ly-environment-dot className="absolute -top-1 -right-1.5 h-1.5 w-1.5 rounded-full bg-accent" />}
			</span>
		</ToolbarButton>
	);
}
