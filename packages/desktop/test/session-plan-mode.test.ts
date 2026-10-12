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
const created: Array<{ planMode?: boolean } | undefined> = [];
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
			prompt: async () => META,
		},
		sessions: {
			create: async (_cwd: string, _modelId: string, initial?: { planMode?: boolean }) => {
				created.push(initial);
				return { meta: META, messages: [], running: true, pendingApprovals: [] };
			},
			capabilities: async () => null,
		},
	},
};

const { useApp } = await import("../src/store/index.ts");
const { applySessionChange } = await import("../src/store/session-changes.ts");

const META = { id: "s-1", projectId: "p", modelId: "relay/a", seq: 3, updatedAt: 1 } as unknown as SessionMeta;

describe("计划模式开关", () => {
	beforeEach(() => {
		calls.length = 0;
		created.length = 0;
		failWith = null;
		useApp.setState({ meta: META, activeSessionId: "s-1", sessions: [META], notices: [], draftPlanMode: false });
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

	it("空白对话记在窗口里，不经主进程", async () => {
		useApp.setState({ meta: null, activeSessionId: null });
		await useApp.getState().setPlanMode(true);
		assert.equal(calls.length, 0);
		assert.equal(useApp.getState().draftPlanMode, true);
	});

	/*
	 * 第一轮按建出来的 meta 装工具表：开关得跟着 `sessions:create` 一起过去，建完再拨就晚了一轮——
	 * 那一轮是照常跑的，full 档下可能已经改了文件。
	 */
	it("空白对话拨开后，第一句话建出的会话就在计划模式里", async () => {
		useApp.setState({ meta: null, activeSessionId: null, workspace: null, scratchCwd: "/tmp/plume-plan-draft" });
		await useApp.getState().setPlanMode(true, null);
		await useApp.getState().send([{ type: "text", text: "先看看" }]);
		assert.equal(created[0]?.planMode, true);
		assert.equal(useApp.getState().draftPlanMode, false, "下一个空白对话从关着开始");
	});

	it("没拨开的空白对话照常建", async () => {
		useApp.setState({ meta: null, activeSessionId: null, workspace: null, scratchCwd: "/tmp/plume-plan-draft" });
		await useApp.getState().send([{ type: "text", text: "直接做" }]);
		assert.equal(created[0]?.planMode, undefined);
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
