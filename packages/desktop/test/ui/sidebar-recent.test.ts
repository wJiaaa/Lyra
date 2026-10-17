import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS, type SessionMeta } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { Sidebar } from "../../src/features/sidebar/Sidebar.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
// A conversation records its project; one in a scratch folder records none.
const session = (id: string, cwd: string, createdAt: number, project?: string): SessionMeta => ({ id, title: id, cwd, projectId: cwd, projectName: cwd, ...(project ? { project } : {}), createdAt, updatedAt: createdAt, modelId: "", messageCount: 1, seq: 2, usage });
const projects = ["a", "b"].map((id) => ({ id, path: `/${id}`, name: id, lastOpenedAt: 0 }));
let previous: ReturnType<typeof useApp.getState>;
let view: Mounted | undefined;

beforeEach(() => {
	previous = useApp.getState();
	localStorage.clear();
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: { updates: { check: async () => ({ available: false }), state: async () => ({ at: "idle" }), onProgress: () => () => {} } },
	});
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects, pinnedSessionIds: ["pinned"] },
		sessions: [session("a1", "/a", 10, "a"), session("b1", "/b", 30, "b"), session("loose", "/scratch/general", 20), session("pinned", "/a", 40, "a")],
		activeSessionId: null, activity: {}, turns: {}, notices: [], scratchRoots: ["/scratch"],
	});
});

/*
 * 侧栏底部挂着更新徽标，它一挂上就开始每 6 小时查一次更新，定时器刻意从不停（见
 * `features/update/store.ts` 的 `start`）。不在收尾时作废这扇窗的定时器，整个文件跑完也不退出。
 */
after(() => (window as unknown as { happyDOM: { abort(): Promise<void> } }).happyDOM.abort());

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
