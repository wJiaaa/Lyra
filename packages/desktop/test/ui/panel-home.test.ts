/**
 * A panel leaving for a window of its own, and coming home.
 *
 * Coming home is a person pressing 「收回」, so it always lands — back in the tab position it left
 * from. A home record is never deleted before the pane is really in a tree, and a window that could
 * not be created hands its pane straight back, without undoing anything done in the meantime.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { popOutPanel, provideScope, restoredHomeTree, usePanelWindows, watchPanelWindows } from "../../src/features/dock/popout.ts";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { panelsOf } from "../../src/features/dock/tabs.ts";
import { defaultTree, has, insert, leafOf, remove } from "../../src/features/dock/tree.ts";

function reset() {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, host: null });
	usePanelWindows.setState({ panels: [], opening: [] });
	provideScope(() => "s");
}

/** Coming back may first bring its conversation on screen, so it finishes a tick later. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const tabs = () => panelsOf(usePaneDock.getState().tree("s"));

/** A main window whose 「收回」 can be pressed from the test. */
function windows(panels: { kind: string; scope: string }[] = []) {
	let restore = (_input: { kind: string; scope: string }) => {};
	const closed: unknown[] = [];
	const opened: unknown[] = [];
	Reflect.set(window, "plume", { windows: {
		list: async () => ({ panels }),
		onChanged: () => () => {},
		onRestorePanel: (listener: typeof restore) => { restore = listener; return () => {}; },
		closePanel: async (input: unknown) => { closed.push(input); return { ok: true }; },
		openPanel: async (input: unknown) => { opened.push(input); return { ok: true }; },
	} });
	return { restore: (input: { kind: string; scope: string }) => restore(input), closed, opened };
}

test("the exact tab order comes back only while nothing else changed", () => {
	let before = insert(leafOf("conversation"), "terminal", { kind: "conversation", side: "right" });
	before = insert(before, "browser", { kind: "terminal", side: "right" });
	const rest = remove(before, "browser");
	const home = { before, rest };
	assert.deepEqual(restoredHomeTree(home, rest, "browser"), before);
	const changed = insert(rest, "files", { kind: "terminal", side: "right" });
	assert.equal(restoredHomeTree(home, changed, "browser"), null, "intervening user changes must not be overwritten");
	assert.equal(restoredHomeTree({ before: { broken: true }, rest }, rest, "browser"), null);
});

test("a window that could not be created hands its pane straight back", async () => {
	reset();
	Reflect.set(window, "plume", { windows: { openPanel: async () => { throw new Error("native window refused"); } } });
	usePaneDock.getState().open("s", "terminal");
	const before = usePaneDock.getState().tree("s");
	await assert.rejects(popOutPanel({ scope: "s", kind: "terminal", sessionId: "s" }), /native window refused/);
	assert.equal(usePaneDock.getState().tree("s"), before);
	assert.equal(usePanelWindows.getState().opening.length, 0);
	assert.deepEqual(JSON.parse(window.localStorage.getItem("dw:homes") ?? "{}"), {});
});

test("handing it back does not undo a panel opened during the handoff", async () => {
	reset();
	const result = Promise.withResolvers<{ ok: boolean }>();
	Reflect.set(window, "plume", { windows: { openPanel: () => result.promise } });
	usePaneDock.getState().open("s", "browser");
	usePaneDock.getState().open("s", "terminal");
	const transfer = popOutPanel({ scope: "s", kind: "browser", sessionId: "s" });
	usePaneDock.getState().open("s", "files");
	usePaneDock.getState().close("s", "terminal");
	result.resolve({ ok: false });
	assert.equal(await transfer, false);
	assert.deepEqual(tabs(), ["browser", "files"], "back in front, and what changed meanwhile kept");
	assert.equal(usePanelWindows.getState().opening.length, 0);
});

test("coming home lands in the tab position it left from, even after the row changed", async () => {
	reset();
	const { restore, closed } = windows([{ kind: "terminal", scope: "s" }]);
	const dock = usePaneDock.getState();
	for (const kind of ["browser", "terminal", "files"] as const) dock.open("s", kind);
	dock.rememberSize("s", { width: 1200, height: 800 });
	Reflect.set(window.plume.windows, "openPanel", async () => ({ ok: true }));
	assert.equal(await popOutPanel({ scope: "s", kind: "terminal", sessionId: "s" }), true);
	assert.deepEqual(tabs(), ["browser", "files"]);
	dock.open("s", "review");

	const stop = watchPanelWindows();
	try {
		await settled();
		restore({ kind: "terminal", scope: "s" });
		await settled();
		assert.deepEqual(tabs(), ["browser", "terminal", "files", "review"]);
		assert.equal(closed.length, 1, "the floating window closes once its pane is home");
		assert.equal(window.localStorage.getItem("dw:homes")?.includes("s:terminal"), false);
	} finally { stop(); }
});

test("a home written by an older version, with no tab position, still lands — last", async () => {
	reset();
	const { restore, closed } = windows([{ kind: "file", scope: "s" }]);
	// What a split-layout version wrote: an edge of a neighbour that has since been closed.
	const rest = insert(defaultTree(), "files", { kind: "conversation", side: "right" });
	const home = { scope: "s", at: { kind: "files", side: "bottom" }, before: insert(rest, "file", { kind: "files", side: "bottom" }), rest };
	window.localStorage.setItem("dw:homes", JSON.stringify({ "s:file": home }));
	usePaneDock.setState({ trees: { s: insert(defaultTree(), "terminal", { kind: "conversation", side: "right" }) } });
	usePaneDock.getState().rememberSize("s", { width: 1200, height: 800 });
	const stop = watchPanelWindows();
	try {
		await settled();
		restore({ kind: "file", scope: "s" });
		await settled();
		assert.deepEqual(tabs(), ["terminal", "file"]);
		assert.equal(closed.length, 1, "the window closes only because the pane really is home");
		assert.equal(JSON.parse(window.localStorage.getItem("dw:homes") ?? "{}")["s:file"], undefined);
	} finally { stop(); }
});

test("a panel left detached at quit comes back into its conversation, without opening a window", async () => {
	reset();
	const { opened } = windows();
	const rest = defaultTree();
	const before = insert(rest, "terminal", { kind: "conversation", side: "right" });
	window.localStorage.setItem("dw:homes", JSON.stringify({ "s:terminal": { scope: "s", index: 0, before, rest } }));
	usePaneDock.getState().rememberSize("s", { width: 500, height: 350 });
	const stop = watchPanelWindows();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(opened, [], "a cold start does not create windows nobody asked for");
	assert.equal(has(usePaneDock.getState().tree("s"), "terminal"), true);
	assert.equal(JSON.parse(window.localStorage.getItem("dw:homes") ?? "{}")["s:terminal"], undefined);
	stop();
});
