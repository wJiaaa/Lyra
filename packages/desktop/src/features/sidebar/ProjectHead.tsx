/**
 * A project's name row — the heading for the conversations under it.
 *
 * Its own file because it is drawn in two places. In the list it holds the space and is what the
 * pinning measures against; over the list it is the copy that stays put while you scroll through
 * the project, which is the whole reason you can still tell which one you are in forty rows down.
 * `StickyLayer` renders the second, from the same component, so the two cannot drift.
 *
 * The open project is not filled, unlike the open session. Both used to take the same fill, so an
 * open project sitting directly above its own open session put two identical blocks four pixels
 * apart — one continuous grey slab with no hierarchy left in it. A project is a heading for the
 * sessions under it, not one of the things you pick between; it says it is open by the weight of
 * its name and the colour of its icon, and keeps the fill for hover, where it means "you are about
 * to press this".
 */

import { translate } from "../../i18n/translate.ts";
import { Folder, FolderOpen, MoreHorizontal, SquarePen } from "lucide-react";
import { useLayout } from "../../app/layout.tsx";
import { ProjectMenu } from "../modals/index.ts";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { ScrollText } from "../../ui/scroll/ScrollText.tsx";
import { GroupActivity } from "./GroupActivity.tsx";
import type { Group } from "../../lib/sidebar-grouping.ts";
import { startProjectSession } from "../../store/project-session.ts";
import { useSidebarReorderContext } from "./reorder-context.ts";
import { HoverRow, HoverRowReveal, hoverSlot } from "../../ui/row/HoverRow.tsx";

export function ProjectHead({
	group,
	collapsed,
	onToggleCollapsed,
}: {
	group: Group;
	collapsed: boolean;
	onToggleCollapsed: () => void;
}) {
	const { compact } = useLayout();
	const menu = usePopover();
	const reorder = useSidebarReorderContext();

	return (
		/* Same hover-owner arrangement as the session rows: the fill belongs to the row so
		   reaching for the menu button does not drop it. */
		<HoverRow
			data-ly-project={group.name}
			controls={hoverSlot(2)}
			className="group/project rounded-lg transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover active:bg-elevated"
			onPointerMove={(event) => {
				if (reorder) {
					const rect = event.currentTarget.getBoundingClientRect();
					reorder.registerTarget("project", group.path, rect, event.clientY);
				}
			}}
			onPointerUp={(event) => {
				reorder?.registerTarget("project", group.path, event.currentTarget.getBoundingClientRect(), event.clientY);
			}}
			onPointerLeave={() => {
				if (reorder) {
					reorder.clearTarget(group.path);
				}
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				// At the cursor: right-click acts on the row as a whole, so there is no one
				// control for the menu to hang off.
				menu.openAtPoint(event);
			}}
		>
			{/*
			 * The heading folds the project; switching to it moved into the menu.
			 *
			 * A project name is a heading for the rows under it, and the thing you want from a
			 * heading in a list this long is to be able to put it away. Switching workspace is
			 * the rarer intent and it already happens on its own whenever you open a session
			 * inside — so it lost the click and kept a menu item, rather than the two sharing
			 * one target and the fold never existing.
			 */}
			<button
				onPointerDown={(event) => {
					reorder?.startDrag({ kind: "project", id: group.path, title: group.name }, event);
				}}
				type="button"
				aria-expanded={!collapsed}
				onClick={onToggleCollapsed}
				className={`flex w-full items-center gap-2 rounded-lg pr-2 pl-2.5 text-left text-label text-ink-muted transition-colors duration-[var(--ly-t-quick)] ${
					compact ? "h-[40px]" : "h-[32px]"
				}`}
			>
				{/* 和 ZCode 一样：只用文件夹本身表示开合，不在悬停时换成箭头。 */}
				<span className="shrink-0">{collapsed ? <Folder size={16} /> : <FolderOpen size={16} />}</span>
				<ScrollText text={group.name} className="ly-fade-tail min-w-0 flex-1" />
				{/*
				 * How many are folded away, so a shut project is not indistinguishable from an
				 * empty one. Only while shut: open, the rows themselves are the count.
				 * Running work replaces the count with a quiet spinner in this same trailing slot.
				 *
				 * It vacates under the pointer, the same way the folder does. The menu button
				 * lives at this exact spot, and the two drawn together was not two things
				 * crowding each other — it was a numeral and an icon on the same pixels, legible
				 * as neither. Hovering is reaching for the button, so the count is what yields.
				 */}
				<span className="flex w-[46px] shrink-0 items-center justify-end pr-0.5 text-caption text-ink-faint tabular-nums transition-opacity duration-[var(--ly-t-quick)] group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0">
					<GroupActivity sessions={group.sessions} collapsed={collapsed} count={group.sessions.length} />
				</span>
			</button>

			<HoverRowReveal className="gap-0.5 rounded-r-lg">
				<button
					type="button"
					data-ly-tip={translate("projectHead.newSession")}
					aria-label={translate("projectHead.newSessionIn", { name: group.name })}
					onClick={() => void startProjectSession(group.path, collapsed ? onToggleCollapsed : undefined)}
					className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
				>
					<SquarePen size={13} strokeWidth={1.8} />
				</button>
				<button
					type="button"
					data-ly-tip={translate("projectHead.actions")}
					aria-label={translate("projectHead.actionsFor", { name: group.name })}
					aria-haspopup="menu"
					onClick={menu.toggle}
					className="pointer-events-auto rounded p-1 text-ink-faint transition-colors duration-[var(--ly-t-quick)] hover:text-ink"
				>
					<MoreHorizontal size={13} strokeWidth={1.8} />
				</button>
			</HoverRowReveal>

			{menu.open && <ProjectMenu anchor={menu.anchor} path={group.path} name={group.name} onClose={menu.close} />}
		</HoverRow>
	);
}
