/**
 * Right-clicking inside the code editor.
 *
 * Electron ships no default context menu, so until now right-clicking in a file did nothing —
 * not even copy. Everything here is a CodeMirror command driven from the outside, except copy,
 * which goes through the main process (`bridge.clipboard`). The editor is a read-only preview, so
 * nothing here changes the document.
 */

import { useI18n } from "../../i18n/index.ts";
import { selectAll } from "@codemirror/commands";
import { foldAll, unfoldAll } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import {
	ChevronsDownUp,
	ChevronsUpDown,
	Copy,
	CornerUpRight,
	Link2,
	ListOrdered,
	Search,
	TextSelect,
} from "lucide-react";

import { useRevealLabel } from "../../store/open-targets.ts";
import { ContextMenu } from "../../ui/overlay/ContextMenu.tsx";
import { MenuItem, MenuSeparator } from "../../ui/overlay/Menu.tsx";
import { bridge } from "../../services/index.ts";

const ICON = { size: 13, strokeWidth: 1.8 } as const;

export function EditorMenu({
	anchor,
	onClose,
	view,
	path,
	/** Opens CodeMirror's find bar. */
	onFind,
}: {
	anchor: { x: number; y: number } | null;
	onClose: () => void;
	view: EditorView | null;
	path: string;
	onFind: () => void;
}) {
	const { t } = useI18n();
	// Before the early return: a hook that only sometimes runs is a hook that runs out of order.
	const reveal = useRevealLabel();
	if (!view) return null;

	const selection = view.state.selection.main;
	const selected = view.state.sliceDoc(selection.from, selection.to);
	const hasSelection = selected.length > 0;

	const copy = async () => {
		if (!hasSelection) return;
		await bridge.clipboard.write(selected);
		view.focus();
	};

	/** Run a CodeMirror command and hand the keyboard back, which a menu click has taken away. */
	const run = (command: (target: EditorView) => boolean) => {
		command(view);
		view.focus();
	};

	return (
		<ContextMenu anchor={anchor} onClose={onClose} width="default">
			<MenuItem icon={<Copy {...ICON} />} hint="⌘C" disabled={!hasSelection} onClick={() => void copy()}>
				{t("common.copy")}
			</MenuItem>
			<MenuItem icon={<TextSelect {...ICON} />} hint="⌘A" onClick={() => run(selectAll)}>
				{t("common.selectAll")}
			</MenuItem>

			<MenuSeparator />

			<MenuItem icon={<Search {...ICON} />} hint="⌘F" onClick={onFind}>
				{t("find.find")}
			</MenuItem>
			{/* ⌥⌘G is CodeMirror's own binding for this, from `searchKeymap`. */}
			<MenuItem icon={<ListOrdered {...ICON} />} hint="⌥⌘G" onClick={() => run(gotoLine)}>
				{t("common.goToLine")}
			</MenuItem>

			<MenuSeparator />

			<MenuItem icon={<ChevronsDownUp {...ICON} />} onClick={() => run(foldAll)}>
				{t("fileMenu.collapseAll")}
			</MenuItem>
			<MenuItem icon={<ChevronsUpDown {...ICON} />} onClick={() => run(unfoldAll)}>
				{t("common.expandAll")}
			</MenuItem>

			<MenuSeparator />

			<MenuItem icon={<Link2 {...ICON} />} onClick={() => void bridge.clipboard.write(path)}>
				{t("fileMenu.copyPath")}
			</MenuItem>
			<MenuItem icon={<CornerUpRight {...ICON} />} onClick={() => void bridge.workspace.reveal(path)}>
				{reveal}
			</MenuItem>
		</ContextMenu>
	);
}
