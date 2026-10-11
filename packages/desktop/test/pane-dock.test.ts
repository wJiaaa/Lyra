import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { closePane, emptyDockTree, usePaneDock } from "../src/features/dock/pane-store.ts";
import { has, leafOf, type DockNode } from "../src/features/dock/tree.ts";
import { insertTab, panelsOf } from "../src/features/dock/tabs.ts";
import { showScopedPanel, sideChatFor, usePanelWindows } from "../src/features/dock/popout.ts";

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

test("按钮和快捷键只开不关：只能开一个的再按一次还开着", () => {
	resetPaneDock();
	showScopedPanel("a", "review");
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), true);
	showScopedPanel("a", "review");
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["review"], "没关，也没多出一格");
});

test("能开好几个的，每按一次再开一格；最早那一格弹出去了也算占着", () => {
	resetPaneDock();
	showScopedPanel("a", "terminal");
	showScopedPanel("a", "terminal");
	const open = panelsOf(usePaneDock.getState().tree("a"));
	assert.equal(open.length, 2);
	assert.equal(open[0], "terminal");
	assert.match(open[1]!, /^terminal:[a-z0-9]+$/);

	resetPaneDock();
	usePanelWindows.setState({ panels: [{ kind: "chat", scope: "a" }], opening: [] });
	try {
		showScopedPanel("a", "chat");
		const chats = panelsOf(usePaneDock.getState().tree("a"));
		assert.equal(chats.length, 1);
		assert.match(chats[0]!, /^chat:[a-z0-9]+$/, "弹出去的那个 `chat` 不能在右栏再画一份");
	} finally { usePanelWindows.setState({ panels: [], opening: [] }); }
});

test("划词去侧边聊天：前台是侧边聊天就接着用它，否则新开一格；`/btw` 总是新开", () => {
	resetPaneDock();
	const first = sideChatFor("a", true);
	assert.equal(first, DEFAULT_SIDE_CHAT_ID, "一格都没有时开的是最早那一格");
	assert.deepEqual(panelsOf(usePaneDock.getState().tree("a")), ["chat"]);

	assert.equal(sideChatFor("a", true), DEFAULT_SIDE_CHAT_ID, "前台就是它，接着用，不多开");
	assert.equal(panelsOf(usePaneDock.getState().tree("a")).length, 1);

	const fresh = sideChatFor("a", false);
	assert.ok(fresh && fresh !== DEFAULT_SIDE_CHAT_ID, "`/btw` 不接进正在聊的那一格");
	assert.equal(panelsOf(usePaneDock.getState().tree("a")).length, 2);
	assert.equal(usePaneDock.getState().tab.a, `chat:${fresh}`, "新开的那一格到前台");

	usePaneDock.getState().open("a", "terminal");
	const beside = sideChatFor("a", true);
	assert.ok(beside && beside !== DEFAULT_SIDE_CHAT_ID && beside !== fresh, "前台是终端时不去翻后台的侧边聊天，新开一格");
	assert.equal(usePaneDock.getState().tab.a, `chat:${beside}`);
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
	showScopedPanel("a", "review");
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), true, "pressing its button asked to see it");
	assert.equal(usePaneDock.getState().focused.a, "review");
	showScopedPanel("a", "review");
	assert.equal(has(usePaneDock.getState().tree("a"), "review"), true, "pressed again while in front, it stays");
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
