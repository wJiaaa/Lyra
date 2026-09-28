/**
 * What the status bar menu offers, and on which platforms.
 *
 * The menu is the only way out of the app on Windows and Linux — closing the window there only
 * hides it — so "退出 Plume is present and reachable" is a functional requirement rather than a
 * nicety. It is also the only surface that is identical on every platform by policy: how the menu
 * opens is each system's convention, what is in it is ours.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_LIMIT, trayMenu, trayTitle, type TrayItem } from "../electron/tray-menu.ts";

const state = (over: Partial<Parameters<typeof trayMenu>[0]> = {}) =>
	trayMenu({ windowVisible: false, recent: [], launchAtLogin: false, ...over });

/** Every label in the menu, submenus included, so a moved item is still found. */
function labels(items: TrayItem[]): string[] {
	return items.flatMap((item) =>
		item.type === "separator" ? [] : item.type === "submenu" ? [item.label, ...labels(item.items)] : [item.label],
	);
}

function find(items: TrayItem[], label: string): TrayItem | undefined {
	for (const item of items) {
		if (item.type === "separator") continue;
		if (item.label === label) return item;
		if (item.type === "submenu") {
			const inner = find(item.items, label);
			if (inner) return inner;
		}
	}
	return undefined;
}

test("the way out is always in the menu, because on Windows there is no other one", () => {
	const quit = find(state(), "退出 Plume");
	assert.equal(quit?.type, "item");
	assert.deepEqual(quit.type === "item" ? quit.action : null, { kind: "quit" });
});

test("the first item names what pressing it will do, not what is true", () => {
	assert.equal(labels(state({ windowVisible: false }))[0], "打开 Plume");
	assert.equal(labels(state({ windowVisible: true }))[0], "隐藏 Plume");
});

test("the things worth doing from cold are all one press away", () => {
	const all = labels(state());
	for (const label of ["新对话", "拉取请求", "定时任务", "设置…", "开机时启动"]) {
		assert.ok(all.includes(label), `missing ${label}`);
	}
});

test("recent conversations are listed, newest first, and capped", () => {
	const recent = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, title: `会话 ${i}` }));
	const menu = state({ recent });
	const submenu = menu.find((item) => item.type === "submenu" && item.label === "最近会话");
	assert.ok(submenu?.type === "submenu");
	assert.equal(submenu.items.length, RECENT_LIMIT);
	assert.deepEqual(
		submenu.items.map((item) => (item.type === "item" ? item.action : null)),
		Array.from({ length: RECENT_LIMIT }, (_, i) => ({ kind: "open-session", id: `s${i}` })),
	);
});

test("no conversations yet is said, rather than being an empty menu that looks broken", () => {
	const submenu = state().find((item) => item.type === "submenu");
	assert.ok(submenu?.type === "submenu");
	assert.equal(submenu.items.length, 1);
	assert.equal(submenu.items[0].type === "item" ? submenu.items[0].enabled : true, false);
});

test("开机时启动 carries a tick that reflects the system, not a guess", () => {
	const off = find(state({ launchAtLogin: false }), "开机时启动");
	const on = find(state({ launchAtLogin: true }), "开机时启动");
	assert.equal(off?.type === "item" ? off.checked : null, false);
	assert.equal(on?.type === "item" ? on.checked : null, true);
});

test("a long title is cut rather than allowed to set the menu's width", () => {
	const long = "帮我把这个项目里所有的东西都检查一遍然后写一份很长的报告出来";
	const cut = trayTitle(long);
	assert.ok(cut.length <= 28, cut);
	assert.ok(cut.endsWith("…"));
	// Short ones are left exactly as they are.
	assert.equal(trayTitle("看看这个 bug"), "看看这个 bug");
});

test("a conversation with no title yet is still nameable", () => {
	assert.equal(trayTitle(undefined), "新对话");
	assert.equal(trayTitle("   "), "新对话");
});

test("every command in the menu is one the window knows how to answer", () => {
	// Mirrors the switch in `src/tray-commands.ts`; a new item without a case is a dead menu row.
	const answered = new Set(["new-session", "pull-requests", "scheduled", "settings"]);
	const walk = (items: TrayItem[]) => {
		for (const item of items) {
			if (item.type === "separator") continue;
			if (item.type === "submenu") {
				walk(item.items);
				continue;
			}
			if (item.action.kind === "command") assert.ok(answered.has(item.action.command), item.action.command);
		}
	};
	walk(state({ recent: [{ id: "a", title: "x" }] }));
});
