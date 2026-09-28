/**
 * `ClosableTab`, shared by the terminal's and the file pane's strips.
 *
 * The probes find a tab by the `data-*` on its wrapper and read its state off the wrapper's class, so
 * those land there; the name is a real tab to a screen reader, and the ✕ says which tab it closes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";

import { ClosableTab } from "../../src/ui/primitives/ClosableTab.tsx";
import { click, mount } from "../helpers/mount.ts";

test("ClosableTab: 名字是 tab，✕ 带上它关的是哪一个，data-* 落在外层", async () => {
	let picked = 0;
	let closed = 0;
	const view = await mount(h(ClosableTab, {
		"data-tab": "a",
		current: true,
		onSelect: () => picked++,
		onClose: () => closed++,
		closeLabel: "关闭 zsh",
		children: "zsh",
	}));
	const wrapper = view.find<HTMLElement>("[data-tab]");
	assert.equal(wrapper.dataset.tab, "a");
	const tab = view.find<HTMLButtonElement>('[role="tab"]');
	assert.equal(tab.getAttribute("aria-selected"), "true");
	await click(tab);
	await click(view.find('[aria-label="关闭 zsh"]'));
	assert.equal(picked, 1);
	assert.equal(closed, 1);
	await view.unmount();
});
