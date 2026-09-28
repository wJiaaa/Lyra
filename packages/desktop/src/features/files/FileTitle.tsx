/**
 * The open file's name, and the whole tree behind it.
 *
 * The pane's header used to say 「文件内容」 — a label naming the pane's own category, on a pane
 * whose category is never in doubt, taking the one row that could have said *which file*. Worse,
 * that was the state the pane was most often left in: the tree is a companion that gets closed, and
 * with it gone this pane became a file with no name and no way to reach another one.
 *
 * So the name is the control. It says what is open, and — when there is no tree on screen — pressing
 * it drops the project's tree down under it. That is the same `FileTree` the panel draws, not a
 * reduced copy: expanding, collapsing, searching, renaming, the right-click menu and drag-and-drop
 * all work here because it *is* that component. Which folders are open is shared state
 * (`store/fileTree.ts`), so a tree opened here is open in the panel and the other way round.
 *
 * Only when there is no tree on screen. With the tree pane beside this one the dropdown would be a
 * second copy of a list you are already looking at, and a control that opens one is a control that
 * does nothing worth doing — so the name is just a name then. What counts as "on screen" is not
 * "open": maximising this pane on its own covers the tree, and a narrow window shows one pane at a
 * time. See `paneVisible`.
 *
 * 标签页排法下前面再补上它所在的目录——见 `FileDirs`。
 */

import { useI18n } from "../../i18n/index.ts";
import { ChevronDown, ChevronRight, FileText, PanelLeft } from "lucide-react";
import { Fragment } from "react";

import { openFilePane, openScopedPanel, usePaneOnScreen, usePanelLayout } from "../dock/index.ts";
import { companionOf } from "../dock/index.ts";
import { useProjectFolders } from "../../store/project-folders.ts";
import { useDockScope, useScopedWorkspace } from "../../app/session-scope.tsx";
import { useOpenFile } from "../../store/openFile.ts";
import { baseName, isDescendantPath, parentOf, relativeTo, tildeHome } from "../../lib/paths.ts";
import { iconColour, lookFor } from "../../ui/fileIcon.tsx";
import { usePaneFile, usePaneSlot } from "./pane-file.tsx";
import { MENU_MAX_HEIGHT, Popover, usePopover } from "../../ui/overlay/Popover.tsx";
import { FileTree } from "./FileTree.tsx";

/**
 * How tall the tree in the dropdown is.
 *
 * Fixed, not grown from its contents: the tree is a scroller with a search field pinned above it,
 * and a surface that resized itself as folders opened would move the row under the pointer every
 * time one was expanded. `MENU_MAX_HEIGHT` is what every other list in the app is capped at.
 */
const TREE_HEIGHT = MENU_MAX_HEIGHT;

/** Wider than a menu: these rows are indented paths, and the indent is what a tree reads by. */
const TREE_WIDTH = 320;

export function FileTitle() {
	const { t } = useI18n();
	// Every source folder of this screen's project, so this tree and the one in its Files panel agree.
	const { workspace } = useScopedWorkspace();
	const folders = useProjectFolders(workspace);
	// The tree pane it hands off to opens in this screen, named rather than found by focus.
	const screen = useDockScope();
	const slot = usePaneSlot();
	const path = usePaneFile((s) => s.path);
	const name = usePaneFile((s) => s.name);
	const empty = usePaneFile((s) => !s.path && !s.opening);
	const menu = usePopover();
	const treeOnScreen = useTreeOnScreen();
	const tabbed = usePanelLayout() === "tabs";

	/*
	 * 标签页排法下，标签上已经写着文件名，这一行前面补上它在哪：项目 › 目录 › 文件名。文件名照旧
	 * 点得开下拉树。图标换成文件自己的，和树里、标签上认的是同一个样子。
	 */
	const dirs = tabbed ? <FileDirs folders={folders} path={path} /> : null;
	const look = tabbed && name ? lookFor(name, false) : null;
	const icon = look ? (
		<look.Icon size={12.5} strokeWidth={1.75} className="shrink-0" style={{ color: iconColour(look) }} />
	) : (
		<FileText size={12.5} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
	);

	/*
	 * A name, and nothing more, while the tree is beside it.
	 *
	 * Not a disabled button: there is nothing here to be unavailable, the job is simply the tree
	 * pane's while that pane exists. A greyed-out chevron would advertise a route that is already
	 * open in a larger form a few pixels away.
	 */
	if (treeOnScreen) {
		return (
			<>
			{dirs}
			<span className="flex min-w-0 items-center gap-1 py-0.5 pl-1 text-detail" data-ly-tip={path ?? undefined}>
				{icon}
				<span className={`min-w-0 truncate ${path ? "text-ink" : "text-ink-muted"}`}>{name ?? t("dock.fileContents")}</span>
			</span>
			</>
		);
	}

	return (
		<>
			{dirs}
			<button
				type="button"
				// `no-drag`, like every control in a pane header: the bar around it moves the window.
				className="no-drag group/title flex min-w-0 items-center gap-1 rounded-lg py-0.5 pr-1 pl-1 text-detail transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover"
				aria-haspopup="tree"
				aria-expanded={menu.open}
				data-ly-tip={path ?? undefined}
				onClick={menu.toggle}
			>
				{icon}
				<span className={`min-w-0 truncate ${path ? "text-ink" : "text-ink-muted"}`}>{name ?? t("dock.fileContents")}</span>
				<ChevronDown
					size={11}
					strokeWidth={2}
					className={`shrink-0 text-ink-faint transition-transform duration-[var(--ly-t-quick)] ${
						menu.open ? "rotate-180" : ""
					}`}
				/>
			</button>

			{menu.open && (
				<Popover
					anchor={menu.anchor}
					onClose={menu.close}
					placement="bottom"
					align="start"
					width={TREE_WIDTH}
					role="group"
					label={t("fileTree.projectFiles")}
					// The tree brings its own scroller and its own padding.
					bodyClassName="p-0"
					/*
					 * The way out of the dropdown and into a pane.
					 *
					 * The two are the same tree in different clothes — one is for reaching a file and
					 * closing again, the other for living in while you work — and which one you want
					 * changes minute to minute. Without this the trip was one-way: closing the tree
					 * pane left the dropdown as the only route, and getting the pane back meant going
					 * through the panel menu, which is a different part of the window entirely.
					 *
					 * In the footer because it is the answer to "I want more of this than a dropdown",
					 * which is a thought you have after looking at the list rather than before.
					 */
					footer={
						<button
							type="button"
							onClick={() => {
								openScopedPanel("files", companionOf("files"), screen ?? undefined);
								menu.close();
							}}
							className="flex w-full items-center gap-1.5 px-3 py-2 text-detail text-ink-muted transition-colors duration-[var(--ly-t-quick)] hover:bg-card-hover hover:text-ink"
						>
							<PanelLeft size={12} strokeWidth={1.8} className="shrink-0 text-ink-faint" />
							{t("fileTitle.openInPanel")}
						</button>
					}
				>
					<div className="flex flex-col" style={{ height: TREE_HEIGHT }}>
						{folders.length > 0 ? (
							<FileTree
								roots={folders}
								openPath={path}
								onOpen={(entry) => {
									/*
									 * 这一格还空着，或者它在面板窗口里（那里只有它一格），文件就进这一格；
									 * 不然和树上点一样，开成顶上的一个标签。
									 */
									if (empty || !screen) void useOpenFile.getState().open(slot, entry);
									else void openFilePane(entry, screen);
									/*
									 * Picking a file is the end of the errand, so the tree goes away.
									 *
									 * Expanding a folder is not — `FileTree` toggles directories itself and
									 * never calls this for one — so browsing down to a file leaves the tree
									 * up the whole way and closes once on the file itself.
									 */
									menu.close();
								}}
								onMoved={(from, to) => useOpenFile.getState().moved(from, to)}
								onRemoved={(paths) => useOpenFile.getState().removed(paths)}
							/>
						) : (
							<p className="px-3 py-6 text-center text-detail text-ink-faint">{t("fileTitle.needProject")}</p>
						)}
					</div>
				</Popover>
			)}
		</>
	);
}

/**
 * Is the file tree on screen right now?
 *
 * Subscribed rather than computed once: every input can change while this pane stays mounted —
 * closing the tree, maximising this one, dragging the window narrow enough to collapse the dock.
 */
function useTreeOnScreen(): boolean {
	// Asked of the screen this file pane is in — the tree beside it, not one in another conversation.
	return usePaneOnScreen("files");
}

/**
 * 这个文件所在的目录，一段一段写出来，每段后面一个 `›`，接着就是文件名。
 *
 * 在项目的某个源文件夹里就从那个文件夹的名字写起；不在的（附件、导出的记录）写它所在的目录，
 * 家目录缩成 `~`。
 */
function FileDirs({ folders, path }: { folders: string[]; path: string | null }) {
	if (!path) return null;
	const dir = parentOf(path);
	const root = folders.find((folder) => isDescendantPath(folder, path));
	const dirs = root
		? [baseName(root), ...(dir === root ? [] : relativeTo(root, dir).split(/[\\/]/))]
		: tildeHome(dir).split(/[\\/]/).filter(Boolean);
	return (
		<span className="flex min-w-0 items-center gap-1 py-0.5 pl-1 text-detail text-ink-muted">
			{dirs.map((dir, at) => (
				<Fragment key={at}>
					<span className="min-w-0 truncate">{dir}</span>
					<ChevronRight size={11} strokeWidth={2} className="shrink-0 text-ink-faint" />
				</Fragment>
			))}
		</span>
	);
}
