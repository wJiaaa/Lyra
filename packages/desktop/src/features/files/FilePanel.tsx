/**
 * The open file, as a pane of its own.
 *
 * It used to be the right-hand half of the file browser, which meant it could only ever be beside
 * the tree, at whatever width was left over, and it disappeared the moment you put the tree away.
 * As a pane it goes wherever the file does: under the tree, across the window, full screen while
 * you read something long, or in the corner while the conversation has the room.
 *
 * All it does is choose between four states. What a file *looks like* is `FileViewer`'s problem,
 * and which file this pane shows is the store's.
 */

import { translate } from "../../i18n/translate.ts";
import { FileText } from "../../ui/icons/index.ts";
import { FileViewer } from "./FileViewer.tsx";
import { PanelEmpty } from "../../ui/layout/PanelEmpty.tsx";
import { usePaneFile } from "./pane-file.tsx";

export function FilePanel() {
	const path = usePaneFile((s) => s.path);
	const name = usePaneFile((s) => s.name);
	const contents = usePaneFile((s) => s.contents);
	const loading = usePaneFile((s) => s.loading);
	const opening = usePaneFile((s) => s.opening);

	if (!path && !opening) {
		return (
			<PanelEmpty icon={FileText} title={translate("dock.fileContents")}>
				{translate("filePanel.pickOne")}
			</PanelEmpty>
		);
	}

	/*
	 * 「读取中」 only when there is genuinely nothing to show — the very first file.
	 *
	 * Switching this pane to another file keeps the previous one on screen until the next has
	 * arrived, which on a local disk is a few milliseconds. Unmounting the viewer for that interval
	 * is what made every switch flash: the placeholder has none of the code theme's colours, so the pane
	 * went warm, white, warm.
	 */
	if (loading && !contents) return <p className="ly-pulse p-6 text-center text-detail text-ink-faint">{translate("common.loadingShort")}</p>;
	if (!contents || !path) return <p className="p-6 text-center text-detail text-ink-faint">{translate("filePanel.unreadable")}</p>;

	return (
		<FileViewer
			/*
			 * Deliberately not keyed on the path.
			 *
			 * It used to be, to give each file a fresh editor rather than one inheriting the last
			 * file's state — and that is a real requirement, but this was the wrong place to meet it. Re-keying here unmounts the *whole pane* on every switch: the header
			 * and the viewer all torn down and rebuilt, which is a visible blank frame
			 * between two files. Measured at six unmounts for six switches.
			 *
			 * `CodeEditor` already rebuilds its own state when `path` changes — see the effect keyed
			 * `[path]` — so nothing carries over without anything leaving the document.
			 * The viewers that genuinely need a reset (zoom, sheet scroll) carry their own key.
			 */
			path={path}
			name={name ?? path}
			contents={contents}
		/>
	);
}
