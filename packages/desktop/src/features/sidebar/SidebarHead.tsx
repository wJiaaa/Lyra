/**
 * The pane's title bar: the app name, the search that opens `CommandPalette`, and the bell.
 *
 * The app name, and nothing more. It used to open the project picker, which put the same control
 * in two places and read as a dropdown over the whole window. Switching projects belongs on the
 * composer's project chip, next to what it actually scopes.
 */

import type { SessionMeta } from "@plume/core";
import { useState } from "react";
import { Bell, Search } from "../../ui/icons/index.ts";
import { useLayout } from "../../app/layout.tsx";
import { useI18n } from "../../i18n/index.ts";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { NoticeDot, NotificationsMenu, useNotices } from "./NotificationsMenu.tsx";
import { ProjectDialog } from "../modals/index.ts";
import { CommandPalette } from "./CommandPalette.tsx";

export function SidebarHead({ onOpen }: { onOpen: (meta: SessionMeta) => void }) {
	const { t } = useI18n();
	const { compact } = useLayout();
	const bell = usePopover();
	const [searching, setSearching] = useState(false);
	/** 面板里的「新建项目」：面板关掉以后由这里接着开项目对话框。 */
	const [creating, setCreating] = useState(false);
	const notices = useNotices();
	return (
		<>
			{/*
			 * The bell sits on the column of the `+` and the row actions under it: the list's
			 * `px-2.5`/`px-3`, the actions' 6px inset and half a 22px button, less half of this 28px one,
			 * is `pr-[13px]`/`pr-[15px]`. No top margin, and the row as tall as the buttons (28px):
			 * the buttons' top lands on the top edge of the card beside the sidebar, which sits flush under
			 * the toolbar (`.ly-frame-panel`); any gap here and the two tops read as misaligned.
			 * `pl-5`: the name starts on the line 新对话's icon and the list's
			 * headings start on (20px); at 16px it stood 4px out from everything under it. `mb-[11px]`:
			 * 11px from the buttons to 新对话, as before; at 4px it read as a second line of the title
			 * rather than the first thing in the pane.
			 */}
			<div
				className={`ly-sidebar-head mb-[11px] flex h-7 shrink-0 items-center justify-between pl-5 ${compact ? "pr-[15px]" : "pr-[13px]"}`}
			>
				<span className="text-title font-semibold tracking-tight text-ink">Plume</span>
				<div className="flex items-center gap-[5px]">
					<button
						type="button"
						data-ly-tip={t("sidebar.search")}
						aria-label={t("sidebar.search")}
						aria-haspopup="dialog"
						aria-expanded={searching}
						onClick={() => setSearching(true)}
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
				<CommandPalette onClose={() => setSearching(false)} onOpenSession={onOpen} onNewProject={() => setCreating(true)} />
			)}
			{creating && <ProjectDialog onClose={() => setCreating(false)} />}
		</>
	);
}
