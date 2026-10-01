/**
 * Remembering the tiled conversations, per window.
 *
 * Per window because two renderers share `localStorage` — a second window writing the primary's
 * key would steal its layout the next time it loaded. Not per project: a window may tile
 * conversations from four repositories, and focusing one of them must not reload a different tree.
 *
 * Everything that comes back out is treated as hostile. See `sift`.
 */

import { defaultTree, sift, type SplitNode } from "./tree.ts";

const VERSION = 1;
const SAVE_DELAY = 120;

export const storageKey = (windowId: string): string => `ly:split:${windowId}`;

interface Stored {
	version: number;
	tree: unknown;
	focused: string | null;
}

function parse(raw: string | null): { tree: SplitNode; focused: string | null } | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Stored;
		if (parsed.version !== VERSION) return null;
		const tree = sift(parsed.tree) ?? defaultTree();
		const focused = typeof parsed.focused === "string" ? parsed.focused : null;
		return { tree, focused };
	} catch {
		return null;
	}
}

export function loadSplit(windowId: string): { tree: SplitNode; focused: string | null } {
	try {
		return parse(localStorage.getItem(storageKey(windowId))) ?? { tree: defaultTree(), focused: null };
	} catch {
		return { tree: defaultTree(), focused: null };
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { windowId: string; tree: SplitNode; focused: string | null } | null = null;
let held = 0;

/**
 * Keep the last tree in memory and write it once, when the handle is released.
 *
 * A drag updates shares every frame. Stringifying that into `localStorage` sixty times a
 * second is work the user cannot see, and it contends with the same main thread that is
 * trying to keep the panes on the pointer.
 */
export function holdSplitPersist(): () => void {
	held++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		held--;
		if (held > 0) return;
		flushSplit();
	};
}

export function saveSplit(windowId: string, tree: SplitNode, focused: string | null): void {
	pending = { windowId, tree, focused };
	if (held > 0) return;
	clearTimeout(timer);
	timer = setTimeout(flushSplit, SAVE_DELAY);
}

export function flushSplit(): void {
	clearTimeout(timer);
	const next = pending;
	pending = null;
	if (!next) return;
	try {
		const payload: Stored = { version: VERSION, tree: next.tree, focused: next.focused };
		localStorage.setItem(storageKey(next.windowId), JSON.stringify(payload));
	} catch {
		// A layout that cannot be remembered is not worth failing a session over.
	}
}
