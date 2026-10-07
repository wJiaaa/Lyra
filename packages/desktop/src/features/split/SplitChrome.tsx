/**
 * The title bar of one conversation screen, in two halves.
 *
 * `ScreenTitle` names the conversation — a folder icon, the title and a "…", which is the same
 * session menu as a right-click in the sidebar, after ZCode. `ScreenTools` holds the tools of *this*
 * conversation: terminal, browser, Git and the overflow open and close panels in this screen, and
 * their pressed state is this screen's; with several screens it also closes one.
 *
 * Where the halves are drawn depends on how many screens there are. Several: each in its own screen's
 * card, as `SplitChrome`, covering the transcript only — the panels beside it carry their own headers.
 * One: in the window's toolbar (`ToolbarScreenTitle` / `ToolbarScreenTools`), with the title over the
 * conversation's card and nothing inside the card, as the reference layout draws it.
 */

import { Folder, MoreHorizontal, X } from "../../ui/icons/index.ts";
import { PanelMenu } from "../../app/window/WindowToolbar.tsx";
import { ToolbarButton } from "../../app/window/WindowControls.tsx";
import { WINDOW_HEADER_HEIGHT } from "../../../shared/window-chrome.ts";
import { useI18n } from "../../i18n/index.ts";
import { sessionTitle } from "../../lib/session-title.ts";
import { useApp } from "../../store/index.ts";
import { SessionMenu } from "../modals/index.ts";
import { openScopedPanel } from "../dock/index.ts";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { closePane } from "./actions.ts";
import { paneKey } from "./pane-key.ts";
import { SplitMoveItems } from "./SplitMoveItems.tsx";
import { leafCount, firstSession } from "./tree.ts";
import { useSplit } from "./store.ts";

export function SplitChrome({
	sessionId,
	screen,
	inset,
	insetEnd,
}: {
	sessionId: string | null;
	/** More than one conversation on the window. */
	screen: boolean;
	inset: number;
	insetEnd: number;
}) {
	return (
		<header
			// One screen answers to the old single-screen selector; several each answer to their own.
			data-ly-split-chrome={screen ? paneKey(sessionId) : undefined}
			data-dock-header={screen ? undefined : "conversation"}
			style={{
				height: WINDOW_HEADER_HEIGHT,
				paddingLeft: inset + 10,
				paddingRight: insetEnd + 6,
			}}
			className="drag-region flex shrink-0 items-center gap-1.5"
		>
			<ScreenTitle sessionId={sessionId} screen={screen} />
			<ScreenTools sessionId={sessionId} screen={screen} />
		</header>
	);
}

/** The conversation's metadata, wherever it is: the live one, a warmed screen, or the sidebar list. */
function useScreenMeta(sessionId: string | null) {
	return useApp((s) =>
		!sessionId
			? s.activeSessionId
				? null
				: s.meta
			: s.activeSessionId === sessionId
				? s.meta
				: (s.sessionCache[sessionId]?.meta ?? s.sessions.find((session) => session.id === sessionId) ?? null),
	);
}

/**
 * The conversation's name and the metadata behind it.
 *
 * A blank new conversation on a single screen has no session to name yet, so no "Untitled"; with
 * several screens each one must say whose it is. Shared with `ToolbarScreenTitle`, which has to
 * know whether there is a name before it draws the mark that sets one off.
 */
function useScreenHead(sessionId: string | null, screen: boolean) {
	const meta = useScreenMeta(sessionId);
	const title = meta || screen ? sessionTitle(meta?.title) : "";
	return { meta, title };
}

function ScreenTitle({ sessionId, screen }: { sessionId: string | null; screen: boolean }) {
	const { t } = useI18n();
	const { meta, title } = useScreenHead(sessionId, screen);
	const deleteSession = useApp((s) => s.deleteSession);
	const menu = usePopover();
	// The delete confirmation hangs here rather than in the menu: the menu unmounts once clicked. See `onRequestDelete` on `SessionMenu`.
	const confirm = useConfirmer();
	return (
		<>
			{meta && <Folder size={15} strokeWidth={1.7} aria-hidden className="shrink-0 text-ink-faint" />}
			<span data-ly-screen-title className="min-w-0 truncate text-label font-semibold text-ink select-none">{title}</span>
			{meta && (
				<div className="no-drag flex shrink-0">
					<ToolbarButton label={t("split.sessionActions")} onClick={menu.toggle} active={menu.open}>
						<MoreHorizontal size={15} strokeWidth={2} />
					</ToolbarButton>
				</div>
			)}
			{meta && menu.open && (
				<SessionMenu
					anchor={menu.anchor}
					below
					session={meta}
					onClose={menu.close}
					// 这条会话就在这一屏上，直接在这一屏的停靠区里开，不用像侧边栏那样先打开再等。
					onShowTrajectory={() => openScopedPanel("trajectory", undefined, paneKey(sessionId))}
					onRequestDelete={() =>
						confirm.ask({
							title: t("sidebarList.deleteConfirm"),
							detail: t("sidebarList.deleteDetail", { title: meta.title, n: meta.messageCount }),
							confirmLabel: t("common.delete"),
							onConfirm: () => void deleteSession(meta),
						})
					}
				/>
			)}
			{confirm.element}
		</>
	);
}

function ScreenTools({ sessionId, screen }: { sessionId: string | null; screen: boolean }) {
	const { t } = useI18n();
	return (
		<div data-ly-split-tools data-dock-actions className="no-drag relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
			<PanelMenu
				scope={paneKey(sessionId)}
				extras={screen && sessionId ? (onClose) => <SplitMoveItems sessionId={sessionId} onClose={onClose} includeWindow /> : undefined}
			/>
			{screen && sessionId && (
				<ToolbarButton
					label={t("split.closePane")}
					onClick={(event) => {
						event.stopPropagation();
						closePane(sessionId);
					}}
				>
					<span data-ly-split-close={sessionId} className="flex items-center justify-center">
						<X size={13} strokeWidth={1.9} aria-hidden />
					</span>
				</ToolbarButton>
			)}
		</div>
	);
}

/**
 * The one screen the window shows, when it shows exactly one conversation view — what the toolbar
 * draws the title bar for. `undefined` when there is no such screen: several screens, or another
 * view (the plugin catalogue, settings) in front of the conversations.
 */
function useSingleScreen(): { sessionId: string | null } | undefined {
	const single = useSplit((s) => leafCount(s.tree) === 1);
	const sessionId = useSplit((s) => firstSession(s.tree));
	const chat = useApp((s) => s.view === "chat");
	return single && chat ? { sessionId } : undefined;
}

/** The single screen's title, drawn in the window's toolbar over the conversation's card. */
export function ToolbarScreenTitle() {
	const screen = useSingleScreen();
	// A conversation nothing has named yet — a window that just opened — has no title to set off, and
	// the rule left standing on its own marks nothing. Read before the early return below, which
	// would otherwise skip a hook.
	const { title } = useScreenHead(screen?.sessionId ?? null, false);
	if (!screen) return null;
	return (
		<>
			{/*
			 * A short rule just before the title, on the line of the sidebar's divider while the sidebar is
			 * open (the toolbar's middle starts on that line — the panel's border is the pixel before it):
			 * the title starts on the content's side of it, as in the reference. Short, not run into the
			 * divider below — joined up, the two read as a wall through the window rather than a mark in
			 * the toolbar.
			 *
			 * It belongs to the title, not to the toolbar: drawn by the toolbar it stayed on every other page
			 * and with several screens, marking off a title that was not there — and, for the same reason,
			 * it waits for a title here.
			 */}
			{title && <span aria-hidden data-ly-toolbar-divider className="ly-toolbar-divider mr-[7px] h-5 w-px shrink-0" />}
			<div data-dock-header="conversation" data-ly-toolbar-title className="flex min-w-0 items-center gap-1.5">
				<ScreenTitle sessionId={screen.sessionId} screen={false} />
			</div>
		</>
	);
}

/** The single screen's panel buttons, at the toolbar's far end. */
export function ToolbarScreenTools() {
	const screen = useSingleScreen();
	if (!screen) return null;
	return <ScreenTools sessionId={screen.sessionId} screen={false} />;
}
