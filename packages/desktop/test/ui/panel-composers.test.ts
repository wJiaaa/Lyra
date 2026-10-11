/**
 * 侧边聊天和子智能体面板，跟主会话是不是同一套手感（二轮）。
 *
 * 反馈原话是「主会话的输入框完成度高，侧边聊天和子智能体的实现就比较差」。这里钉住的是那几处差：
 *
 *   - 子智能体的草稿按子智能体存：给 A 写到一半切到 B，那半句话不能跟过去；
 *   - 子智能体的发送键就是发送键：发出去的带着给人看的那一份，发送中也不变成一颗会停掉整个子智能体
 *     的停止键；
 *   - 子智能体转录：主 Agent 交代的任务画成任务卡片，人说的话画成气泡（不是整篇附件正文），夹在
 *     一条回复中间的工具调用不会凭空消失；
 *   - 侧边聊天正在答的时候按回车是排队，排在它自己的会话上；编辑一句带文件的问题，文件跟着过去，
 *     而且就在侧边聊天里改，不把它请到主列上去。
 *
 * 侧边聊天的转录就是主会话的 `Conversation`（它是一个会话），工具调用怎么收、气泡画什么由那边的测试管。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";

import type { Message, SessionMeta, SubAgentSummary, UserContent } from "@plume/core";
import { SubAgentPanel } from "../../src/features/subagents/SubAgentPanel.tsx";
import { SubAgentTranscript } from "../../src/features/subagents/SubAgentMessageRow.tsx";
import { QueueList } from "../../src/features/composer/QueuedMessages.tsx";
import { SideComposer } from "../../src/features/sidechat/SideComposer.tsx";
import { useSide } from "../../src/features/dock/sideStore.ts";
import { useApp } from "../../src/store/index.ts";
import { useSubAgents } from "../../src/store/subAgents.ts";
import { click, fire, mount, press } from "../helpers/mount.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function running(id: string, over: Partial<SubAgentSummary> = {}): SubAgentSummary {
	return { id, agent: "explore", description: `任务 ${id}`, status: "running", startedAt: Date.now() - 2000, toolCalls: 0, depth: 1, usage: zero, ...over };
}

function brief(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1, origin: "parent" };
}

function reply(content: Extract<Message, { role: "assistant" }>["content"], stopReason: "stop" | "toolUse" = "stop"): Message {
	return { role: "assistant", content, api: "anthropic-messages", provider: "p", model: "m", usage: zero, stopReason, timestamp: 2 } as Message;
}

/** 像人那样打字：受控输入框里直接赋 value 会被 React 盖掉，得走原生 setter。 */
async function type(field: HTMLTextAreaElement, text: string): Promise<void> {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	assert.ok(setter);
	setter.call(field, text);
	await fire(field, new Event("input", { bubbles: true }));
}

let steered: unknown[][];
let edited: unknown[][];

beforeEach(() => {
	steered = [];
	edited = [];
	useApp.setState({ activeSessionId: "s", messages: [], toolRuns: {}, drafts: {} });
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			subAgents: {
				steer: async (...args: unknown[]) => {
					steered.push(args);
					return true;
				},
				abort: async () => true,
				dismiss: async () => "removed",
			},
			agent: { editMessage: async (...args: unknown[]) => void edited.push(args) },
			sideChat: { list: async () => [], open: async () => side },
			tasks: { list: async () => [] },
		},
	});
});

afterEach(() => {
	useSubAgents.setState({ agents: [], transcripts: {}, focused: null, loading: [] });
	useSide.setState({ sides: {} });
	useApp.setState({ sessionCache: {}, queued: {} });
});

const side: SessionMeta = { id: "side1", parentId: "s", sideId: "default", title: "", cwd: "/p", projectId: "p", projectName: "p", createdAt: 1, updatedAt: 1, modelId: "", messageCount: 2, usage: zero, seq: 3 };

/** 侧边聊天那个会话在缓存里的样子——它从不上台，转录只在这里。 */
function cacheSide(messages: Message[], running: boolean) {
	useSide.setState({ sides: { s: { default: side } } });
	useApp.setState({ sessionCache: { side1: { meta: side, messages, toolRuns: {}, state: { running, approvals: [], todos: [], compactions: [], stopped: null, retrying: null, capabilities: null, pendingUserMessage: null } } } });
}

test("子智能体的草稿按子智能体存：给 A 写到一半切到 B，那半句话不跟过去", async () => {
	useSubAgents.setState({ agents: [running("a"), running("b", { startedAt: Date.now() - 1000 })], transcripts: { a: [brief("去找 A")], b: [brief("去找 B")] }, focused: "a", loading: [] });
	const view = await mount(h(SubAgentPanel));
	try {
		const field = () => view.find<HTMLTextAreaElement>("textarea");
		await type(field(), "给 A 的半句");
		await act(async () => useSubAgents.getState().focus("b"));
		assert.equal(field().value, "", "换到 B，框是空的——那半句不是说给 B 的");
		await act(async () => useSubAgents.getState().focus("a"));
		assert.equal(field().value, "给 A 的半句", "回到 A，它还在");
	} finally {
		await act(async () => useSubAgents.setState({ agents: [running("a", { status: "done" }), running("b", { status: "done" })] }));
		await view.unmount();
	}
});

test("子智能体的发送键就是发送键：带着给人看的那一份送出去，框清空", async () => {
	useSubAgents.setState({ agents: [running("a")], transcripts: { a: [brief("去找")] }, focused: "a", loading: [] });
	const view = await mount(h(SubAgentPanel));
	try {
		const field = view.find<HTMLTextAreaElement>("textarea");
		await type(field, "别看测试目录");
		const send = view.find<HTMLButtonElement>("[data-ly-composer-send], button[aria-label='发送']");
		assert.notEqual(send.getAttribute("aria-label"), "停止", "发送键不是停止键");
		await press(field, "Enter");
		await act(async () => {});
		assert.equal(steered.length, 1);
		const [sessionId, id, content, display] = steered[0] as [string, string, UserContent[], { displayText: string }];
		assert.equal(sessionId, "s");
		assert.equal(id, "a");
		assert.deepEqual(content, [{ type: "text", text: "别看测试目录" }]);
		assert.equal(display.displayText, "别看测试目录", "给人看的那一份跟着走，面板才画得出这句话本身");
		assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "");
	} finally {
		await act(async () => useSubAgents.setState({ agents: [running("a", { status: "done" })] }));
		await view.unmount();
	}
});

test("子智能体转录：交代的任务是一张卡片，人说的话是气泡而不是整篇附件，中间的工具调用不丢", async () => {
	const messages: Message[] = [
		brief("去找登录入口"),
		reply([
			{ type: "text", text: "先看看目录" },
			{ type: "toolCall", id: "c1", name: "ls", arguments: { path: "src" } },
			{ type: "text", text: "再读入口文件" },
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "src/app.ts" } },
		], "toolUse"),
		{ role: "toolResult", toolCallId: "c1", toolName: "ls", content: [{ type: "text", text: "app.ts" }], isError: false, timestamp: 3 } as Message,
		{ role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: "…" }], isError: false, timestamp: 3 } as Message,
		{
			role: "user",
			content: [{ type: "text", text: "看看【报告.md】" }, { type: "text", text: "\n\n### Attached file: 报告.md\n```\n第一章 很长很长的正文\n```" }],
			displayText: "看看【报告.md】",
			attachments: [{ name: "报告.md", kind: "text" }],
			timestamp: 4,
		},
	];
	const view = await mount(h(SubAgentTranscript, { messages }));
	try {
		const brief = view.find("[data-sub-brief]");
		assert.match(brief.textContent ?? "", /主 Agent 交代的任务.*去找登录入口/);
		assert.equal(view.all("[data-spoken-bubble]").length, 1, "只有人自己说的那一句是气泡");
		const bubble = view.find("[data-spoken-bubble]");
		assert.match(bubble.textContent ?? "", /看看.*报告\.md/);
		assert.ok(!(bubble.textContent ?? "").includes("第一章"), "附件正文不摊在气泡里");
		assert.ok(!(bubble.textContent ?? "").includes("Attached file"));
		// 夹在两段话中间的那次 `ls`：从前这里只认思考和文字，它就这么不见了。
		assert.match(view.text(), /先看看目录.*再读入口文件/);
		// 两行工具调用：夹在中间的 `ls` 一行、排在最后的 `read` 一行。从前只有后面那一行。
		assert.equal(view.all("[data-ly-run]").length, 2, `中间那次调用画出来了：${view.text()}`);
	} finally {
		await view.unmount();
	}
});

test("侧边聊天正在答的时候按回车是排队：排在它自己的会话上，不插进主会话", async () => {
	cacheSide([{ role: "user", content: [{ type: "text", text: "先问一句" }], timestamp: 1 }], true);
	const view = await mount(h(SideComposer, { side }));
	try {
		const field = view.find<HTMLTextAreaElement>("textarea");
		await type(field, "还有一件");
		await press(field, "Enter");
		await act(async () => {});
		assert.deepEqual(useApp.getState().queued.side1?.map((one) => one.preview), ["还有一件"]);
		assert.equal(useApp.getState().queued.s, undefined, "主会话的队伍不动");
		assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "");
	} finally {
		await view.unmount();
	}
});

test("侧边聊天的队伍是同一条条：没有「现在就发」，编辑直接是一个按钮", async () => {
	const taken: string[] = [];
	const items = [{ id: "q1", content: [{ type: "text" as const, text: "排着的" }], draft: { text: "排着的", attachments: [], sessionRefs: [] }, preview: "排着的" }];
	const view = await mount(h(QueueList, { source: { items, drop: (id: string) => items.find((one) => one.id === id) ?? null, move: () => {} }, running: true, onEdit: (entry) => taken.push(entry.draft.text) }));
	try {
		assert.equal(view.all("[data-queue-row]").length, 1);
		assert.equal(view.all("[data-queue-now]").length, 0, "侧边聊天没有「现在就发」");
		assert.equal(view.all("[data-queue-more]").length, 0, "只剩编辑一样，就不藏进菜单");
		await click(view.find("[data-queue-edit]"));
		assert.deepEqual(taken, ["排着的"]);
	} finally {
		await view.unmount();
	}
});

test("侧边聊天里编辑一句带文件的问题：文件跟着过去，就在侧边聊天里改，主列不换人", async () => {
	const message: Message = {
		role: "user",
		content: [{ type: "text", text: "总结【报告.md】" }, { type: "text", text: "\n\n### Attached file: 报告.md\n```\n正文\n```" }],
		displayText: "总结【报告.md】",
		attachments: [{ name: "报告.md", kind: "text" }],
		timestamp: 1,
	};
	cacheSide([message, reply([{ type: "text", text: "旧的回答" }])], false);
	await useApp.getState().editMessage(0, [{ type: "text", text: "只总结第一章" }, message.content[1] as UserContent], { displayText: "只总结第一章", attachments: message.attachments }, "side1");
	assert.equal(edited.length, 1);
	assert.equal(edited[0]![0], "side1");
	assert.equal(useApp.getState().activeSessionId, "s", "主列还是主会话");
	const cached = useApp.getState().sessionCache.side1!;
	assert.deepEqual(cached.messages.map((one) => (one.role === "user" ? one.displayText : one.role)), ["只总结第一章"], "旧的回答先撤下，新问题画上");
	assert.equal(cached.state?.running, true);
});
