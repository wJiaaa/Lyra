/**
 * The title bar of one conversation screen, in two halves.
 *
 * `ScreenTitle` names the conversation — a folder icon, the title and a "…", which is the same
 * session menu as a right-click in the sidebar, after ZCode. `ScreenTools` holds the tools of *this*
 * conversation: terminal, browser, Git and the overflow open and close panels in this screen, and
 * their pressed state is this screen's; with several screens it also closes one.
 *
 * Both are drawn in the screen's own card, as `SplitChrome`, covering the transcript only — the
 * panels beside it carry their own headers. With one screen they once went up into the window's
 * toolbar; how much of the toolbar that filled then depended on what was open, and with no
 * conversation in front it stood empty.
 */

import { Folder, MoreHorizontal, X } from "../../ui/icons/index.ts";
import { useLayout } from "../../app/layout.tsx";
import { PanelMenu } from "../../app/window/WindowToolbar.tsx";
import { ToolbarButton } from "../../app/window/WindowControls.tsx";
import { WINDOW_HEADER_HEIGHT } from "../../../shared/window-chrome.ts";
import { useI18n } from "../../i18n/index.ts";
import { sessionTitle } from "../../lib/session-title.ts";
import { useApp } from "../../store/index.ts";
import { SessionMenu, deleteSessionQuestion } from "../modals/index.ts";
import { EnvironmentToggle } from "../environment/index.ts";
import { openScopedPanel } from "../dock/index.ts";
import { useConfirmer } from "../../ui/overlay/Confirm.tsx";
import { usePopover } from "../../ui/overlay/Popover.tsx";
import { closePane } from "./actions.ts";
import { paneKey } from "./pane-key.ts";
import { SplitMoveItems } from "./SplitMoveItems.tsx";

export function SplitChrome({
	sessionId,
	screen,
	inset,
	insetEnd,
	after,
}: {
	sessionId: string | null;
	/** More than one conversation on the window. */
	screen: boolean;
	inset: number;
	insetEnd: number;
	/** Last among the tools: the toggle that brings a folded panel column back. */
	after?: React.ReactNode;
}) {
	// 在有 header bar 的平台上它位于窗口中部，拖动窗口会连带 Windows 标题栏的行为——右键弹系统菜单、
	// 双击最大化。见 `PaneHeader`。
	const { headerBar } = useLayout();
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
			// 让位跟侧栏同一段滑动，见 `PaneHeader`。
			className={`${headerBar ? "" : "drag-region "}flex shrink-0 items-center gap-1.5 transition-[padding-left] duration-[var(--ly-t-base)] ease-out`}
		>
			<ScreenTitle sessionId={sessionId} screen={screen} />
			<ScreenTools sessionId={sessionId} screen={screen} after={after} />
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
 * several screens each one must say whose it is.
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
			{/* 不加粗：同一句话在侧栏和这里各画一遍，侧栏那份是常规字重，顶栏加粗就成两种标题。 */}
			<span data-ly-screen-title className="min-w-0 truncate text-label text-ink select-none">{title}</span>
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
					onShowTrajectory={() => openScopedPanel("trajectory", paneKey(sessionId))}
					onRequestDelete={() => void deleteSessionQuestion(meta, () => void deleteSession(meta)).then(confirm.ask)}
				/>
			)}
			{confirm.element}
		</>
	);
}

function ScreenTools({ sessionId, screen, after }: { sessionId: string | null; screen: boolean; after?: React.ReactNode }) {
	const { t } = useI18n();
	return (
		<div data-ly-split-tools data-dock-actions className="no-drag relative z-[1] ml-auto flex shrink-0 items-center gap-0.5">
			<PanelMenu
				scope={paneKey(sessionId)}
				extras={screen && sessionId ? (onClose) => <SplitMoveItems sessionId={sessionId} onClose={onClose} includeWindow /> : undefined}
				beforeMore={sessionId ? <EnvironmentToggle /> : null}
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
			{after}
		</div>
	);
}
