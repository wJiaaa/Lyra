import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, useLayoutEffect } from "react";
import { Terminal } from "lucide-react";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
import { flushTree, paneStorageKey, writeTree } from "../../src/features/dock/persist.ts";
import { leafOf } from "../../src/features/dock/tree.ts";
import { mount } from "../helpers/mount.ts";

/** One screen, the way `SplitPane` draws it: the conversation's own title bar, then its body. */
function screen(scope: string, children: React.ReactNode, header: () => React.ReactNode = () => null) {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin" } });
	return h(LayoutProvider, { children: h(DockView, { scope, header, children }) });
}

test("opening and closing a panel retains the conversation's DOM", async () => {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	const unregister = registerPanels([{
		kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "",
		render: () => h("input", { "data-test-terminal": "", defaultValue: "shell scrollback" }),
	}]);
	const view = await mount(screen("retain", h("textarea", { "data-test-chat": "" }), () => h("header", { "data-test-chrome": "" })));
	try {
		const conversation = view.find("[data-test-chat]");
		assert.equal(view.find("[data-test-chrome]").closest('[data-ly-pane-slot="conversation"]'), conversation.closest('[data-ly-pane-slot="conversation"]'));
		await act(() => { usePaneDock.getState().open("retain", "terminal"); });
		assert.ok(view.find("[data-test-chat]") === conversation, "opening a panel remounted the composer");
		assert.ok(view.find("[data-test-terminal]"));
		await act(() => { usePaneDock.getState().close("retain", "terminal"); });
		assert.ok(view.find("[data-test-chat]") === conversation, "closing a panel remounted the composer");
	} finally {
		await view.unmount();
		unregister();
		Reflect.deleteProperty(window, "plume");
	}
});

/*
 * The conversation restores its scroll position in a layout effect, and children's layout effects
 * run before `DockView`'s own `hydrate`. If the commit that switches to a conversation still drew
 * the bare layout, the transcript was measured at full width and its position clamped there before
 * the stored panel came back and narrowed the column.
 */
test("switching to a conversation lays out its stored panels in the same commit", async () => {
	window.localStorage.clear();
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, host: null });
	const unregister = registerPanels([{
		kind: "terminal", label: "common.terminal", icon: Terminal, shortcut: "",
		render: () => h("input", { "data-test-terminal": "" }),
	}]);
	writeTree(paneStorageKey("with-panel"), { type: "split", dir: "row", children: [leafOf("conversation"), leafOf("terminal")], sizes: [0.6, 0.4] });
	flushTree();
	const seen: [string, boolean][] = [];
	function Transcript({ scope }: { scope: string }) {
		useLayoutEffect(() => {
			seen.push([scope, Boolean(document.querySelector("[data-test-terminal]"))]);
		}, [scope]);
		return null;
	}
	const view = await mount(screen("bare", h(Transcript, { scope: "bare" })));
	try {
		await view.rerender(screen("with-panel", h(Transcript, { scope: "with-panel" })));
		assert.deepEqual(seen.find(([scope]) => scope === "with-panel"), ["with-panel", true], "the transcript's first layout effect ran against the bare layout");
	} finally {
		await view.unmount();
		unregister();
		Reflect.deleteProperty(window, "plume");
	}
});
