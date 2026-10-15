/**
 * Suggested conversations (`spawn_session`): a card where the call was made, and a second way in on the Environment card.
 *
 * The card's section runs the real `startSession`, with only the two main-process calls stood in for.
 * Guarded: Start does not switch away from the conversation on screen, the new one is listed and running,
 * its first message is the suggestion's prompt, and `spawnedFrom` goes down with the create request.
 * "Started" is read from the session list's `spawnedFrom` — which is why it still holds after a reopen.
 * The card in the conversation is there while the call is still being written, starts the same way, and
 * shrinks to a line once started; the toolbar button's dot says one is waiting.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import type { SessionMeta, ToolCallContent, UserContent } from "@plume/core";
import type { SessionSuggestionDetails } from "../../shared/session-suggestion.ts";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { SessionSuggestionCard } from "../../src/features/conversation/SessionSuggestionCard.tsx";
import { SuggestionsSection } from "../../src/features/environment/SuggestionsSection.tsx";
import { EnvironmentToggle } from "../../src/features/environment/EnvironmentToggle.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp, type ToolRun } from "../../src/store/index.ts";
import { useEnvironmentCard } from "../../src/store/environment-card.ts";
import { useDismissedSuggestions } from "../../src/store/session-suggestions.ts";
import { click, mount } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } as unknown as SessionMeta["usage"];
const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({
	id, title: id, cwd: "/work/project", projectId: "p", projectName: "project",
	createdAt: 1, updatedAt: 2, modelId: "fake/model", messageCount: 2, seq: 2, usage, ...over,
});

const DETAILS: SessionSuggestionDetails = {
	kind: "session_suggestion",
	title: "删掉没人调用的分组函数",
	summary: "改侧栏时看到 groupLegacy 已经没有调用方了。新会话会确认后删掉它和它的测试。",
	prompt: "In packages/desktop/src/lib/sidebar-grouping.ts, groupLegacy has no callers. Delete it and its tests.",
};
const CALL: ToolCallContent = { type: "toolCall", id: "toolu_spawn", name: "spawn_session", arguments: { title: DETAILS.title, summary: DETAILS.summary, prompt: DETAILS.prompt } };
const run = (status: ToolRun["status"], details?: unknown, id = CALL.id, startedAt = 1): ToolRun => ({
	toolCallId: id, toolName: "spawn_session", summary: "Suggest session", args: CALL.arguments, status, startedAt,
	...(status === "running" ? {} : { result: { content: [], details } }),
});
const child = (callId = CALL.id, sessionId = "s-origin") => meta("s-new", { spawnedFrom: { sessionId, toolCallId: callId } });

/** What Start asked the main process for. */
let created: { cwd: string; modelId: string; initial: { content: UserContent[]; spawnedFrom?: unknown; displayText?: string; title?: string; worktree?: boolean } }[];
let prompted: { id: string; content: UserContent[]; options: unknown }[];
/** 开始以后改「交回这里」时问了主进程什么，和它怎么答。 */
let reportAsks: { id: string; on: boolean }[];
let reportAnswer: boolean;
const realOpen = useApp.getState().openSessionById;

beforeEach(() => {
	created = [];
	prompted = [];
	reportAsks = [];
	reportAnswer = true;
	localStorage.clear();
	useDismissedSuggestions.setState({ ids: [] });
	useEnvironmentCard.setState({ open: false, hidden: [] });
	Object.defineProperty(window, "plume", { configurable: true, value: {
		bootWindow: { id: "test", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
		sessions: {
			create: async (cwd: string, modelId: string, initial: { content: UserContent[]; spawnedFrom?: SessionMeta["spawnedFrom"] }) => {
				created.push({ cwd, modelId, initial });
				const fresh = meta("s-new", { title: "new", messageCount: 1, pendingPrompt: true, ...(initial.spawnedFrom ? { spawnedFrom: initial.spawnedFrom } : {}) });
				return { meta: fresh, messages: [{ role: "user", content: initial.content, timestamp: 1 }], running: true, pendingApprovals: [] };
			},
			reportBack: async (id: string, on: boolean) => {
				reportAsks.push({ id, on });
				return reportAnswer;
			},
		},
		agent: {
			prompt: async (id: string, content: UserContent[], options: unknown) => {
				prompted.push({ id, content, options });
				return meta(id, { title: "new", messageCount: 1, spawnedFrom: { sessionId: "s-origin", toolCallId: CALL.id } });
			},
		},
	} });
	useApp.setState({
		activeSessionId: "s-origin", meta: meta("s-origin"), sessions: [meta("s-origin")], sessionCache: {}, activity: {}, turns: {}, notices: [],
		workspace: { path: "/work/project", name: "project", isGitRepo: true, branch: "main" },
		settings: { defaultModelId: "fake/model", projects: [] } as never,
		toolRuns: { [CALL.id]: run("done", DETAILS) },
	});
});

afterEach(() => {
	Reflect.deleteProperty(window, "plume");
	useApp.setState({ toolRuns: {}, activeSessionId: null, sessions: [], sessionCache: {}, activity: {}, turns: {}, workspace: null, openSessionById: realOpen });
});

async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
	assert.ok(check(), `等不到：${what}`);
}

const scoped = (child: ReturnType<typeof h>) => h(SessionScope.Provider, { value: "s-origin" }, child);
const section = () => scoped(h(SuggestionsSection, { sessionId: "s-origin" }));
const FALLBACK = h("p", { "data-test-fallback": "" }, "tool row");
const card = (over: { run?: ToolRun; stopReason?: string; turnRunning?: boolean; block?: ToolCallContent } = {}) =>
	scoped(h(SessionSuggestionCard, { block: over.block ?? CALL, run: "run" in over ? over.run : useApp.getState().toolRuns[CALL.id], stopReason: (over.stopReason ?? "toolUse") as never, turnRunning: over.turnRunning ?? false, fallback: FALLBACK }));
const item = (view: Awaited<ReturnType<typeof mount>>) => view.all(`[data-ly-environment-suggestion="${CALL.id}"]`)[0];

// ---------------------------------------------------------------------------
// The Environment card's section: where a suggestion is started
// ---------------------------------------------------------------------------

test("环境卡片那一节：小标题、建议的标题、说明、一颗「开始」、一个收起", async () => {
	const view = await mount(section());
	try {
		assert.ok(view.text().includes(translate("sessionOps.suggested")));
		assert.equal(item(view)?.getAttribute("data-state"), "suggested");
		assert.equal(view.find("[data-ly-suggestion-title]").textContent, DETAILS.title);
		assert.equal(view.find("[data-ly-suggestion-summary]").textContent, DETAILS.summary);
		const start = view.find("[data-ly-suggestion-action]");
		assert.equal(start.getAttribute("data-ly-suggestion-action"), "start");
		assert.equal(start.textContent, translate("sessionOps.start"));
		assert.equal(start.getAttribute("data-variant"), "primary", "这一条上唯一要按的那一颗");
		assert.ok(view.find("[data-ly-suggestion-dismiss]"));
	} finally {
		await view.unmount();
	}
});

test("开始：在这个对话的项目里建会话、发出那段提示词，当前对话不切走；那一条缩成一行，说「进行中」", async () => {
	const view = await mount(section());
	try {
		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => prompted.length === 1, "第一条发出去");

		assert.deepEqual(created, [{
			cwd: "/work/project",
			modelId: "fake/model",
			// Named by the suggestion, and asked the composer's question with the setting's answer (off here).
			initial: { title: DETAILS.title, worktree: false, content: [{ type: "text", text: DETAILS.prompt }], spawnedFrom: { sessionId: "s-origin", toolCallId: CALL.id } },
		}]);
		assert.deepEqual(prompted, [{ id: "s-new", content: [{ type: "text", text: DETAILS.prompt }], options: { resumePending: true } }]);

		const state = useApp.getState();
		assert.equal(state.activeSessionId, "s-origin", "人还在原来那个对话里");
		assert.ok(state.sessions.some((session) => session.id === "s-new"), "新会话进了侧栏");
		assert.equal(state.activity["s-new"], "running", "而且在跑");

		await waitFor(() => item(view)?.getAttribute("data-state") === "started", "那一条翻成已开始");
		assert.equal(view.find("[data-ly-suggestion-status]").textContent, translate("sessionOps.running"));
		assert.equal(view.all("[data-ly-suggestion-summary]").length, 0, "开始以后只剩一行");
	} finally {
		await view.unmount();
	}
});

test("也能选在新工作树里开始：默认跟设置，选了就带下去，开始以后这个开关就没了", async () => {
	useApp.setState({ settings: { defaultModelId: "fake/model", projects: [], worktrees: { autoCreateOnNewSession: false } } as never });
	const view = await mount(section());
	try {
		const toggle = () => view.all<HTMLButtonElement>("[data-ly-worktree-toggle]")[0];
		assert.equal(toggle()?.getAttribute("aria-pressed"), "false");
		await click(toggle());
		assert.equal(toggle()?.getAttribute("aria-pressed"), "true");
		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => created.length === 1, "建会话");
		assert.equal(created[0].initial.worktree, true);
		await waitFor(() => item(view)?.getAttribute("data-state") === "started", "翻成已开始");
		assert.equal(toggle(), undefined, "a started conversation cannot be moved into a copy");
	} finally {
		await view.unmount();
	}
});

test("项目不是 Git 仓库：没有工作树开关，请求里也没有这一项", async () => {
	useApp.setState({ workspace: { path: "/work/project", name: "project", isGitRepo: false, branch: null } });
	const view = await mount(section());
	try {
		assert.equal(view.all("[data-ly-worktree-toggle]").length, 0);
		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => created.length === 1, "建会话");
		assert.equal(Object.hasOwn(created[0].initial, "worktree"), false);
	} finally {
		await view.unmount();
	}
});

test("开始以后，那一行说出那个会话在做什么：进行中、已完成、没跑完，看过之后回到已开始", async () => {
	useApp.setState({ sessions: [meta("s-origin"), child()] });
	const view = await mount(section());
	try {
		const said = () => view.find("[data-ly-suggestion-status]").textContent;
		for (const [activity, key] of [["running", "sessionOps.running"], ["waiting", "sessionOps.running"], ["done", "sessionOps.done"], ["failed", "sessionOps.failed"]] as const) {
			useApp.setState({ activity: { "s-new": activity } });
			await waitFor(() => said() === translate(key), `${activity} 时说 ${translate(key)}`);
			// 行首是侧栏那个标记：在跑是呼吸灯，跑完绿点，没跑完红点。
			assert.equal(view.find("[data-ly-status-mark]").getAttribute("data-ly-status-mark"), activity);
		}
		useApp.setState({ activity: {} });
		await waitFor(() => said() === translate("sessionOps.started"), "看过之后");
	} finally {
		await view.unmount();
	}
});

test("提建议的对话跑在自己的工作树里：新会话开在它所属的项目上，不开进那棵工作树", async () => {
	const inWorktree = { ...meta("s-origin", { cwd: "/work/project/.worktrees/plume-fix" }), worktree: { project: "/work/project", branch: "plume/fix" } } as SessionMeta;
	useApp.setState({ meta: inWorktree, sessions: [inWorktree], workspace: { path: "/work/project/.worktrees/plume-fix", name: "project", isGitRepo: true, branch: "plume/fix" } });
	const view = await mount(section());
	try {
		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => created.length === 1, "建会话");
		assert.equal(created[0].cwd, "/work/project");
	} finally {
		await view.unmount();
	}
});

test("「开始」的建会话请求留着口子：以后给的选项原样带下去，盖不掉来源", async () => {
	await useApp.getState().startSession(DETAILS.prompt, { sessionId: "s-origin", toolCallId: CALL.id }, { displayText: "看得见的那句" });
	assert.equal(created.length, 1);
	assert.equal(created[0].initial.displayText, "看得见的那句");
	assert.deepEqual(created[0].initial.spawnedFrom, { sessionId: "s-origin", toolCallId: CALL.id }, "选项盖不掉来源");
});

test("已开始：点那一行去那个会话；重开（会话列表里已有那条 spawnedFrom）一开始就是已开始", async () => {
	const opened: string[] = [];
	useApp.setState({ sessions: [meta("s-origin"), child()], openSessionById: async (id: string) => { opened.push(id); return true; } });
	const view = await mount(section());
	try {
		assert.equal(item(view)?.getAttribute("data-state"), "started");
		await click(view.find('[data-ly-suggestion-action="open"]'));
		assert.deepEqual(opened, ["s-new"]);
		assert.equal(created.length, 0, "没有再开一个");
	} finally {
		await view.unmount();
	}
});

test("等人决定的排在已开始的前面", async () => {
	const later: ToolCallContent = { ...CALL, id: "toolu_later" };
	useApp.setState({
		toolRuns: { [CALL.id]: run("done", DETAILS, CALL.id, 1), [later.id]: run("done", { ...DETAILS, title: "后来的那条" }, later.id, 2) },
		sessions: [meta("s-origin"), child()],
	});
	const view = await mount(section());
	try {
		const order = view.all("[data-ly-environment-suggestion]").map((one) => [one.getAttribute("data-ly-environment-suggestion"), one.getAttribute("data-state")]);
		assert.deepEqual(order, [["toolu_later", "suggested"], [CALL.id, "started"]]);
	} finally {
		await view.unmount();
	}
});

test("别的对话里同一个调用 id 开出来的会话，不算这一条的", async () => {
	useApp.setState({ sessions: [meta("s-origin"), child(CALL.id, "s-fork")] });
	const view = await mount(section());
	try {
		assert.equal(item(view)?.getAttribute("data-state"), "suggested");
	} finally {
		await view.unmount();
	}
});

test("收起只是这台机器上的事：那一条没了，整节空了就不画，重新挂上也不再出现", async () => {
	const view = await mount(section());
	try {
		await click(view.find("[data-ly-suggestion-dismiss]"));
		assert.equal(view.all("[data-ly-environment-section]").length, 0);
	} finally {
		await view.unmount();
	}
	assert.deepEqual(JSON.parse(localStorage.getItem("plume.sessionSuggestions.dismissed") ?? "[]"), [CALL.id], "记在 localStorage 里");
	const again = await mount(section());
	try {
		assert.equal(again.all("[data-ly-environment-suggestion]").length, 0);
		assert.equal(created.length, 0, "收起不是开始");
	} finally {
		await again.unmount();
	}
});

test("参数被退回的调用、还没返回的调用，都不列出来", async () => {
	for (const status of ["error", "running"] as const) {
		useApp.setState({ toolRuns: { [CALL.id]: run(status) } });
		const view = await mount(section());
		try {
			assert.equal(view.all("[data-ly-environment-section]").length, 0, status);
		} finally {
			await view.unmount();
		}
	}
});

// ---------------------------------------------------------------------------
// The card in the conversation: where the call was made
// ---------------------------------------------------------------------------

test("对话里的卡片：标题、说明、「开始」、收起，交回默认关；开始以后当前对话不切走，卡片缩成一行", async () => {
	const view = await mount(card());
	try {
		const frame = view.find("[data-ly-session-suggestion]");
		assert.equal(frame.getAttribute("data-ly-session-suggestion"), "suggested");
		assert.equal(view.find("[data-ly-suggestion-title]").textContent, DETAILS.title);
		assert.equal(view.find("[data-ly-suggestion-summary]").textContent, DETAILS.summary);
		assert.ok(view.find("[data-ly-suggestion-dismiss]"));
		assert.equal(view.find("[data-ly-suggestion-report]").getAttribute("aria-pressed"), "false", "模型没要就不交回");

		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => prompted.length === 1, "第一条发出去");
		assert.deepEqual(created[0].initial.spawnedFrom, { sessionId: "s-origin", toolCallId: CALL.id }, "不交回就不带这一项");
		assert.equal(useApp.getState().activeSessionId, "s-origin");
		await waitFor(() => view.find("[data-ly-session-suggestion]").getAttribute("data-ly-session-suggestion") === "started", "翻成已开始");
		// 在跑由摘要上的扫光说，不再有状态点和「进行中」。
		assert.equal(view.all("[data-ly-status-mark]").length, 0, "行首不是侧栏那枚状态点");
		assert.equal(view.all("[data-ly-suggestion-status]").length, 0, "行尾不写状态");
		assert.ok(view.find(".ly-glide"), "在跑：摘要上扫光");
		assert.equal(view.find('[data-ly-session-suggestion="started"] [data-ly-suggestion-report]').getAttribute("aria-pressed"), "false", "第一轮在跑，交回还能打开");
		assert.equal(view.all("[data-ly-suggestion-summary]").length, 0, "开始以后只剩一行");
	} finally {
		await view.unmount();
	}
});

test("交回：模型要了就默认开着，人能关；开着开始的，建会话请求里带着 reportBack", async () => {
	useApp.setState({ toolRuns: { [CALL.id]: run("done", { ...DETAILS, reportBack: true }) } });
	const view = await mount(card());
	try {
		const toggle = () => view.find("[data-ly-suggestion-report]");
		assert.equal(toggle().getAttribute("aria-pressed"), "true");
		await click(toggle());
		assert.equal(toggle().getAttribute("aria-pressed"), "false");
		await click(toggle());
		await click(view.find('[data-ly-suggestion-action="start"]'));
		await waitFor(() => created.length === 1, "建会话");
		assert.deepEqual(created[0].initial.spawnedFrom, { sessionId: "s-origin", toolCallId: CALL.id, reportBack: true });
	} finally {
		await view.unmount();
	}
});

test("参数还在写：卡片已经在，标题有多少画多少，「开始」按不动", async () => {
	const writing: ToolCallContent = { ...CALL, arguments: { title: "删掉没人" } };
	const view = await mount(card({ block: writing, run: undefined, stopReason: "pending" }));
	try {
		assert.equal(view.find("[data-ly-session-suggestion]").getAttribute("data-ly-session-suggestion"), "writing");
		assert.equal(view.find("[data-ly-suggestion-title]").textContent, "删掉没人");
		assert.equal(view.find<HTMLButtonElement>('[data-ly-suggestion-action="start"]').disabled, true);
		assert.equal(view.all("[data-test-fallback]").length, 0);
	} finally {
		await view.unmount();
	}
});

test("参数被退回、或这一轮在写完之前停了：没有卡片，照常是工具行", async () => {
	for (const over of [{ run: run("error") }, { run: undefined, stopReason: "aborted" }]) {
		const view = await mount(card(over));
		try {
			assert.equal(view.all("[data-ly-session-suggestion]").length, 0, JSON.stringify(over.stopReason ?? "error"));
			assert.equal(view.all("[data-test-fallback]").length, 1);
		} finally {
			await view.unmount();
		}
	}
});

test("卡片开始以后：点那一行去那个会话；收起以后只是一句记录，点不动", async () => {
	const opened: string[] = [];
	useApp.setState({ sessions: [meta("s-origin"), child()], activity: { "s-new": "done" }, openSessionById: async (id: string) => { opened.push(id); return true; } });
	const view = await mount(card());
	try {
		// 跑完、看过之后都不写状态：「已完成」「已开始」对读的人没有信息。只有没跑完要说。
		assert.equal(view.all("[data-ly-suggestion-status]").length, 0);
		useApp.setState({ activity: {} });
		await waitFor(() => view.all("[data-ly-suggestion-status]").length === 0, "看过之后");
		useApp.setState({ activity: { "s-new": "failed" } });
		await waitFor(() => view.all("[data-ly-suggestion-status]")[0]?.textContent === translate("sessionOps.failed"), "没跑完");
		assert.equal(view.all("[data-ly-suggestion-report]").length, 0, "没在跑就没有交回开关");
		await click(view.find('[data-ly-suggestion-action="open"]'));
		assert.deepEqual(opened, ["s-new"]);
	} finally {
		await view.unmount();
	}
	useApp.setState({ sessions: [meta("s-origin")], activity: {} });
	useDismissedSuggestions.setState({ ids: [CALL.id] });
	const dismissed = await mount(card());
	try {
		assert.equal(dismissed.find("[data-ly-session-suggestion]").getAttribute("data-ly-session-suggestion"), "dismissed");
		assert.equal(dismissed.all("button").length, 0, "没有能按的");
		assert.ok(dismissed.text().includes(translate("sessionOps.dismissed")));
	} finally {
		await dismissed.unmount();
	}
});

test("开始以后改主意：第一轮还在跑时打开交回，问主进程、以 meta 为准；第一轮一结束开关就走", async () => {
	useApp.setState({ sessions: [meta("s-origin"), child()], activity: { "s-new": "running" } });
	const view = await mount(card());
	try {
		const toggle = () => view.all('[data-ly-session-suggestion="started"] [data-ly-suggestion-report]')[0];
		assert.equal(toggle()?.getAttribute("aria-pressed"), "false", "默认关");
		await click(toggle());
		assert.deepEqual(reportAsks, [{ id: "s-new", on: true }]);
		// 主进程答应了：写下的 meta 推过来，开关照它画。
		useApp.setState({ sessions: [meta("s-origin"), meta("s-new", { spawnedFrom: { sessionId: "s-origin", toolCallId: CALL.id, reportBack: true } })] });
		await waitFor(() => toggle()?.getAttribute("aria-pressed") === "true", "开着");

		reportAnswer = false;
		await click(toggle());
		assert.deepEqual(reportAsks.at(-1), { id: "s-new", on: false });
		await waitFor(() => toggle()?.getAttribute("aria-pressed") === "true", "答晚了：退回 meta 的样子");

		useApp.setState({ sessions: [meta("s-origin"), meta("s-new", { spawnedFrom: { sessionId: "s-origin", toolCallId: CALL.id, settled: true } })] });
		await waitFor(() => toggle() === undefined, "第一轮结束，开关走了");
	} finally {
		await view.unmount();
	}
});

// ---------------------------------------------------------------------------
// The toolbar button: a dot while one is waiting and the card is shut
// ---------------------------------------------------------------------------

test("标题栏按钮：有建议在等、卡片收着时挂一个圆点；开着卡片、关了那一节、收起了、开始了都不挂", async () => {
	const view = await mount(h(EnvironmentToggle));
	try {
		const dot = () => view.all("[data-ly-environment-dot]").length;
		assert.equal(dot(), 1);
		assert.ok(view.find("[data-ly-toolbar-button]").getAttribute("aria-label")?.includes(translate("environment.pendingSuggestions", { n: 1 })));

		useEnvironmentCard.setState({ open: true });
		await waitFor(() => dot() === 0, "卡片开着");
		useEnvironmentCard.setState({ open: false, hidden: ["suggestions"] });
		await waitFor(() => dot() === 0, "那一节关了");
		useEnvironmentCard.setState({ hidden: [] });
		await waitFor(() => dot() === 1, "那一节放回来");
		useDismissedSuggestions.setState({ ids: [CALL.id] });
		await waitFor(() => dot() === 0, "收起了");
		useDismissedSuggestions.setState({ ids: [] });
		useApp.setState({ sessions: [meta("s-origin"), child()] });
		await waitFor(() => dot() === 0, "开始了");
	} finally {
		await view.unmount();
	}
});
