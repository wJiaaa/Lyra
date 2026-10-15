import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { ApprovalDecision } from "@plume/core";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { ApprovalOverlay } from "../../src/features/conversation/ApprovalOverlay.tsx";
import { PermissionChoices } from "../../src/features/conversation/PermissionChoices.tsx";
import { QuestionChoices } from "../../src/features/conversation/QuestionChoices.tsx";
import { RunningIndicator } from "../../src/features/conversation/RunningIndicator.tsx";
import { translate } from "../../src/i18n/translate.ts";
import { useApp } from "../../src/store/index.ts";
import { click, fire, mount, press } from "../helpers/mount.ts";

test("approval bodies preserve full content once and omit whitespace-only reasons", async () => {
	const previous = useApp.getState();
	const detail = "第一段需要完整保留。\n" + "长问题与路径 /workspace/very-long-name 需要换行。\n".repeat(50);
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({ activeSessionId: "owner", approvals: [{ id: "question", kind: "interactive", title: "需要你的意见", reason: detail.replaceAll("\n", "  "), detail, options: ["继续"], allowCustomInput: true }] });
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	try {
		assert.equal(view.find("pre").textContent, detail);
		assert.equal(view.all(".ly-approval-scroll p").length, 0);
		for (const reason of ["  \n\t", "独立原因应当保留"]) {
			await act(async () => { useApp.setState({ approvals: [{ ...useApp.getState().approvals[0], reason }] }); });
			assert.equal(view.all(".ly-approval-scroll p").length, reason.trim() ? 1 : 0);
			assert.equal(view.find("pre").textContent, detail);
		}
	} finally { await view.unmount(); useApp.setState(previous, true); }
});

/**
 * 一个会过期的问题，必须让人看见它在过期。
 *
 * 从前这个截止时刻只活在 gate 的 `setTimeout` 里：卡片看上去像会一直等下去，直到它悄悄地不等了。
 * 那一次是 941 个提交重写完、停下来问推不推，人离开六分钟，问题过期成了「拒绝」，而屏幕上从头到
 * 尾没有任何东西提过还剩多少时间。
 */
test("a question that can expire shows the time it has left, and one that cannot shows nothing", async (t) => {
	const previous = useApp.getState();
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({ activeSessionId: "owner", approvals: [{ id: "question", kind: "interactive", title: "需要你的意见", detail: "是否立即强制推送到远程？", options: ["确认推送"], expiresAt: 1_000_000 + 90_000 }] });
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	try {
		assert.match(view.host.textContent ?? "", /1:30/, "问题带着截止时刻进来，就该看得见还剩多少");
		await act(async () => { t.mock.timers.tick(31_000); });
		assert.match(view.host.textContent ?? "", /0:59/, "而且它要真的在走");

		// 早就过去的那个（崩在半路、没有 agent_end 收尾的一轮重放出来）不说「0:00 后失效」。
		await act(async () => { t.mock.timers.tick(60_000); });
		assert.doesNotMatch(view.host.textContent ?? "", /\d:\d\d/);

		// 没有截止时刻的那种也一样，不该凭空画一个倒计时。
		await act(async () => { useApp.setState({ approvals: [{ ...useApp.getState().approvals[0], expiresAt: undefined }] }); });
		assert.doesNotMatch(view.host.textContent ?? "", /\d:\d\d/);
	} finally { t.mock.timers.reset(); await view.unmount(); useApp.setState(previous, true); }
});

/**
 * An escalation card has no "stop asking".
 *
 * An escalation grants the one call and the core remembers nothing of it, so the button would be a
 * promise nothing keeps. The flag has to travel from the event to the card, and the window rebuilds
 * that event field by field in two places — either one drops a field it was not told about.
 */
test("an escalation card offers no 'stop asking', whichever way its event arrived", async () => {
	const { cachedEvent } = await import("../../src/store/cached-event.ts");
	const previous = useApp.getState();
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	const command = { type: "approval_request" as const, requestId: "cmd", toolCallId: "cmd", kind: "bash", title: "清理构建目录", detail: "rm -rf ../build", subject: "rm -rf ../build" };
	const escalation = {
		...command, requestId: "esc", toolCallId: "esc", title: "提权运行：清理构建目录",
		subject: "escalate:danger-full-access:rm -rf ../build", reason: "构建目录在工作区外面", escalation: "danger-full-access" as const,
	};
	useApp.setState({ activeSessionId: "owner", approvals: [] });
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	const labels = () => view.all("[data-ly-permission-choices] button").map((button) => button.textContent);
	try {
		await act(async () => { useApp.getState().applyEvent("owner", escalation); });
		assert.deepEqual(labels(), [translate("permission.reject"), translate("permission.once")]);
		assert.match(view.text(), /构建目录在工作区外面/, "the model's reason is what the card leads with");

		// An ordinary command keeps all three: the flag takes the button away, not the kind.
		await act(async () => { useApp.getState().applyEvent("owner", { type: "approval_settled", requestId: "esc" }); });
		await act(async () => { useApp.getState().applyEvent("owner", command); });
		assert.deepEqual(labels(), [translate("permission.reject"), translate("permission.never"), translate("permission.once")]);
	} finally { await view.unmount(); useApp.setState(previous, true); }

	// A conversation that is not on screen keeps the flag, and the reason, for when it comes back.
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const cached = { messages: [], toolRuns: {}, meta: { id: "away", title: "fixture", cwd: "/test", projectId: "p", projectName: "p", createdAt: 1, updatedAt: 1, modelId: "", messageCount: 0, seq: 1, usage } };
	const [kept] = cachedEvent(cached, escalation).state?.approvals ?? [];
	assert.equal(kept?.escalation, "danger-full-access");
	assert.equal(kept?.reason, "构建目录在工作区外面");
});

for (const permission of [false, true]) {
	test(`${permission ? "permission" : "question"} failures retain actionable buttons and permit one retry`, async () => {
		const answers: ApprovalDecision[] = [];
		let reject!: (error: Error) => void;
		const answer = async (decision: ApprovalDecision) => { answers.push(decision); return new Promise<void>((_, fail) => { reject = fail; }); };
		const view = await mount(permission ? h(PermissionChoices, { answer }) : h(QuestionChoices, { answer, options: ["继续"], allowCustomInput: true }));
		try {
			if (!permission) await click(view.find('input[type="radio"]'));
			const buttons = view.all<HTMLButtonElement>("button");
			assert.ok(buttons.every(button => button.querySelector("svg")), "every action has an icon");
			const submit = buttons.at(-1)!;
			await click(submit); await click(submit);
			assert.equal(answers.length, 1);
			assert.ok(buttons.every(button => button.disabled));
			await act(async () => { reject(new Error("连接暂时中断")); });
			assert.equal(view.find('[role="alert"]').textContent, "连接暂时中断");
			assert.ok(buttons.every(button => !button.disabled));
			await click(submit);
			assert.equal(answers.length, 2);
			assert.equal(view.all('[role="alert"]').length, 0);
		} finally { await view.unmount(); }
	});
}

test("custom answers sit on the last row, retain retry drafts and leave candidate keys native", async () => {
	const answers: ApprovalDecision[] = [];
	const view = await mount(h(QuestionChoices, { options: ["继续"], allowCustomInput: true, answer: async (decision) => { answers.push(decision); throw new Error("请重试"); } }));
	try {
		assert.equal(view.all('input[aria-label="自定义回答"]').length, 1);
		assert.equal(view.all("[data-ly-question-index]").length, 0);
		assert.equal(view.all("[data-ly-choice-kind]").length, 0);
		const input = view.find<HTMLInputElement>('input[aria-label="自定义回答"]');
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		setValue.call(input, "保留中文草稿");
		await fire(input, new Event("input", { bubbles: true }));
		await fire(input, new Event("compositionstart", { bubbles: true }));
		for (const key of ["Enter", "ArrowDown", "Escape"]) {
			const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing: true });
			await fire(input, event);
			assert.equal(event.defaultPrevented, false);
		}
		assert.equal(answers.length, 0);
		await fire(input, new Event("compositionend", { bubbles: true }));
		await fire(view.find("form"), new Event("submit", { bubbles: true, cancelable: true }));
		assert.deepEqual(answers, [{ answer: "保留中文草稿" }]);
		assert.equal(input.value, "保留中文草稿");
		await click(view.find("[data-ly-question-option]"));
		assert.equal(view.find<HTMLInputElement>("[data-ly-question-option] input").checked, true);
		await click(view.find("[data-ly-question-other]"));
		assert.equal(view.find<HTMLInputElement>('input[aria-label="自定义回答"]').value, "保留中文草稿");
	} finally { await view.unmount(); }
});

test("choice rows sit on a wash, not a hairline, and selection is only a fill", async () => {
	const single = await mount(h(QuestionChoices, { options: ["甲", "乙"], allowCustomInput: true, answer: async () => {} }));
	try {
		const row = single.find("[data-ly-question-option]");
		assert.match(row.className, /(?:^|\s)bg-card(?:\s|$)/);
		assert.doesNotMatch(row.className, /border-line/);
		assert.equal(single.find("[data-ly-question-footer]").className.includes("border-t"), false);
		assert.equal(single.all("[data-ly-choice-kind]").length, 0);
		assert.equal(single.all("[data-ly-question-index]").length, 0);
		await click(row);
		assert.match(single.find("[data-ly-question-option]").className, /bg-accent\/\[0\.08\]/);
	} finally { await single.unmount(); }
	const multi = await mount(h(QuestionChoices, { options: ["甲", "乙"], selectionMode: "multi", answer: async () => {} }));
	try {
		assert.equal(multi.find("form").getAttribute("data-ly-choice-mode"), "multi");
		assert.equal(multi.all("[data-ly-choice-kind]").length, 0);
	} finally { await multi.unmount(); }
});

test("digit keys pick numbered rows and 0 focuses the other field", async () => {
	const answers: ApprovalDecision[] = [];
	const view = await mount(h(QuestionChoices, { options: ["甲", "乙", "丙"], allowCustomInput: true, answer: async (decision) => { answers.push(decision); } }));
	try {
		assert.equal(view.all("[data-ly-question-index]").length, 0);
		await fire(view.find("form"), new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true }));
		assert.equal(view.all<HTMLInputElement>("[data-ly-question-option] input")[1].checked, true);
		await fire(view.find("form"), new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true }));
		assert.equal(view.find<HTMLInputElement>("[data-ly-question-other] input").checked, true);
		assert.equal(document.activeElement, view.find('input[aria-label="自定义回答"]'));
		await fire(view.find('input[aria-label="自定义回答"]'), new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }));
		assert.equal(view.find<HTMLInputElement>("[data-ly-question-other] input").checked, true);
		assert.equal(view.all<HTMLInputElement>("[data-ly-question-option] input")[0].checked, false);
	} finally { await view.unmount(); }
});

test("multi-select submits an array only after confirmation and skip does not select a recommendation", async () => {
	const answers: ApprovalDecision[] = [];
	const props = { selectionMode: "multi" as const, allowSkip: true, options: [{ label: "A", recommended: true }, "B"], answer: async (decision: ApprovalDecision) => { answers.push(decision); } };
	const view = await mount(h(QuestionChoices, props));
	try {
		assert.equal(view.all("input:checked").length, 0);
		await click(view.all("input")[0]); await click(view.all("input")[1]);
		assert.equal(answers.length, 0);
		await fire(view.find("form"), new Event("submit", { bubbles: true, cancelable: true }));
		assert.deepEqual(answers, [{ answer: ["A", "B"] }]);
		await view.rerender(h(QuestionChoices, { ...props, key: "next" }));
		await fire(view.find("input"), new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		assert.deepEqual(answers.at(-1), "skip");
	} finally { await view.unmount(); }
});

test("a cancelled plan stays cleared in the active view, cached view and transcript derivation", async () => {
	const { todosFrom } = await import("../../src/store/derive.ts");
	const { cachedEvent } = await import("../../src/store/cached-event.ts");
	const prior = useApp.getState();
	const todos = [{ content: "old work", status: "in_progress" as const }];
	const old = { role: "toolResult" as const, toolCallId: "t", toolName: "todo_write", content: [], isError: false, timestamp: 1, details: { kind: "todo", todos } };
	const cleared = { role: "user" as const, synthetic: true, clearsTaskPlan: true, content: [], timestamp: 2 };
	assert.deepEqual(todosFrom([old]), todos);
	assert.deepEqual(todosFrom([old, cleared]), []);
	useApp.setState({ activeSessionId: "cancelled", messages: [old], todos });
	try {
		await act(async () => { useApp.getState().applyEvent("cancelled", { type: "message_end", message: cleared }); });
		assert.deepEqual(useApp.getState().todos, []);
		const cached = { messages: [old], toolRuns: {}, meta: { id: "cancelled", title: "fixture", cwd: "/test", projectId: "p", projectName: "p", createdAt: 1, updatedAt: 1, modelId: "", messageCount: 1, seq: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
		assert.deepEqual(cachedEvent(cached, { type: "message_end", message: cleared }).state?.todos, []);
	} finally { useApp.setState(prior, true); }
});

test("the recommended chip sits beside the whole copy stack", async () => {
	const view = await mount(h(QuestionChoices, {
		options: [{ label: "跨框架方案", description: "基于有限态机，一次开发同时输出 React 与 Vue 组件库。", recommended: true }, "纯 CSS"],
		answer: async () => {},
	}));
	try {
		const row = view.find("[data-ly-question-option]");
		assert.match(row.className, /items-center/);
		assert.equal(view.find("[data-ly-question-recommended]").textContent, "推荐");
		assert.equal(view.find("[data-ly-question-recommended]").previousElementSibling?.querySelector("[data-ly-question-label]")?.textContent, "跨框架方案");
	} finally { await view.unmount(); }
});

test("folding the card keeps the body mounted and drives the reveal grid", async () => {
	const previous = useApp.getState();
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({
		activeSessionId: "fold",
		approvals: [{ id: "question", kind: "interactive", title: "需要你的意见", detail: "选一个", options: ["继续"], allowCustomInput: true }],
	});
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	try {
		const reveal = view.find(".ly-reveal");
		assert.equal(reveal.getAttribute("data-open"), "true");
		assert.equal(view.find("[data-ly-question-form]").hasAttribute("inert"), false);
		await click(view.find('button[aria-expanded="true"]'));
		assert.equal(view.find(".ly-reveal").getAttribute("data-open"), "false");
		assert.ok(view.find("[data-ly-question-form]"), "the form stays mounted so the fold can animate");
		assert.ok(view.find(".ly-reveal").hasAttribute("inert"));
	} finally { await view.unmount(); useApp.setState(previous, true); }
});

test("clicking the card's title folds it, not only the caret", async () => {
	const previous = useApp.getState();
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	useApp.setState({
		activeSessionId: "fold-title",
		approvals: [{ id: "question", kind: "interactive", title: "需要你的意见", detail: "选一个", options: ["继续"], allowCustomInput: true }],
	});
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay) }));
	try {
		await click(view.find("[data-approval-title]"));
		assert.equal(view.find(".ly-reveal").getAttribute("data-open"), "false", "the title folds the card");
		await click(view.find("[data-approval-title]"));
		assert.equal(view.find(".ly-reveal").getAttribute("data-open"), "true", "and opens it again");
		const head = view.find("[data-approval-head]");
		assert.equal(head.tagName, "BUTTON", "the head itself is the toggle, so the keyboard reaches it");
		assert.equal(head.getAttribute("aria-expanded"), "true");
		assert.equal(head.querySelectorAll("button").length, 0, "no button inside a button");
	} finally { await view.unmount(); useApp.setState(previous, true); }
});

test("a pending question replaces the thinking mutter with the dashed waiting line", async () => {
	const prior = useApp.getState();
	useApp.setState({
		activeSessionId: "wait",
		running: true,
		turnStartedAt: Date.now() - 50_000,
		turnTokens: 1200,
		approvals: [{ id: "q", kind: "interactive", title: "需要你的意见", detail: "选一个" }],
		messages: [],
		toolRuns: {},
		retrying: null,
		compactedAt: null,
	});
	const view = await mount(h(RunningIndicator));
	try {
		assert.equal(view.find("[data-ly-running]").getAttribute("data-ly-mood"), "waiting");
		assert.equal(view.find("[data-ly-running]").getAttribute("data-ly-waiting"), "question");
		assert.equal(view.all(".ly-dash").length, 1);
		assert.equal(view.all("canvas").length, 0);
		assert.match(view.text(), /等待你的回答/);
		assert.doesNotMatch(view.text(), /Wrestling/);
		await act(async () => { useApp.setState({ approvals: [{ id: "p", kind: "bash", title: "命令", detail: "ls" }] }); });
		assert.equal(view.find("[data-ly-waiting]").getAttribute("data-ly-waiting"), "approval");
		assert.match(view.text(), /等待你的批准/);
		assert.equal(view.all(".ly-dash").length, 1);
		// 计划审批也走提问通道，但这一行说的是计划，不是「回答」。
		await act(async () => { useApp.setState({ approvals: [{ id: "plan", kind: "interactive", subject: "submit_plan", title: "审批计划", detail: "# 计划" }] }); });
		assert.equal(view.find("[data-ly-waiting]").getAttribute("data-ly-waiting"), "plan");
		assert.match(view.text(), /等你审批计划/);
	} finally { await view.unmount(); useApp.setState(prior, true); }
});

/**
 * 计划模式交上来的计划：标题说的是「审批计划」，正文按 Markdown 画，选项和自由输入仍是业务提问那一套。
 * 正文画成 `<pre>` 时，人读到的是一堆 `##` 和 `-`。
 */
const PLAN_DETAIL = "# 登录换成 OAuth\n\n## 步骤\n1. 读登录模块\n2. 换成 OAuth\n3. 补测试";
const planApproval = (id = "plan") => ({ id, kind: "interactive" as const, subject: "submit_plan", title: "审批计划", detail: PLAN_DETAIL, options: ["批准，开始执行", "要改"], allowCustomInput: true, selectionMode: "single" as const, allowSkip: false });

async function planCard(id: string, permissionMode: "ask" | "auto") {
	const { planMarkdown } = await import("../../src/features/conversation/rows.tsx");
	const { providePlanOpener } = await import("../../src/app/plan-opener.ts");
	const { DEFAULT_SETTINGS } = await import("@plume/core");
	const answered: unknown[] = [];
	const saved: unknown[] = [];
	const opened: (string | undefined)[] = [];
	Object.defineProperty(window, "plume", { configurable: true, value: { agent: { approve: async (_session: string, _id: string, decision: unknown) => { answered.push(decision); } } } });
	providePlanOpener((screen) => opened.push(screen));
	useApp.setState({ activeSessionId: "owner", approvals: [planApproval(id)], settings: { ...DEFAULT_SETTINGS, permissionMode }, saveSettings: async (settings) => { saved.push(settings.permissionMode); } });
	const render = () => mount(h(LayoutProvider, { children: h(ApprovalOverlay, { renderPlan: planMarkdown }) }));
	return { render, answered, saved, opened, release: () => providePlanOpener(null) };
}

/*
 * 宽窗口里计划在右栏的计划面板里读：卡片只有标题、「打开计划」和一排动作，交上来时替人开一次面板。
 */
test("a submitted plan opens the plan pane once and is answered from one row of actions", async () => {
	const previous = useApp.getState();
	const card = await planCard("plan", "auto");
	let view = await card.render();
	try {
		assert.equal(view.find("[data-approval-title]").textContent, translate("plan.approvalTitle"));
		assert.equal(view.all("h2").length, 0, "计划正文在右栏，不在卡片里再画一遍");
		assert.equal(view.all("[data-ly-question-option]").length, 0, "不走业务提问的选项列表");
		assert.deepEqual(view.all("[data-plan-action]").map((button) => button.getAttribute("data-plan-action")), ["reject", "revise", "accept"], "已经是自动档，不给「接受并开启自动模式」");
		assert.equal(card.opened.length, 1, "交上来时替人打开计划面板");

		// 同一份计划重新挂一次卡片（切走再回来），人关掉的面板不再追着开。
		await view.unmount();
		view = await card.render();
		assert.equal(card.opened.length, 1);
		await click(view.find("[data-approval-open-plan]"));
		assert.equal(card.opened.length, 2, "「打开计划」随时能把面板叫回来");

		await click(view.find('[data-plan-action="accept"]'));
		assert.deepEqual(card.answered, [{ answer: "批准，开始执行" }]);
	} finally { card.release(); await view.unmount(); useApp.setState(previous, true); }
});

test("修改 sends what was typed with the plan pane's comments; Esc opens it, ⌘↵ in ask mode accepts and turns on auto", async () => {
	const { usePlanReview } = await import("../../src/store/plan-review.ts");
	const previous = useApp.getState();
	const card = await planCard("plan-revise", "ask");
	const view = await card.render();
	try {
		assert.deepEqual(view.all("[data-plan-action]").map((button) => button.getAttribute("data-plan-action")), ["reject", "revise", "accept", "accept-auto"]);
		await act(async () => { usePlanReview.getState().add("owner", { quote: "换成 OAuth", start: 0, end: 8, text: "先确认用哪个应用" }); });
		assert.equal(view.find("[data-approval-plan-comments]").textContent, translate("plan.commentCount", { n: 1 }));

		await press(view.find("[data-approval-card]"), "Escape");
		const field = view.find<HTMLTextAreaElement>("[data-plan-revise-input]");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "拆成两次");
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(view.find("[data-plan-send-revision]"));
		assert.deepEqual(card.answered, [{ answer: "拆成两次\n\n> 换成 OAuth\n\n先确认用哪个应用" }]);
	} finally { card.release(); await view.unmount(); useApp.setState(previous, true); }

	const again = await planCard("plan-auto", "ask");
	const second = await again.render();
	try {
		await press(second.find("[data-approval-card]"), "Enter", { metaKey: true });
		assert.deepEqual(again.saved, ["auto"], "先换到自动档");
		assert.deepEqual(again.answered, [{ answer: "批准，开始执行" }]);
	} finally { again.release(); await second.unmount(); useApp.setState(previous, true); }
});

// 窄窗口右栏一次只摆一格，开面板会把卡片盖住：不替人开，计划照旧画在卡片里。
test("in a compact window a submitted plan stays drawn in the card as markdown", async () => {
	const { planMarkdown } = await import("../../src/features/conversation/rows.tsx");
	const { providePlanOpener } = await import("../../src/app/plan-opener.ts");
	const previous = useApp.getState();
	const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
	Object.defineProperty(window, "plume", { configurable: true, value: {} });
	const opened: (string | undefined)[] = [];
	providePlanOpener((screen) => opened.push(screen));
	useApp.setState({ activeSessionId: "owner", approvals: [planApproval("plan-compact")] });
	const view = await mount(h(LayoutProvider, { children: h(ApprovalOverlay, { renderPlan: planMarkdown }) }));
	try {
		assert.equal(view.all("pre").length, 0, "计划不是一段原样文本");
		assert.equal(view.find(".ly-approval-scroll h2").textContent, "步骤");
		assert.equal(view.all(".ly-approval-scroll ol li").length, 3);
		assert.ok(view.find('[data-plan-action="revise"]'), "打回时能写一句为什么");
		assert.equal(opened.length, 0);
	} finally {
		providePlanOpener(null);
		await view.unmount();
		if (width) Object.defineProperty(window, "innerWidth", width);
		useApp.setState(previous, true);
	}
});
