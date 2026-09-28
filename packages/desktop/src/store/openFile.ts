/**
 * Which file each file pane is showing.
 *
 * Its own store because the file and the tree are two panes now, and a pane cannot hold state its
 * sibling needs. It used to live inside the file browser, which was the right place while the
 * browser *was* both halves — the tree on the left, the file on the right, one component owning
 * the pair. Splitting them into panes that can be moved, resized and closed independently means
 * the thing they share has to sit outside both.
 *
 * Memory only, like the terminal's scrollback: the dock remembers that the pane was open and the
 * pane comes back empty.
 *
 * One file per pane. Several files are several panes — tabs in the dock's own strip, not a strip
 * inside the pane; `openFilePane` in the dock decides which pane a file goes to.
 */

import { create } from "zustand";
import type { FileContents, FileEntry } from "../../electron/ipc-types.ts";
import { baseName, isDescendantPath } from "../lib/paths.ts";
import { bridge } from "../services/index.ts";

/** What one file pane is showing. */
export interface OpenFile {
	path: string | null;
	/** The file's own name, so the pane can be titled before its contents arrive. */
	name: string | null;
	contents: FileContents | null;
	/**
	 * A file whose read is in flight, which is not the same as the file on screen.
	 *
	 * The two used to be one field, and switching files flickered because of it: `path` moved to the
	 * new file immediately while `contents` still held the old one, and the panel — seeing
	 * `loading` — threw the whole viewer away for a centred 「读取中…」 on a plain white page. A
	 * local file reads in a few milliseconds, so what that produced was one frame of white between
	 * two themed ones.
	 *
	 * Kept apart so the tab can be named after the click instantly while the content area holds
	 * what it has until the replacement is ready. `path` and `contents` now change together, and
	 * there is no moment when they describe different files.
	 */
	opening: string | null;
	loading: boolean;
}

const EMPTY: OpenFile = { path: null, name: null, contents: null, loading: false, opening: null };

/**
 * 一格文件面板在这份表里的键：哪一屏的哪一格。
 *
 * 每个打开的文件是顶上那排标签里的一个（`file`、`file:<id>`，见 `lib/panel-instance.ts`），各看各的
 * 文件。kind 只在一屏里唯一——每一屏都可以有自己的 `file`——所以连着屏一起认。面板窗口没有屏，
 * 那里只有它自己这一格。
 */
export function fileSlot(scope: string | null, kind: string): string {
	return `${scope ?? "@window"}#${kind}`;
}

export function openFileOf(state: Pick<OpenFileState, "files">, slot: string): OpenFile {
	return state.files[slot] ?? EMPTY;
}

interface OpenFileState {
	/** Every file pane's file, by `fileSlot`. */
	files: Record<string, OpenFile>;
	/** The file opened last, anywhere — what the tree marks as open. */
	last: string | null;
	/**
	 * Wrap long lines, and show Markdown source rather than the rendered page.
	 *
	 * Up here because the controls for them are in the pane's header now, which is outside the
	 * viewer they act on. Not per file: they are how *you* want to read, not properties of what is
	 * being read, and having to re-set them on every file would be the setting asking permission to
	 * work each time.
	 */
	wrap: boolean;
	showSource: boolean;
	setWrap(wrap: boolean): void;
	setShowSource(showSource: boolean): void;

	/** Show this file in that pane, replacing whatever it showed. */
	open(slot: string, entry: Pick<FileEntry, "path" | "name">): Promise<void>;
	/**
	 * A rename or a move the open files have to survive.
	 *
	 * By path, and silently wrong if ignored: a pane would go on showing a file at an address
	 * that no longer exists. Folders count too —
	 * renaming `src` moves everything under it, including whatever is open.
	 */
	moved(from: string, to: string): void;
	removed(paths: string[]): void;
	/** Forget one pane's file — the pane was closed for good. */
	drop(slot: string): void;
	/** Let go of everything. Used when the project changes: the paths belong to the old one. */
	clear(): void;
}

export const useOpenFile = create<OpenFileState>((set, get) => {
	const patch = (slot: string, next: Partial<OpenFile>) =>
		set((state) => ({ files: { ...state.files, [slot]: { ...openFileOf(state, slot), ...next } } }));

	return {
		files: {},
		last: null,
		wrap: false,
		showSource: false,

		setWrap: (wrap) => set({ wrap }),
		setShowSource: (showSource) => set({ showSource }),

		async open(slot, entry) {
			/*
			 * The tab updates now; the content area updates when there is something to put in it.
			 *
			 * Swapping `path` here as well would leave the viewer rendering the previous file's text
			 * under the new file's name until the read landed — and the panel, told it was loading,
			 * would instead unmount the viewer entirely and flash a white 「读取中…」 between two
			 * themed frames. That is the flicker.
			 */
			patch(slot, { opening: entry.path, loading: true });
			try {
				const read = await bridge.files.read(entry.path);
				// A second open into this pane while this was in flight wins.
				if (openFileOf(get(), slot).opening !== entry.path) return;
				// Together, so the pane never shows one file's name over another file's contents.
				patch(slot, { path: entry.path, name: entry.name, contents: read });
				set({ last: entry.path, showSource: false });
			} finally {
				if (openFileOf(get(), slot).opening === entry.path) patch(slot, { loading: false, opening: null });
			}
		},

		moved(from, to) {
			const follow = (path: string) =>
				path === from ? to : isDescendantPath(from, path) ? to + path.slice(from.length) : path;

			const reopen: [string, string][] = [];
			const files: Record<string, OpenFile> = {};
			for (const [slot, file] of Object.entries(get().files)) {
				const path = file.path ? follow(file.path) : null;
				const opening = file.opening ? follow(file.opening) : null;
				files[slot] = { ...file, ...(path !== file.path && path ? { path, name: baseName(path) } : {}), opening };
				if (opening && opening !== file.opening) reopen.push([slot, opening]);
			}
			const last = get().last;
			set({ files, last: last ? follow(last) : null });
			for (const [slot, path] of reopen) void get().open(slot, { path, name: baseName(path) });
		},

		removed(paths) {
			const gone = (path: string) => paths.some((each) => path === each || isDescendantPath(each, path));
			const files: Record<string, OpenFile> = {};
			for (const [slot, file] of Object.entries(get().files)) {
				files[slot] = file.path && gone(file.path) ? EMPTY : file.opening && gone(file.opening) ? { ...file, opening: null, loading: false } : file;
			}
			const last = get().last;
			set({ files, last: last && gone(last) ? null : last });
		},

		drop(slot) {
			if (!(slot in get().files)) return;
			const files = { ...get().files };
			delete files[slot];
			set({ files });
		},

		clear: () => set({ files: {}, last: null }),
	};
});
