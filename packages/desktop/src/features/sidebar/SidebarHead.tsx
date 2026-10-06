/**
 * The pane's title bar, and the search that drops out of it.
 *
 * The app name, and nothing more. It used to open the project picker, which put the same control
 * in two places and read as a dropdown over the whole window. Switching projects belongs on the
 * composer's project chip, next to what it actually scopes.
 */

import { Bell, Search } from "lucide-react";
import { SearchField } from "../../ui/inputs/SearchField.tsx";
import { useI18n } from "../../i18n/index.ts";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { NoticeDot, NotificationsMenu, useNotices } from "./NotificationsMenu.tsx";

export function SidebarHead({
	searching,
	query,
	onQuery,
	onToggleSearch,
}: {
	searching: boolean;
	query: string;
	onQuery: (query: string) => void;
	/** Opens the field, and — pressed again or on Escape — closes it and clears what was typed. */
	onToggleSearch: () => void;
}) {
	const { t } = useI18n();
	const bell = usePopover();
	const notices = useNotices();
	return (
		<>
			{/*
			 * `pr-2` and no gap: the two buttons are 28px, the strip's below are 24px with 4px between,
			 * so this is what puts each on the same centre as the one under it. With `px-4` and a gap
			 * they sat 8–10px left of them. `mt-2`: flush at 5px the name read as pressed to the edge.
			 * `pl-5`: the name starts on the line 新对话's icon and the list's headings start on (20px);
			 * at 16px it stood 4px out from everything under it. `mb-2`: at 4px 新对话 read as a second
			 * line of the title rather than the first thing in the pane.
			 */}
			<div className="ly-sidebar-head mt-2 mb-2 flex h-[34px] shrink-0 items-center justify-between pr-2 pl-5">
				<span className="text-title font-semibold tracking-tight text-ink">Plume</span>
				<div className="flex items-center">
					<button
						type="button"
						data-ly-tip={t("sidebar.search")}
						aria-label={t("sidebar.search")}
						aria-pressed={searching}
						onClick={onToggleSearch}
						className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-card-hover hover:text-ink ${
							searching ? "bg-card-hover text-ink" : "text-ink-muted"
						}`}
					>
						<Search size={15} strokeWidth={1.9} />
					</button>
					<button
						type="button"
						data-ly-tip={t("sidebar.notifications")}
						aria-label={t("sidebar.notifications")}
						aria-haspopup="menu"
						aria-expanded={bell.open}
						data-ly-notifications-button
						onClick={bell.toggle}
						className={`relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-card-hover hover:text-ink ${
							bell.open ? "bg-card-hover text-ink" : "text-ink-muted"
						}`}
					>
						<Bell size={15} strokeWidth={1.9} />
						<NoticeDot top={notices.top} />
					</button>
				</div>
			</div>

			{bell.open && <NotificationsMenu anchor={bell.anchor} notices={notices} onClose={bell.close} />}

			{searching && (
				<div className="px-3 pb-2">
					<SearchField
						autoFocus
						size="comfortable"
						value={query}
						onChange={onQuery}
						onEscape={onToggleSearch}
						placeholder={t("sidebar.searchPlaceholder")}
					/>
				</div>
			)}
		</>
	);
}
