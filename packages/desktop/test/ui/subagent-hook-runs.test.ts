/**
 * 子代理面板里的钩子按钮。
 *
 * 照 ZCode 的做法：子代理跑的钩子进它自己的面板，按段归——派出去那一句、续跑补的那一句各开一段，
 * 按钮放在这一段收尾的地方；跑着的那一段跑完才有，和主会话一样。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";

import type { HookRun, Message, SubAgentSummary } from "@plume/core";
import { SubAgentPanel } from "../../src/features/subagents/SubAgentPanel.tsx";
import { useApp } from "../../src/store/index.ts";
import { useSubAgents } from "../../src/store/subAgents.ts";
import { click, mount } from "../helpers/mount.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ID = "s:sub:1";

const brief = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1, origin: "parent" }) as Message;
const reply = (content: unknown[], stopReason = "stop"): Message =>
	({ role: "assistant", api: "openai-responses", provider: "fake", model: "m", usage: zero, stopReason, timestamp: 1, content }) as Message;

/** 两段：派出去那一段读了一个文件、说了结论；续跑那一段又说了一句。 */
const TRANSCRIPT: Message[] = [
	brief("找登录入口"),
	reply([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" }, argumentsText: "{}" }], "toolUse"),
	{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "被拦下" }], isError: true, timestamp: 1 } as Message,
	reply([{ type: "text", text: "入口在 auth.ts" }]),
	brief("接着看刷新"),
	reply([{ type: "text", text: "刷新在 refresh.ts" }]),
];

function hook(id: string, at: number, status: HookRun["status"], reason?: string): HookRun {
	return { id, event: "PreToolUse", source: "project", command: "node guard.js", toolName: "bash", status, startedAt: 1, durationMs: 12, at, ...(reason ? { reason } : {}) };
}

const RUNS = [hook("h1", 2, "blocked", "子代理也不许"), hook("h2", 2, "success"), hook("h3", 6, "success")];

async function show(status: SubAgentSummary["status"]) {
	const agent: SubAgentSummary = { id: ID, agent: "general", description: "找登录入口", status, startedAt: 1000, toolCalls: 1, usage: zero, ...(status === "done" ? { endedAt: 9000 } : {}) };
	useSubAgents.setState({ agents: [agent], transcripts: { [ID]: TRANSCRIPT }, hookRuns: { [ID]: RUNS }, focused: ID, loading: [] });
	return mount(h(SubAgentPanel));
}

beforeEach(() => {
	useApp.setState({ activeSessionId: "s", messages: [], toolRuns: {} });
	// 面板底下的上下文表会去读一次；这里不关心它读到什么。
	Object.defineProperty(window, "plume", { configurable: true, value: { subAgents: { contextBreakdown: async () => null } } });
});

afterEach(() => {
	useSubAgents.setState({ agents: [], transcripts: {}, hookRuns: {}, focused: null, loading: [] });
});

test("跑完的子代理：每一段收尾处一颗钩子按钮，各数各的", async () => {
	const view = await show("done");
	try {
		const rows = view.all("[data-sub-hooks]");
		assert.deepEqual(rows.map((row) => row.textContent?.trim()), ["2", "1"], "第一段两条、续跑那段一条");
		const second = view.all("[data-sub-brief]")[1]!;
		assert.ok(rows[0]!.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING, "第一段的按钮在续跑那句之前，贴着它自己那段的结尾");
		assert.match(rows[0]!.querySelector("button")!.className, /text-accent/, "拦下过东西的那段，按钮换成强调色");
		assert.doesNotMatch(rows[1]!.querySelector("button")!.className, /text-accent/);
	} finally {
		await view.unmount();
	}
});

test("点开说得出是哪条钩子、为什么拦", async () => {
	const view = await show("done");
	try {
		await click(view.all("[data-sub-hooks] button")[0]!);
		const text = document.body.textContent ?? "";
		assert.match(text, /PreToolUse/);
		assert.match(text, /子代理也不许/);
	} finally {
		await view.unmount();
	}
});

test("还在跑的那一段不放按钮，跑完的那几段照常有", async () => {
	const view = await show("running");
	try {
		assert.deepEqual(view.all("[data-sub-hooks]").map((row) => row.textContent?.trim()), ["2"]);
	} finally {
		await view.unmount();
	}
});
