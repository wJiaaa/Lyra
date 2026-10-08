import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Terminal } from "lucide-react";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
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
