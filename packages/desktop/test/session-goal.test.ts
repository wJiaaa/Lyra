/**
 * 持续目标在窗口这一侧：`/goal` 落到哪里，`goal` 事件改了哪几份。
 *
 * 状态条上的「在判定」「在等」只持续几秒，等 `sessions:changed` 那一来一回就看不到了，所以事件到了
 * 就要改——屏上那份、列表那份、分屏里不在台上那一格的缓存，一份不落。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GoalState, SessionMeta } from "@plume/core";

const calls: Array<{ sessionId: string; text: string | null }> = [];
let failWith: Error | null = null;

// 只够 store 自己的 import 用，理由见 `session-thinking.test.ts`。
(globalThis as unknown as { window: unknown }).window = {
	addEventListener: () => {},
	removeEventListener: () => {},
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	plume: {
		agent: {
			setGoal: async (sessionId: string, text: string | null) => {
				calls.push({ sessionId, text });
				if (failWith) throw failWith;
			},
		},
		sessions: { list: async () => [] },
	},
};

const { useApp } = await import("../src/store/index.ts");

const META = { id: "s-1", projectId: "p", modelId: "relay/a", seq: 3, updatedAt: 1 } as unknown as SessionMeta;
const OTHER = { ...META, id: "s-2" } as SessionMeta;
const GOAL: GoalState = { text: "CI 变绿", startedAt: 1, status: "judging", rounds: 1, noProgress: 0, judgeFailures: 0, waits: 0 };

describe("持续目标", () => {
	beforeEach(() => {
		calls.length = 0;
		failWith = null;
		useApp.setState({ meta: META, activeSessionId: "s-1", sessions: [META, OTHER], sessionCache: {}, notices: [] });
	});

	it("定目标和取消都写到这个对话", async () => {
		await useApp.getState().setGoal("CI 变绿");
		await useApp.getState().setGoal(null);
		assert.deepEqual(calls, [{ sessionId: "s-1", text: "CI 变绿" }, { sessionId: "s-1", text: null }]);
	});

	it("没有对话时什么也不写", async () => {
		useApp.setState({ meta: null, activeSessionId: null });
		await useApp.getState().setGoal("CI 变绿");
		assert.equal(calls.length, 0);
	});

	it("写失败就提示", async () => {
		failWith = new Error("offline");
		await useApp.getState().setGoal("CI 变绿");
		assert.match(useApp.getState().notices.at(-1)?.message ?? "", /offline/);
	});

	it("goal 事件改屏上那份和列表那份，取消就拿掉", () => {
		useApp.getState().applyEvent("s-1", { type: "goal", goal: GOAL });
		assert.equal(useApp.getState().meta?.goal?.status, "judging");
		assert.equal(useApp.getState().sessions.find((one) => one.id === "s-1")?.goal?.status, "judging");
		useApp.getState().applyEvent("s-1", { type: "goal", goal: null });
		assert.equal(useApp.getState().meta?.goal, undefined);
	});

	it("不在台上的那个对话，缓存里那份也跟上，屏上那份不动", () => {
		useApp.setState({ sessionCache: { "s-2": { meta: OTHER, messages: [], toolRuns: {} } } as never });
		useApp.getState().applyEvent("s-2", { type: "goal", goal: { ...GOAL, status: "waiting", wakeAt: 99 } });
		assert.equal(useApp.getState().sessionCache["s-2"]?.meta.goal?.status, "waiting");
		assert.equal(useApp.getState().meta?.goal, undefined, "屏上是 s-1，不该被 s-2 的目标改掉");
	});
});
