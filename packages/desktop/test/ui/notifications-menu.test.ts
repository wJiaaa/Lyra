/**
 * The bell's list: what wants you back, loudest first, and pressing a row takes you there.
 *
 * The bell was a button with no handler. These pin what it now does, from the store the rest of the
 * app already writes: the conversation on screen is left out, waiting beats failed beats done, and a
 * row opens its conversation.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";

import { NotificationsMenu, useNotices } from "../../src/features/sidebar/NotificationsMenu.tsx";
import { useScheduledNotices } from "../../src/features/scheduled/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

const initial = useApp.getState();
afterEach(() => useApp.setState(initial, true));

const meta = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt, createdAt: updatedAt, cwd: "/p", projectId: "p", projectName: "p", modelId: "", messageCount: 2 });

// The menu is a popover, drawn through a portal into the document rather than inside the mount point.
const inMenu = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];

function Harness() {
	const notices = useNotices();
	const anchor = document.body;
	return h(NotificationsMenu, { anchor, notices, onClose: () => {} });
}

test("lists the other conversations that want you back, waiting first, and opens one on press", async () => {
	const opened: string[] = [];
	useApp.setState({
		activeSessionId: "here",
		sessions: [meta("here", "正在看的", 5), meta("done-old", "早完成的", 1), meta("done-new", "刚完成的", 4), meta("broke", "出错的", 2), meta("asks", "等批准的", 3)] as never,
		activity: { here: "done", "done-old": "done", "done-new": "done", broke: "failed", asks: "waiting", busy: "running" },
		openSessionById: async (id: string) => {
			opened.push(id);
			return true;
		},
	});
	const view = await mount(h(Harness));
	// The title is the first line; the second (project, age) depends on the clock.
	const rows = inMenu("[data-ly-notice]").map((el) => `${el.getAttribute("data-ly-notice")}:${el.querySelector("[data-ly-notice-title]")?.textContent}`);
	assert.deepEqual(rows, ["waiting:等批准的", "failed:出错的", "done:刚完成的", "done:早完成的"]);
	await click(inMenu('[data-ly-notice="failed"]')[0]!);
	assert.deepEqual(opened, ["broke"]);
	await view.unmount();
});

test("the second line says where and when, and only waiting also says what", async () => {
	const ago = Date.now() - 3 * 60_000;
	useApp.setState({ activeSessionId: null, sessions: [meta("asks", "等批准的", ago), meta("done", "完成的", ago)] as never, activity: { asks: "waiting", done: "done" } });
	const view = await mount(h(Harness));
	const row = (state: string) => inMenu(`[data-ly-notice="${state}"]`)[0]!.textContent;
	assert.equal(row("waiting"), "等批准的等你批准 · p · 3 分钟前");
	assert.equal(row("done"), "完成的p · 3 分钟前");
	await view.unmount();
});

test("says so when there is nothing, and lists unseen scheduled failures as one row", async () => {
	useApp.setState({ activeSessionId: null, sessions: [], activity: {} });
	const quiet = await mount(h(Harness));
	assert.equal(inMenu("[data-ly-notifications-empty]").length, 1);
	await quiet.unmount();

	const before = useScheduledNotices.getState();
	useScheduledNotices.setState({ ...before, unseen: [{ id: "t1" }, { id: "t2" }] as never });
	try {
		const loud = await mount(h(Harness));
		assert.equal(inMenu("[data-ly-notifications-empty]").length, 0);
		assert.match(inMenu('[data-ly-notice="scheduled"]')[0]?.textContent ?? "", /2/);
		await loud.unmount();
	} finally {
		useScheduledNotices.setState(before, true);
	}
});
