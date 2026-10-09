import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { closePane, emptyDockTree, usePaneDock } from "../src/features/dock/pane-store.ts";
import { has, leafOf, type DockNode } from "../src/features/dock/tree.ts";
import { insertTab, panelsOf } from "../src/features/dock/tabs.ts";
import { toggleScopedPanel } from "../src/features/dock/popout.ts";

function resetPaneDock(): void {
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, leaving: {}, host: null });
}

test("opening a panel is local to that conversation screen", () => {
	resetPaneDock();
	usePaneDock.getState().open("a", "browser");
	assert.equal(has(usePaneDock.getState().tree("a"), "browser"), true);
	assert.equal(has(usePaneDock.getState().tree("b"), "browser"), false);
	assert.equal(has(emptyDockTree, "browser"), false);
});

test("closing the last panel returns the screen to a lone conversation", () => {
	resetPaneDock();
	usePaneDock.getState().open("a", "terminal");
	usePaneDock.getState().close("a", "terminal");
	assert.deepEqual(usePaneDock.getState().tree("a"), emptyDockTree);
	assert.equal("a" in usePaneDock.getState().trees, true, "an empty loaded dock must not be confused with an unread one");
});

test("toggle puts a panel away when it is already on that screen", () => {
	resetPaneDock();
	toggleScopedPanel("a", "review");
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), true);
	toggleScopedPanel("a", "review");
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), false);
});

/** A screen on show: `closePane` only defers to the slide when something is there to draw it. */
function onScreen(scope: string): void {
	usePaneDock.getState().rememberSize(scope, { width: 1164, height: 800 });
}

test("closing the last panel by hand marks it leaving and keeps it open until the slide closes it", () => {
	resetPaneDock();
	onScreen("a");
	usePaneDock.getState().open("a", "terminal");
	closePane("a", "terminal");
	assert.equal(usePaneDock.getState().leaving.a, "terminal");
	assert.equal(has(usePaneDock.getState().tree("a"), "terminal"), true, "the panel has to stay mounted to be drawn leaving");
	usePaneDock.getState().close("a", "terminal");
	assert.equal(usePaneDock.getState().leaving.a, undefined, "closing for real ends the leaving");
});

test("only the last panel leaves; any other, or a screen not on show, closes at once", () => {
	resetPaneDock();
	onScreen("a");
	usePaneDock.getState().open("a", "terminal");
	usePaneDock.getState().open("a", "files");
	closePane("a", "terminal");
	assert.equal(has(usePaneDock.getState().tree("a"), "terminal"), false);
	assert.equal(usePaneDock.getState().leaving.a, undefined);

	usePaneDock.getState().open("b", "terminal");
	closePane("b", "terminal");
	assert.equal(has(usePaneDock.getState().tree("b"), "terminal"), false, "nobody would ever finish a slide for a screen that is not drawn");
});

test("asking for the leaving panel again keeps it; asking for another still closes the leaving one", () => {
	resetPaneDock();
	onScreen("a");
	usePaneDock.getState().open("a", "terminal");
	closePane("a", "terminal");
	usePaneDock.getState().open("a", "terminal");
	assert.equal(usePaneDock.getState().leaving.a, undefined);
	assert.equal(has(usePaneDock.getState().tree("a"), "terminal"), true);

	closePane("a", "terminal");
	usePaneDock.getState().open("a", "files");
	assert.equal(usePaneDock.getState().leaving.a, undefined);
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["files"], "the one just closed must not linger as a background tab");
});

test("in the narrow layout a panel hidden behind the conversation is brought forward, not closed", () => {
	resetPaneDock();
	usePaneDock.getState().open("a", "review");
	usePaneDock.getState().focus("a", "conversation");
	toggleScopedPanel("a", "review", { compact: true });
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), true, "pressing its button asked to see it");
	assert.equal(usePaneDock.getState().focused.a, "review");
	toggleScopedPanel("a", "review", { compact: true });
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), false, "and pressed again while in front, it goes");
});

test("a new panel is the last tab, and one already open is brought forward rather than added", () => {
	resetPaneDock();
	const dock = usePaneDock.getState();
	for (const kind of ["browser", "terminal", "files"] as const) assert.equal(dock.open("a", kind), true);
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["browser", "terminal", "files"]);
	dock.open("a", "browser");
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["browser", "terminal", "files"], "no second browser");
	assert.equal(usePaneDock.getState().tab.a, "browser", "it is the one in front");
});

test("a panel coming home can ask for its old place in the row of tabs", () => {
	resetPaneDock();
	const dock = usePaneDock.getState();
	for (const kind of ["browser", "terminal"] as const) dock.open("a", kind);
	dock.open("a", "files", 1);
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["browser", "files", "terminal"]);
	dock.open("a", "review", 0);
	dock.open("a", "tasks", 99);
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["review", "browser", "files", "terminal", "tasks"]);
});

test("insertTab keeps the order however the stored tree happens to be shaped", () => {
	// A layout saved before panels were tabs: a column of two beside the conversation.
	const stored: DockNode = {
		type: "split",
		dir: "row",
		children: [leafOf("conversation"), { type: "split", dir: "col", children: [leafOf("browser"), leafOf("terminal")], sizes: [0.5, 0.5] }],
		sizes: [0.7, 0.3],
	};
	assert.deepEqual(panelsOf(insertTab(stored, "files")), ["browser", "terminal", "files"]);
	assert.deepEqual(panelsOf(insertTab(stored, "files", 1)), ["browser", "files", "terminal"]);
	assert.deepEqual(panelsOf(insertTab(leafOf("conversation"), "files")), ["files"]);
});

test("every screen's title bar is handed to its dock, so it covers the transcript and never a panel", async () => {
	const pane = fileURLToPath(new URL("../src/features/split/SplitPane.tsx", import.meta.url));
	const dock = fileURLToPath(new URL("../src/features/dock/DockView.tsx", import.meta.url));
	const paneSrc = await readFile(pane, "utf8");
	const dockSrc = await readFile(dock, "utf8");
	const surfaceSrc = await readFile(new URL("../src/features/dock/DockPane.tsx", import.meta.url), "utf8");
	// Single screen too: there is no window-level title bar that panels could fall under.
	assert.match(paneSrc, /header=\{\(room: ScreenInsets, after\?: ReactNode\) => <SplitChrome/);
	assert.doesNotMatch(paneSrc, /screen \? <SplitChrome/);
	assert.match(surfaceSrc, /data-ly-pane-slot=\{customHeader \? "conversation"/);
	assert.match(dockSrc, /\{header\(\{ start: cardRoom\(inset\), end: cardRoom\(insetEnd\) \}, unfoldButton\)\}/);
});
