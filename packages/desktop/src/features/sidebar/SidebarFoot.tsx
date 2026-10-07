/**
 * The strip at the bottom, whose business is the app rather than the conversation.
 *
 * Padded container, rounded row — the same shape as every other item in this pane. As a full-bleed
 * button its hover fill ran edge to edge and read as a different kind of control from the list it
 * sits under.
 */

import { Settings as SettingsIcon } from "../../ui/icons/index.ts";
import { useLayout } from "../../app/layout.tsx";
import { useI18n } from "../../i18n/index.ts";
import { useApp } from "../../store/index.ts";

export function SidebarFoot({ onNavigate }: { onNavigate: () => void }) {
	const { t } = useI18n();
	const setView = useApp((s) => s.setView);
	const { compact } = useLayout();

	return (
		<div className={`ly-sidebar-foot flex shrink-0 items-center gap-2 ${compact ? "p-3" : "p-2.5"}`}>
			<button
				type="button"
				data-ly-open-settings=""
				onClick={() => {
					setView("settings");
					onNavigate();
				}}
				className={`ly-scroll flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover active:bg-elevated ${
					compact ? "h-[40px]" : "h-[34px]"
				}`}
			>
				<SettingsIcon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
				<span className="min-w-0 flex-1 truncate text-label text-ink">{t("sidebar.settings")}</span>
			</button>
		</div>
	);
}
