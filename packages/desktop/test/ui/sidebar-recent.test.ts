import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS, type SessionMeta } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { Sidebar } from "../../src/features/sidebar/Sidebar.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
const session = (id: string, cwd: string, createdAt: number): SessionMeta => ({ id, title: id, cwd, projectId: cwd, projectName: cwd, createdAt, updatedAt: createdAt, modelId: "", messageCount: 1, seq: 2, usage });
const projects = ["a", "b"].map((id) => ({ id, path: `/${id}`, name: id, lastOpenedAt: 0 }));
let previous: ReturnType<typeof useApp.getState>;
let view: Mounted | undefined;

beforeEach(() => {
	previous = useApp.getState();
	localStorage.clear();
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects, pinnedSessionIds: ["pinned"] },
		sessions: [session("a1", "/a", 10), session("b1", "/b", 30), session("loose", "/scratch/general", 20), session("pinned", "/a", 40)],
		activeSessionId: null, activity: {}, turns: {}, notices: [], scratchRoots: ["/scratch"],
	});
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous, true);
	localStorage.clear();
});

test("最近只放不属于任何项目的会话，项目内和置顶的会话留在各自的分组里", async () => {
	view = await mount(h(LayoutProvider, null, h(Sidebar)));
	const recent = view.find('[data-ly-section="recent"]').parentElement!.nextElementSibling!;
	assert.deepEqual([...recent.querySelectorAll("[data-ly-row]")].map((row) => row.getAttribute("data-ly-row")), ["loose"]);
	assert.equal(view.all('[data-ly-row="a1"]').length, 1, "项目会话只在项目分组里出现一次");
	assert.equal(view.all('[data-ly-row="pinned"]').length, 1, "置顶会话只在置顶分组里出现一次");
});
