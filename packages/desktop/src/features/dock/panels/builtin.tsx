/**
 * The panels that ship with the app.
 *
 * Registered like any other set, so there is nothing special about them beyond loading first —
 * which is exactly the property that lets a plugin replace one.
 */

import { Bot, FileDiff, FileText, Folder, GitCompare, Globe, History, ListTodo, MessageCirclePlus, SquareTerminal, Undo2 } from "../../../ui/icons/index.ts";
import { useEffect, useRef, useState } from "react";

import { BrowserPanel } from "../../browser/index.ts";
import { FileBrowser } from "../../files/index.ts";
import { FilePanel } from "../../files/index.ts";
import { SubAgentPanel } from "../../subagents/index.ts";
import { FileActions } from "../../files/index.ts";
import { FileTitle, FileTabTitle, closeFile } from "../../files/index.ts";
import { DiffView, GitPanel } from "../../git/index.ts";
import { SideChat, SideChatActions, SideChatTitle, closeSideChat } from "../../sidechat/index.ts";
import { TaskPanel } from "../../task/index.ts";
import { TerminalPane, TerminalTitle, closeTerminal } from "../../terminal/index.ts";
import { announceUndo, TrajectoryPanel, useDeliveryReview, useDeliveryUndos, usePathMenu, useSharedDeliveryTarget } from "../../conversation/index.ts";
import type { DeliveryFile, TurnDelivery } from "../../../../electron/turn-delivery.ts";
import { useI18n } from "../../../i18n/index.ts";
import { relativeTo } from "../../../lib/paths.ts";
import { bridge } from "../../../services/index.ts";
import { useApp } from "../../../store/index.ts";
import { useConfirmer } from "../../../ui/overlay/Confirm.tsx";
import { PanelEmpty } from "../../../ui/layout/PanelEmpty.tsx";
import { IconButton } from "../../../ui/primitives/IconButton.tsx";
import { Scroller } from "../../../ui/scroll/Scroller.tsx";
import { usePaneDock } from "../pane-store.ts";
import { openFilePane } from "../popout.ts";
import { useDockScope, useScopedProjectPath, useScopedSessionId } from "../../../app/session-scope.tsx";
import { registerPanels, type PanelDefinition } from "./registry.ts";

/**
 * 子智能体面板，带着「把一份文件打开到旁边」这件事。
 *
 * 那个域不能引 dock（dock 的门后面挂着整棵面板树，会绕回它自己），而操控框里点开一枚文件标记，
 * 该去的正是旁边的文件面板——和主输入框、侧边聊天一样。所以这件事由已经站在 dock 里的这一层替它做。
 */
function SubAgentPane() {
	return (
		<SubAgentPanel
			openFile={(path, name) => void openFilePane({ path, name })}
		/>
	);
}

const needsWorkspace = (state: { workspace: boolean }) => (state.workspace ? undefined : "dock.needProject");
const needsSession = (state: { session: boolean }) => (state.session ? undefined : "dock.needSession");

function deliveryCounts(added: number, removed: number) {
	return <span className="flex shrink-0 items-center gap-1.5 tabular-nums"><span className="text-ok">+{added}</span><span className="text-danger">−{removed}</span></span>;
}

function deliveryName(path: string) {
	const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
	return <span className="min-w-0 flex-1 truncate"><span className="text-ink-muted">{path.slice(0, split)}</span><span className="text-ink">{path.slice(split)}</span></span>;
}

/**
 * This turn's recorded diffs, in a dock pane.
 *
 * Lives next to the other built-in renders so conversation/index does not
 * have to export a panel that pulls git and dock back into itself.
 */
function DeliveryTitle() {
	const { t } = useI18n();
	const owner = useScopedSessionId();
	const path = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target.path ?? null) : null));
	const name = path ? path.split(/[\\/]/).pop() : null;
	return (
		<span className="flex min-w-0 items-center gap-1 py-0.5 pl-1 text-detail">
			<FileDiff size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
			<span className="min-w-0 truncate text-ink">{name ?? t("delivery.fileChanges")}</span>
		</span>
	);
}

function DeliveryPanel() {
	const { t } = useI18n();
	// Named from the project of this screen's conversation; the live slot's is the focused screen's.
	const workspace = useScopedProjectPath();
	// The conversation whose screen this panel is in — not whichever one has the focus.
	const owner = useScopedSessionId();
	const scope = useDockScope();
	// A popped-out pane starts with an empty store; the turn it shows is on the shared record.
	useSharedDeliveryTarget(owner);
	// Right-click on a file's header: the same menu as the file's row on the card, minus 打开 — this
	// pane is the turn's recorded diff, and opening the file's current contents is the card's to offer.
	const pathMenu = usePathMenu(workspace);
	// That conversation's own review: one opened under another screen is that screen's, and leaves this one be.
	const target = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.target ?? null) : null));
	const cached = useDeliveryReview((state) => (owner ? (state.reviews[owner]?.data ?? null) : null));
	const [data, setData] = useState<TurnDelivery | null>(cached);
	const [undoing, setUndoing] = useState(false);
	const undoLock = useRef(false);
	const confirm = useConfirmer();

	useEffect(() => {
		if (!target) {
			setData(null);
			return;
		}
		const fromStore = useDeliveryReview.getState().reviews[target.sessionId]?.data;
		if (fromStore) setData(fromStore);
		let live = true;
		void bridge.delivery.get(target.sessionId, target.timestamp).then((value) => {
			if (live) {
				setData(value);
				useDeliveryReview.getState().setData(target.sessionId, value);
			}
		}).catch((error: unknown) => {
			if (live) useApp.getState().notify(String(error), "error");
		});
		return () => { live = false; };
	}, [target]);
	// Undos made on the turn's card, or in another window, change which of these files can still be undone.
	useDeliveryUndos(target?.sessionId ?? null, target?.timestamp ?? null, setData);

	const undo = async (path?: string) => {
		if (!target || undoLock.current) return;
		undoLock.current = true;
		setUndoing(true);
		try {
			await bridge.delivery.undo(target.sessionId, target.timestamp, path);
			const value = await bridge.delivery.get(target.sessionId, target.timestamp);
			// To this pane and everything else showing the turn — its card, in this window or the one it popped out of.
			announceUndo(target.sessionId, target.timestamp, value);
			useApp.getState().notify(t("delivery.reverted"), "info");
			if (!value.files.length) {
				useDeliveryReview.getState().close(target.sessionId);
				if (scope) usePaneDock.getState().close(scope, "delivery");
			}
		} catch (error) {
			useApp.getState().notify(String(error), "error");
		} finally {
			undoLock.current = false;
			setUndoing(false);
		}
	};

	if (!target) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const files = (data?.files ?? []).filter((file) => !target.path || file.path === target.path);
	if (!files.length) return <PanelEmpty icon={FileDiff} title={t("delivery.fileChanges")} />;
	const relative = (path: string) => workspace ? relativeTo(workspace, path) : path;
	const askUndo = (file: DeliveryFile) => {
		confirm.ask({
			title: t("delivery.revertFileConfirm"),
			detail: t("delivery.revertDetail"),
			confirmLabel: t("delivery.revertChanges"),
			onConfirm: () => undo(file.path),
		});
	};

	return <>
		<Scroller>
			{files.map((file) => (
				<section key={file.path} data-delivery-diff={file.path} className="mb-1">
					<div className="ly-pin sticky top-0 z-10">
						<div className="flex min-w-0 items-center gap-3 px-3 py-2 text-label" onContextMenu={(event) => pathMenu.onContextMenu(event, { path: file.path })}>
							{deliveryName(relative(file.path))}
							{deliveryCounts(file.added, file.removed)}
							<IconButton
								size="sm"
								icon={<Undo2 size={14} />}
								label={file.canUndo ? t("delivery.revertOne") : t("delivery.cannotRevert")}
								explainDisabled
								disabled={!file.canUndo || undoing}
								onClick={() => askUndo(file)}
							/>
						</div>
					</div>
					<DiffView path={file.path} hunks={file.hunks} maxLines={Infinity} />
				</section>
			))}
		</Scroller>
		{confirm.element}
		{pathMenu.element}
	</>;
}

const BUILTIN_PANELS: PanelDefinition[] = [
	{
		kind: "files",
		label: "common.files",
		icon: Folder,
		shortcut: "⌘P",
		unavailable: needsWorkspace,
		render: FileBrowser,
	},
	/*
	 * The open file, in a tab of its own rather than inside the tree.
	 *
	 * Opened by clicking a file rather than from the menu, most of the time — but it is listed
	 * there like any other pane, because once you have closed it the menu is how you say you want
	 * it back without having to find a file to click.
	 */
	{
		kind: "file",
		label: "dock.fileContents",
		icon: FileText,
		shortcut: "⌥⌘P",
		unavailable: needsWorkspace,
		// The open file and how it is being read move with it — `file-panel-handoff.ts` is that code.
		detach: "handoff",
		render: FilePanel,
		/*
		 * The file's name in place of the pane's, with the tree behind it.
		 *
		 * 「文件内容」 names a category nobody was in doubt about, on the one row that could have said
		 * which file — and this pane is very often the one left open after the tree has been
		 * closed, at which point it had neither a name nor a way to reach another file. See `FileTitle`.
		 */
		header: FileTitle,
		actions: FileActions,
		// 每个打开的文件是顶上的一个标签，写它的文件名——见 `openFilePane`。
		tabTitle: FileTabTitle,
		closeInstance: closeFile,
	},
	/*
	 * Delegated work, in a pane of its own.
	 *
	 * Beside 「侧边聊天」 because it is the same shape — a conversation that is not the main one —
	 * and deliberately not inside it: the side chat is yours to ask questions in, a sub-agent is
	 * the main agent's own worker. Merging them would put two different relationships in one pane.
	 */
	{
		kind: "subagents",
		label: "subAgent.title",
		icon: Bot,
		shortcut: "⌥⌘A",
		unavailable: needsSession,
		render: SubAgentPane,
	},
	{
		kind: "chat",
		label: "dock.sideChat",
		icon: MessageCirclePlus,
		shortcut: "⌥⌘S",
		unavailable: needsSession,
		render: SideChat,
		actions: SideChatActions,
		tabTitle: SideChatTitle,
		closeInstance: closeSideChat,
	},
	{
		kind: "terminal",
		label: "common.terminal",
		icon: SquareTerminal,
		shortcut: "⌃`",
		/*
		 * No availability rule: a shell needs a directory and there is always one.
		 *
		 * With a project open it starts there; without, the registry falls back to the home
		 * directory — the same thing every other terminal on the machine does.
		 */
		render: TerminalPane,
		tabTitle: TerminalTitle,
		closeInstance: closeTerminal,
	},
	{ kind: "tasks", label: "common.tasks", icon: ListTodo, shortcut: "⌘J", render: TaskPanel },
	{
		kind: "trajectory",
		label: "trajectory.title",
		icon: History,
		shortcut: "⌘L",
		unavailable: needsSession,
		render: TrajectoryPanel,
	},
	/*
	 * No window of its own: a `<webview>` cannot be moved between documents.
	 *
	 * The tab list is in the main process, so the *rows* would survive — but the page would be
	 * loaded again from its URL in the new window, which throws away scroll position, anything
	 * typed into a form, and whatever the page itself was holding. A button that silently reloads
	 * your page is worse than no button.
	 */
	{ kind: "browser", label: "browser.title", icon: Globe, shortcut: "⌘T", detach: "none", render: BrowserPanel },
	{ kind: "review", label: "common.git", icon: GitCompare, shortcut: "⌘⇧R", unavailable: needsWorkspace, render: GitPanel },
	/*
	 * This turn's recorded diffs — opened from the delivery card, not the +
	 * menu. Git stays `review`; the file pane stays current contents.
	 */
	{
		kind: "delivery",
		label: "delivery.fileChanges",
		icon: FileDiff,
		shortcut: "",
		listed: false,
		ephemeral: true,
		unavailable: needsSession,
		render: DeliveryPanel,
		header: DeliveryTitle,
		/*
		 * "self", said rather than defaulted: which turn and which file the pane shows is renderer state
		 * (`useDeliveryReview`), but it is also kept per conversation in localStorage, which every window
		 * shares — so a popped-out pane reads it itself and follows it (`useSharedDeliveryTarget`), and the
		 * diff it then fetches comes from the main process. Undeclared, it popped out as an empty pane.
		 */
		detach: "self",
	},
];

registerPanels(BUILTIN_PANELS);
