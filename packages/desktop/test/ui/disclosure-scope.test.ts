/**
 * A block opened in one screen of a split stays open while focus moves between screens.
 *
 * Open blocks were remembered under the conversation in the live slot — the focused one — so in a
 * split every screen's were kept under the same key, and moving focus changed that key under all of
 * them at once. Everything opened anywhere folded, and came back only when focus returned (measured
 * frame by frame in a real window: `e2e/split-scope-rest-probe.ts disclosure`).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { ToolGroup } from "../../src/features/conversation/ToolGroup.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { click, mount, type Mounted } from "../helpers/mount.ts";

/** Two screens, each with one finished stretch of work — keyed the way the transcript keys it. */
function screens(): Promise<Mounted> {
	return mount(
		h(I18nProvider, {
			locale: "zh-CN",
			children: ["a", "b"].map((id) =>
				h(
					SessionScope.Provider,
					{ key: id, value: id },
					h("section", { "data-screen": id }, h(ToolGroup, { summary: "读取文件", stateKey: `${id}:tools-${id}-call`, children: h("p", null, `${id} 的过程`) })),
				),
			),
		}),
	);
}

const shown = (view: Mounted, id: string) => view.find(`[data-screen="${id}"] button[aria-expanded]`).getAttribute("aria-expanded") === "true";
const focus = (id: string) => act(async () => useApp.setState({ activeSessionId: id }));

let previous: AppState;
let view: Mounted | undefined;

beforeEach(() => {
	previous = useApp.getState();
	useApp.setState({ activeSessionId: "a", pendingSessionId: null });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous, true);
});

test("blocks opened in either screen stay open when focus moves, and come back open after a remount", async () => {
	view = await screens();
	// 默认收起；在有焦点的屏和没焦点的屏各展开一个——键盘两边都够得着。
	assert.ok(!shown(view, "a") && !shown(view, "b"));
	await click(view.find('[data-screen="a"] button[aria-expanded]'));
	await click(view.find('[data-screen="b"] button[aria-expanded]'));
	assert.ok(shown(view, "a") && shown(view, "b"));

	await focus("b");
	assert.ok(shown(view, "a"), "focus moved to the other screen and this one's open block folded");
	assert.ok(shown(view, "b"), "opened while the other screen had focus, it folded the moment this one took it");

	await focus("a");
	assert.ok(shown(view, "a") && shown(view, "b"));

	// A screen's transcript is rebuilt when it comes back into view; what was opened is read back for it.
	await view.unmount();
	await focus("b");
	view = await screens();
	assert.ok(shown(view, "a") && shown(view, "b"), "remembered under a conversation other than the screen's own");
});
