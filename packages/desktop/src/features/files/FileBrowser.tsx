/**
 * The project's files: the tree, and nothing else.
 *
 * Opening one hands it to a `file` pane rather than showing it here. The two used to be halves
 * of this component — a tree on the left, the file on the right, with a breakpoint that stacked
 * them and a draggable seam between them. All of that was this component reimplementing, badly and
 * for two panes only, what the dock now does for every pane: split either way, drag the boundary,
 * put one away, make one full screen.
 *
 * What the tree contains, what right-clicking it offers and what happens to a file when you rename
 * it all live in `files/`.
 */

import { translate } from "../../i18n/translate.ts";
import { Folder } from "../../ui/icons/index.ts";
import { openFilePane } from "../dock/index.ts";
import { FileTree } from "./FileTree.tsx";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { useDockScope, useScopedWorkspace } from "../../app/session-scope.tsx";
import { useProjectFolders } from "../../store/project-folders.ts";
import { useOpenFile } from "../../store/openFile.ts";

export function FileBrowser() {
	/*
	 * The project of the screen this panel is in.
	 *
	 * The live slot's is the focused screen's: opened beside it, the panel listed the focused
	 * conversation's project, and followed focus from one screen to the other.
	 */
	const { workspace } = useScopedWorkspace();
	// And the file pane it hands a file to opens in this screen too, named rather than found by focus.
	const screen = useDockScope();
	const openPath = useOpenFile((s) => s.last);
	// Every folder the project names, not only the one sessions run in — see `useProjectFolders`.
	const folders = useProjectFolders(workspace);

	/*
	 * Letting go of the last project's file is not this pane's job — see `useProjectFiles` in
	 * `App.tsx`. It used to be done here, in an effect that only ran while this pane was mounted, so
	 * closing the tree and then changing projects left the editor holding a file from the old one.
	 */

	if (!workspace || folders.length === 0) {
		return (
			<PanelEmpty icon={Folder} title={translate("common.files")}>
				{translate("fileBrowser.needProject")}
			</PanelEmpty>
		);
	}

	return (
		<FileTree
			roots={folders}
			openPath={openPath}
			onOpen={(entry) => {
				/*
				 * A file already open in a tab is switched to rather than opened twice, and a closed file
				 * pane is brought back by the click that needs it — see `openFilePane`.
				 */
				void openFilePane(entry, screen ?? undefined);
			}}
			onMoved={(from, to) => useOpenFile.getState().moved(from, to)}
			onRemoved={(paths) => useOpenFile.getState().removed(paths)}
		/>
	);
}
