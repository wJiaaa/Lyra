/**
 * 一个会话旁边开好几个侧边聊天：每个是顶上的一个标签，不是面板里再套一层。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { MessageCirclePlus } from "lucide-react";
import { DEFAULT_SETTINGS } from "@plume/core";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { DockView } from "../../src/features/dock/DockView.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { usePanelKind } from "../../src/app/session-scope.tsx";
import { usePaneDock } from "../../src/features/dock/pane-store.ts";
import { useSide } from "../../src/features/dock/sideStore.ts";
import { registerPanels } from "../../src/features/dock/panels/registry.ts";
import { kinds } from "../../src/features/dock/tree.ts";
import { sideIdOfPanel } from "../../src/lib/panel-instance.ts";
import { useApp } from "../../src/store/index.ts";
import { translate } from "../../src/i18n/translate.ts";
import { click, mount } from "../helpers/mount.ts";

function Chat() {
	return h("div", { "data-test-chat": usePanelKind() ?? "" });
}

test("侧边聊天开着时再从「+」开一次是新的一格；关掉哪一格，它的对话都一起删", async () => {
	const closed: string[][] = [];
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin", sideChat: { close: async (sessionId: string, sideId: string) => void closed.push([sessionId, sideId]) } } });
	window.localStorage.clear();
	useApp.setState({ settings: { ...DEFAULT_SETTINGS} });
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, tabWidth: null, host: null });
	// 替换掉内置的那一项，关掉时要做的事也照内置的写。
	const unregister = registerPanels([{ kind: "chat", label: "dock.sideChat", icon: MessageCirclePlus, shortcut: "", render: Chat,
		onClose: (sessionId, kind) => void useSide.getState().close(sessionId, sideIdOfPanel(kind)!) }]);
	const scope = "s1";
	const view = await mount(h(LayoutProvider, { children: h(DockView, { scope, header: () => null, children: h("textarea") }) }));
	const addFrom = async (kind: string) => {
		await click(view.find(`[data-dock-pane="${kind}"]`).querySelector(`button[aria-label="${translate("pane.addTab")}"]`)!);
		const item = [...document.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent?.includes(translate("dock.sideChat")));
		assert.ok(item, "开着的侧边聊天也还列在「+」里");
		await click(item);
	};
	try {
		await act(() => { usePaneDock.getState().open(scope, "chat"); });
		// 这一栏从无到有，是真的出现：照旧淡入。
		assert.equal(view.find('[data-dock-pane="chat"]').hasAttribute("data-dock-retained"), false);
		await addFrom("chat");
		const opened = kinds(usePaneDock.getState().tree(scope)).filter((kind) => kind.startsWith("chat:"));
		assert.equal(opened.length, 1, "新开了一格，不是切回原来那一个");
		const extra = opened[0]!;
		assert.match(extra, /^chat:[a-z0-9]+$/);
		// 顶替正在显示的那一格：不从透明淡入。旧的那格已经瞬间透明，新的再淡入，整栏会空一下。
		assert.equal(view.find(`[data-dock-pane="${extra}"]`).hasAttribute("data-dock-retained"), true, "新标签从透明淡入，整栏闪了一下");
		// 每一格的正文都知道自己是哪一个，标签条在顶上、每格一个标签。
		assert.deepEqual(view.all("[data-test-chat]").map((node) => node.getAttribute("data-test-chat")).sort(), ["chat", extra].sort());
		assert.equal(view.all(`[data-dock-pane="${extra}"] [data-panel-tab]`).length, 2);

		await click(view.find(`[data-dock-pane="${extra}"] [data-panel-tab="${extra}"] button[aria-label]:not([role="tab"])`));
		assert.ok(!kinds(usePaneDock.getState().tree(scope)).includes(extra));
		assert.deepEqual(closed, [[scope, extra.slice("chat:".length)]]);

		// 最早那一个也一样：关掉就删，不是收起。
		await click(view.find('[data-dock-pane="chat"] [data-panel-tab="chat"] button[aria-label]:not([role="tab"])'));
		assert.deepEqual(closed, [[scope, extra.slice("chat:".length)], [scope, DEFAULT_SIDE_CHAT_ID]]);
	} finally {
		await view.unmount();
		unregister();
		usePaneDock.setState({ trees: {}, focused: {}, tab: {} });
	}
});
