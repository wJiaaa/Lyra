/**
 * The strip at the bottom, whose business is the app rather than the conversation.
 *
 * Padded container, rounded row — the same shape as every other item in this pane. As a full-bleed
 * button its hover fill ran edge to edge and read as a different kind of control from the list it
 * sits under.
 */

import { Settings as SettingsIcon } from "lucide-react";
import { useLayout } from "../../app/layout.tsx";
import { useApp, viewAvailable } from "../../store/index.ts";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { activeProviderLabel } from "../../lib/sidebar-grouping.ts";

export function SidebarFoot({ onNavigate }: { onNavigate: () => void }) {
	const settings = useApp((s) => s.settings);
	const setView = useApp((s) => s.setView);
	const { compact } = useLayout();

	// The whole strip is the way into settings, which a browser through Web access does not have.
	if (!viewAvailable("settings")) return null;

	return (
		<div className={`ly-sidebar-foot flex shrink-0 items-center gap-2 ${compact ? "p-3" : "p-2.5"}`}>
			<button
				type="button"
				onClick={() => {
					setView("settings");
					onNavigate();
				}}
				className={`ly-scroll flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover active:bg-elevated ${
					compact ? "h-[40px]" : "h-[34px]"
				}`}
			>
				<SettingsIcon size={16} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
				<ScrollText
					text={settings?.personalization?.sidebarMotto?.trim() || activeProviderLabel(settings?.providers ?? [])}
					className="ly-sidebar-foot-label min-w-0 flex-1 text-label text-ink"
				/>
				<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-caption text-ink-faint">
					?
				</span>
			</button>
		</div>
	);
}
