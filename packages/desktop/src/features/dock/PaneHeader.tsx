/**
 * A pane's title bar: what it is, and the things you can do to it.
 *
 * **The bar moves the window.** The dock reaches the top edge, so if these bars do not move the
 * window, nothing up there does — losing this is what made the window undraggable for a while.
 *
 * `drag-region` on the bar, `no-drag` on everything you can press. Electron composites the two by
 * walking the document in order, so the holes have to come after the region they are cut out of —
 * which is the order they appear in below.
 *
 * No border under it. The panes are cards with their own edges, and a rule here would draw a
 * second line a few pixels inside the first.
 */

import { translate } from "../../i18n/translate.ts";
import { Maximize2, Minimize2, SquareArrowOutUpRight } from "../../ui/icons/index.ts";
import { HEADER_HEIGHT, HEADER_PAD } from "./geometry.ts";
import type { PaneKind } from "./tree.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

export function PaneHeader({
	kind,
	label,
	icon,
	maximized,
	hideTitle,
	title,
	actions,
	inset,
	insetEnd,
	onToggleMaximized,
	onPopOut,
}: {
	kind: PaneKind;
	label: string;
	icon?: React.ReactNode;
	maximized: boolean;
	/**
	 * Draw the bar without a name.
	 *
	 * The conversation uses this: the sidebar already says which one is open, and repeating it
	 * above a transcript that also says so is a third copy of the same fact.
	 */
	hideTitle?: boolean;
	/** Drawn in place of the name, for a panel whose header is a control. */
	title?: React.ReactNode;
	/**
	 * Controls belonging to what the pane holds, left of the pane's own.
	 *
	 * The conversation puts the window's panel buttons here. They used to live in a toolbar of
	 * their own above the dock, which cost a whole row and left the buttons and the pane titles on
	 * two different lines — see the note on `HEADER_HEIGHT`.
	 */
	actions?: React.ReactNode;
	/**
	 * Room for the traffic lights, when this pane is what covers the window's top-left corner.
	 *
	 * Normally nobody needs it: the sidebar is there. Close the sidebar and the corner belongs to
	 * whichever pane is first, and its title would otherwise start underneath three buttons drawn
	 * by the system.
	 */
	inset?: number;
	/**
	 * The same at the trailing end, for the window controls Windows and Linux draw over the page.
	 *
	 * Nothing to do with the sidebar: this corner is never covered, so it is always the pane at the
	 * right edge of the top row that has to move its own buttons out from under the system's.
	 */
	insetEnd?: number;
	/**
	 * Absent where full screen means nothing — the conversation, which is already what the dock is
	 * showing, and the collapsed layout, where one pane is all there is room for. Decided by the
	 * dock and passed in; see `canToggleMaximized`.
	 */
	onToggleMaximized?: () => void;
	/** Leave the dock for a real window. Absent on the conversation. */
	onPopOut?: () => void;
}) {
	return (
		<div
			data-dock-header={kind}
			style={{
				height: HEADER_HEIGHT,
				paddingLeft: (inset ?? 0) + HEADER_PAD,
				// 6px is `pr-1.5`, which is what this row used before there was anything to clear.
				paddingRight: (insetEnd ?? 0) + 6,
			}}
			className="drag-region group/header relative flex shrink-0 items-center gap-1.5"
		>
			{/*
			 * A panel may put a control here instead of its name — the terminal's tab strip does,
			 * because once a pane holds several of something, choosing between them *is* the title.
			 */}
			{/*
			 * The title gets the bar minus whatever the actions take, and stops there.
			 *
			 * `overflow-hidden` rather than a width: what a title may use is whatever the buttons
			 * leave over, and that differs per pane and changes with the window.
			 */}
			<div className="relative min-w-0 flex-1 overflow-hidden">
				<div data-dock-heading-slot className="min-w-0">
					<div data-dock-heading className="flex min-w-0 items-center gap-1.5">
						{title ?? <>
							{!hideTitle && icon && <span className="flex shrink-0 items-center text-ink-faint">{icon}</span>}
							<span className="min-w-0 flex-1 truncate text-detail text-ink-muted select-none">{hideTitle ? "" : label}</span>
						</>}
					</div>
				</div>
			</div>

			<PaneActions kind={kind} label={label} maximized={maximized} actions={actions} onToggleMaximized={onToggleMaximized} onPopOut={onPopOut} />
		</div>
	);
}

/**
 * A pane's own controls: what the panel brings, then pop out and full screen. Closing is on the tab.
 *
 * Its own component because the tabs layout draws them in the window's toolbar instead of the pane's
 * bar (see `ToolbarPanelBar`), and the two places must offer the same buttons.
 */
export function PaneActions({
	kind,
	label,
	maximized,
	actions,
	onToggleMaximized,
	onPopOut,
	after,
}: {
	kind: PaneKind;
	label: string;
	maximized: boolean;
	actions?: React.ReactNode;
	onToggleMaximized?: () => void;
	onPopOut?: () => void;
	/** 排在最后、和这几颗同一组同样间距的按钮：顶栏里收起右栏的开关。 */
	after?: React.ReactNode;
}) {
	// `no-drag`: the bar around them moves the window, and a press here is meant for the button.
	return (
		<div data-dock-actions className="no-drag relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
			{actions}
			{/*
			 * Only where there is something to maximise *from*.
			 *
			 * The conversation is what the window is already showing — offering to make it
			 * fill the window is offering to do nothing. In the collapsed layout the same is
			 * true of every pane, since one of them is all there is room for. Both of those are the
			 * dock's call, not this component's — see `onToggleMaximized`.
			 */}
			{onPopOut && (
				<HeaderButton
					tip={translate("pane.openInNewWindow")}
					label={translate("pane.openInNewWindow")}
					onClick={onPopOut}
				>
					<span data-ly-pop-out={kind} className="flex items-center justify-center">
						<SquareArrowOutUpRight size={12} strokeWidth={1.9} />
					</span>
				</HeaderButton>
			)}
			{onToggleMaximized && (
				<HeaderButton
					tip={translate(maximized ? "pane.exitFullScreen" : "common.fullScreen")}
					label={translate(maximized ? "pane.exitFullScreenOne" : "pane.fullScreenOne", { label })}
					onClick={onToggleMaximized}
				>
					{maximized ? <Minimize2 size={12} strokeWidth={2} /> : <Maximize2 size={12} strokeWidth={2} />}
				</HeaderButton>
			)}
			{after}
		</div>
	);
}

function HeaderButton({
	tip,
	label,
	onClick,
	children,
}: {
	tip: string;
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return <IconButton size="xs" label={tip} ariaLabel={label} onClick={onClick} icon={children} />;
}
