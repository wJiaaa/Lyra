/**
 * 计划模式在窗口这一侧的两条路：人拨开关，和模型的计划被批准后 core 自己关掉。
 *
 * 第二条路窗口什么也没做——core 写一条 `meta` 记录，主进程照常推 `sessions:changed`。值得钉住的是
 * 「照常」：芯片读的是 `meta.planMode`，那份变化里关掉的计划模式是个缺掉的键，窗口要把它当成关。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SessionMeta } from "@plume/core";

const calls: Array<{ sessionId: string; on: boolean }> = [];
let failWith: Error | null = null;

// 只够 store 自己的 import 用，理由见 `session-thinking.test.ts`。
(globalThis as unknown as { window: unknown }).window = {
	addEventListener: () => {},
	removeEventListener: () => {},
	localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	plume: {
		agent: {
			setPlanMode: async (sessionId: string, on: boolean) => {
				calls.push({ sessionId, on });
				if (failWith) throw failWith;
			},
		},
	},
};

const { useApp } = await import("../src/store/index.ts");
const { applySessionChange } = await import("../src/store/session-changes.ts");

const META = { id: "s-1", projectId: "p", modelId: "relay/a", seq: 3, updatedAt: 1 } as unknown as SessionMeta;

describe("计划模式开关", () => {
	beforeEach(() => {
		calls.length = 0;
		failWith = null;
		useApp.setState({ meta: META, activeSessionId: "s-1", sessions: [META], notices: [] });
	});

	it("打开写到这个对话，芯片不等来回就亮", async () => {
		await useApp.getState().setPlanMode(true);
		assert.deepEqual(calls, [{ sessionId: "s-1", on: true }]);
		assert.equal(useApp.getState().meta?.planMode, true);
	});

	it("关掉是 undefined，不是 false", async () => {
		useApp.setState({ meta: { ...META, planMode: true } });
		await useApp.getState().setPlanMode(false);
		assert.deepEqual(calls, [{ sessionId: "s-1", on: false }]);
		assert.equal(useApp.getState().meta?.planMode, undefined);
	});

	it("没有对话时什么也不写", async () => {
		useApp.setState({ meta: null, activeSessionId: null });
		await useApp.getState().setPlanMode(true);
		assert.equal(calls.length, 0);
	});

	it("写失败就退回原样并提示", async () => {
		failWith = new Error("offline");
		await useApp.getState().setPlanMode(true);
		assert.equal(useApp.getState().meta?.planMode, undefined, "芯片不能停在一个没生效的状态上");
		assert.match(useApp.getState().notices.at(-1)?.message ?? "", /offline/);
	});

	it("批准计划后 core 关掉的那份变化，会把芯片熄掉", () => {
		useApp.setState({ meta: { ...META, planMode: true }, sessions: [{ ...META, planMode: true }] });
		// 主进程推来的是存档那一份：关掉的计划模式在 JSON 里没有这个键。
		const closed = { ...META, seq: 4 } as SessionMeta;
		applySessionChange({ id: "s-1", projectId: "p", meta: closed }, useApp.setState, useApp.getState);
		assert.equal(useApp.getState().meta?.planMode, undefined);
	});
});
