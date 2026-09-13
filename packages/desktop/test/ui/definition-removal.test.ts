import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { useDefinitionRemoval } from "../../src/features/settings/useDefinitionRemoval.tsx";
import { ListRow } from "../../src/features/settings/layout.tsx";
import { RowDeleteButton } from "../../src/ui/primitives/RowDeleteButton.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

test("delete targets its own row, cancel is inert, and failure keeps the definition with a visible error", async () => {
	const calls: string[] = [];
	let opened = 0; let reloaded = 0;
	let fail!: (error: Error) => void;
	const request = new Promise<void>((_resolve, reject) => { fail = reject; });
	Object.defineProperty(window, "lyra", { configurable: true, value: { capabilities: { trash: (_kind: string, _cwd: string, path: string) => { calls.push(path); return request; } } } });
	function Example() {
		const removal = useDefinitionRemoval("command", "/project", () => { reloaded++; });
		return h("div", null,
			h(ListRow, { title: "same", onOpen: () => { opened++; }, openLabel: "edit", actions: h(RowDeleteButton, { label: "删除命令 same", pending: removal.pending.has("/project/same.md"), onClick: () => removal.ask("same", "/project/same.md") }) }),
			removal.element);
	}
	const view = await mount(h(Example));
	const button = () => view.find<HTMLButtonElement>('[aria-label="删除命令 same"]');
	const modalButton = (text: string) => {
		const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => (button.getAttribute("aria-label") ?? button.textContent) === text);
		assert.ok(button); return button;
	};
	try {
		await click(button());
		assert.match(document.body.textContent ?? "", /\/project\/same.md/);
		await click(modalButton("取消"));
		await act(async () => { document.querySelector(".ly-dialog-out")?.dispatchEvent(new Event("animationend", { bubbles: true })); });
		assert.equal(opened, 0); assert.deepEqual(calls, []);
		await click(button()); await click(modalButton("移入废纸篓"));
		assert.deepEqual(calls, [], "the action follows the dialog exit");
		await act(async () => { document.querySelector(".ly-dialog-out")?.dispatchEvent(new Event("animationend", { bubbles: true })); });
		assert.deepEqual(calls, ["/project/same.md"]);
		assert.equal(button().disabled, true);
		await act(async () => { fail(new Error("permission denied")); });
		assert.equal(button().disabled, false);
		assert.equal(reloaded, 0);
		assert.ok(useApp.getState().notices.some((notice) => notice.message.includes("permission denied")));
		assert.match(view.text(), /same/);
	} finally { await view.unmount(); }
});
