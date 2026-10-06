import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";
import { DEFAULT_SETTINGS, type SessionMeta } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { Sidebar } from "../../src/features/sidebar/Sidebar.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, fire, mount, type Mounted } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
const session = (id: string, cwd: string, createdAt: number, updatedAt = createdAt): SessionMeta => ({ id, title: id, cwd, projectId: cwd, projectName: cwd, createdAt, updatedAt, modelId: "", messageCount: 1, seq: 2, usage });
const projects = ["a", "b"].map((id) => ({ id, path: `/${id}`, name: id, lastOpenedAt: 0 }));
const sessions = [session("a1", "/a", 10, 30), session("b1", "/b", 30, 10), session("loose", "/scratch/general", 20), session("pinned", "/a", 40)];
let previous: ReturnType<typeof useApp.getState>;
let view: Mounted | undefined;
let opened: string[];
let saves: number;

beforeEach(() => {
	previous = useApp.getState();
	opened = [];
	saves = 0;
	localStorage.clear();
	Object.defineProperty(window, "plume", { configurable: true, value: {
		settings: { save: async () => { saves++; return useApp.getState().settings; } },
	} });
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects, pinnedSessionIds: ["pinned"] },
		sessions: [...sessions, { ...session("archived", "/a", 50), archived: true }, { ...session("empty", "/a", 60), messageCount: 0 }],
		activeSessionId: null, activity: {}, turns: {}, notices: [], scratchRoots: ["/scratch"],
		openSession: async (item) => { opened.push(item.id); },
	});
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous, true);
	localStorage.clear();
});

async function sidebar(): Promise<void> {
	view = await mount(h(LayoutProvider, null, h(Sidebar)));
}

function recent(): Element {
	return view!.find('[data-ly-section="recent"]').parentElement!.nextElementSibling!;
}

function ids(): string[] {
	return [...recent().querySelectorAll("[data-ly-row]")].map((row) => row.getAttribute("data-ly-row")!);
}

test("最近包含跨项目、无项目和置顶会话，排除归档与未开始的空会话", async () => {
	await sidebar();
	assert.deepEqual(ids(), ["pinned", "b1", "loose", "a1"]);
	assert.equal(view!.all('[data-ly-row="a1"]').length, 2, "项目分组和最近都保留入口");
	assert.equal(view!.all('[data-ly-row="pinned"]').length, 2, "置顶不应从最近排除");
	await click(recent().querySelector('[data-ly-row="a1"] > button')!);
	assert.deepEqual(opened, ["a1"]);
	await click(view!.find('[data-ly-section="recent"]'));
	assert.equal(view!.find('[data-ly-section="recent"] [data-ly-section-count]').textContent, "4");
});

test("最近跟随时间排序和项目会话新增，不受项目手动顺序影响", async () => {
	localStorage.setItem("ly-sidebar-sort", "manual");
	useApp.setState({ settings: { ...useApp.getState().settings!, sessionOrder: { "/a": ["a1"] } } });
	await sidebar();
	assert.deepEqual(ids(), ["pinned", "a1", "loose", "b1"]);
	await act(async () => {
		useApp.setState({ sessions: [...useApp.getState().sessions, session("new-project-chat", "/b", 70)] });
	});
	assert.deepEqual(ids(), ["new-project-chat", "pinned", "a1", "loose", "b1"]);
});

test("最近可分页显示全部项目会话，拖动不会改写项目内顺序", async () => {
	useApp.setState({ sessions: Array.from({ length: 7 }, (_, i) => session(`a${i}`, "/a", i + 1)) });
	await sidebar();
	assert.deepEqual(ids(), ["a6", "a5", "a4", "a3", "a2"]);
	const more = [...recent().querySelectorAll("button")].find((button) => button.textContent?.includes("展开显示"));
	assert.ok(more);
	await click(more);
	assert.deepEqual(ids(), ["a6", "a5", "a4", "a3", "a2", "a1", "a0"]);
	const pointer = (type: string, y: number) => new window.PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 20, clientY: y });
	await fire(recent().querySelector('[data-ly-row="a6"] > button')!, pointer("pointerdown", 0));
	await fire(recent().querySelector('[data-ly-row="a5"]')!, pointer("pointermove", 20));
	await fire(recent().querySelector('[data-ly-row="a5"]')!, pointer("pointerup", 20));
	assert.equal(saves, 0);
	assert.deepEqual(ids(), ["a6", "a5", "a4", "a3", "a2", "a1", "a0"]);
});
