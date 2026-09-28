/**
 * 分屏里，一屏的操作只作用于这一屏的会话。
 *
 * 台上（`activeSessionId` 和那一组实时字段）只有一个会话。鼠标按在哪一屏会先把那一屏请上台，
 * 键盘和空白屏都绕开了这一步：键盘撤回改的是旁边那一屏的对话，空白屏里打的字发给了旁边那一屏。
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { act, createElement as h, Fragment } from "react";
import type { UserContent } from "@plume/core";
import type { SessionSnapshot } from "../../electron/ipc-types.ts";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const content: UserContent[] = [{ type: "text", text: "问一句" }];
const created: string[] = [];
const prompted: string[] = [];
const reverted: Array<[string, number]> = [];

function meta(id: string) {
	return {
		id, title: id, projectId: "test", projectName: "test", cwd: "/test", createdAt: 1, updatedAt: 2, modelId: "", messageCount: 1, seq: 2,
		usage: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
	};
}
function snapshot(id: string): SessionSnapshot {
	return { meta: meta(id), messages: [{ role: "user", content, timestamp: 10 }], running: true, pendingApprovals: [] };
}
const said = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });

beforeEach(() => {
	created.length = 0; prompted.length = 0; reverted.length = 0;
	const a = meta("a");
	const b = meta("b");
	useApp.setState({
		activeSessionId: "a", meta: a, messages: [said("甲的话")], sessions: [a, b], workspace: null, scratchCwd: "/test", scratchRoots: ["/test"],
		sessionCache: { b: { meta: b, messages: [said("乙的话")], toolRuns: {}, state: { running: false, approvals: [], todos: [], compactions: [], stopped: null, retrying: null, capabilities: null, pendingUserMessage: null } } },
		toolRuns: {}, running: false, pendingUserMessage: null, activity: {}, turns: {}, carried: {}, notices: [], settings: null, loadingSession: false,
		composerDraft: { text: "", replace: false, attachments: [], sessionRefs: [] },
	} as never);
	Object.defineProperty(window, "plume", { configurable: true, value: {
		sessions: {
			create: async () => { created.push("new"); return snapshot("n"); },
			capabilities: async () => null,
			transcript: async (_project: string, id: string) => snapshot(id),
			contextBreakdown: async () => null,
		},
		subAgents: { list: async () => [] },
		agent: {
			prompt: async (id: string) => { prompted.push(id); return meta(id); },
			revertMessage: async (id: string, index: number) => { reverted.push([id, index]); },
		},
		workspace: { info: async () => null },
		git: { generalScratch: async () => "/test" },
	} });
});

test("空白屏发出的话开一个新会话，不进旁边台上那一屏", async () => {
	assert.equal(await useApp.getState().send(content, { sessionId: null }), true);
	assert.deepEqual(created, ["new"], "开了一个新会话");
	assert.deepEqual(prompted, ["n"], "话只发给了新会话");
	// 空白屏不先把自己请上台：甲留在台上，转录原样；新会话落进缓存，等它那一屏来取。
	assert.equal(useApp.getState().activeSessionId, "a", "甲还在台上");
	assert.deepEqual(useApp.getState().messages.map((m) => m.content), [[{ type: "text", text: "甲的话" }]], "甲的转录原样");
	assert.ok(useApp.getState().sessionCache.n, "新会话落进了缓存");
});

test("撤回点名的会话，不是台上那一个", async () => {
	await useApp.getState().revertMessage(0, "b");
	assert.deepEqual(reverted, [["b", 0]]);
	assert.equal(useApp.getState().activeSessionId, "b", "乙先被请上台");
	assert.deepEqual(useApp.getState().sessionCache.a?.messages.length, 1, "甲一个字没少");
});

test("点名给一屏的草稿只落进那一屏的输入框", async () => {
	(window.plume as unknown as Record<string, unknown>).commands = { list: async () => ({ commands: [], skills: [], agents: [] }) };
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Fragment, null,
		h("div", { "data-screen": "a" }, h(SessionScope.Provider, { value: "a" }, h(Composer))),
		h("div", { "data-screen": "b" }, h(SessionScope.Provider, { value: "b" }, h(Composer))),
	) }) }));
	try {
		await act(async () => useApp.getState().setComposerDraft("给乙的草稿", { sessionId: "b", replace: true }));
		const field = (screen: string) => document.querySelector<HTMLTextAreaElement>(`[data-screen="${screen}"] textarea`)?.value ?? "";
		assert.equal(field("b"), "给乙的草稿");
		assert.equal(field("a"), "", "甲的输入框没有被一起填上");
	} finally {
		await view.unmount();
	}
});
