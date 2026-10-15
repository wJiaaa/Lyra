/**
 * 计划模式的一轮以正文收尾、计划却没交：提醒一次（`unsubmittedPlanCheck`）。
 *
 * 起因是 `a2637a66`：模型查了 32 次代码，把方案写成普通回复就结束了，审批卡没出现。这里守的是：
 * 调过工具又没交计划才问；交过计划、问过人、不在计划模式、一个工具都没调的都不问；问过一次就不再问。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { PLAN_MODE_KEY, planModeTools, UNSUBMITTED_PLAN_NOTE, unsubmittedPlanCheck } from "../src/runtime/plan-mode.ts";
import { submitPlanTool } from "../src/runtime/plan-tool.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const result = (toolName: string): Message => ({ role: "toolResult", toolName, toolCallId: toolName, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 });
const planState = (on = true) => new Map<string, unknown>([[PLAN_MODE_KEY, on]]);
const textOf = (message: Message | undefined) => (message?.role === "user" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "");

test("plan mode, tools called, no plan submitted: reminded once, then left alone", () => {
	const check = unsubmittedPlanCheck(planState(), () => [result("read"), result("grep")]);
	const first = check();
	assert.equal(textOf(first), UNSUBMITTED_PLAN_NOTE);
	assert.equal(first?.role === "user" && first.synthetic, true, "the window does not draw it as something the person typed");
	assert.equal(check(), undefined, "still no plan after the reminder: stop, do not loop");
});

test("a submitted plan or a question to the user is not reminded", () => {
	assert.equal(unsubmittedPlanCheck(planState(), () => [result("read"), result("submit_plan")])(), undefined);
	assert.equal(unsubmittedPlanCheck(planState(), () => [result("read"), result("ask_user")])(), undefined);
});

test("outside plan mode, or once the plan is approved, nothing is said", () => {
	assert.equal(unsubmittedPlanCheck(planState(false), () => [result("read")])(), undefined);
	assert.equal(unsubmittedPlanCheck(new Map(), () => [result("read")])(), undefined);
});

test("a run that called no tools is a conversation, not a missing plan", () => {
	// 本机实测：计划模式里没交计划的 4 次里 3 次是「你好」这类一个工具都没调的问答。
	assert.equal(unsubmittedPlanCheck(planState(), () => [])(), undefined);
});

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const said = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
	({ role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content });
const prose = (text: string) => said([{ type: "text", text }], "stop");
const readCall = said([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a" }, argumentsText: "{}" }], "toolUse");
const read = { name: "read", description: "read", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "a" }] }) } as unknown as Tool;

/** 跑一段剧本，`onStop` 接成和 `session-turn.ts` 一样：看这一轮写下的消息。剧本用完就算测试失败。 */
async function run(script: AssistantMessage[]) {
	const state = planState();
	const logged: Message[] = [];
	const check = unsubmittedPlanCheck(state, () => logged);
	let requests = 0;
	const outcome = await runAgent(
		runConfig({
			session: { sessionId: "plan", systemPrompt: "x", messages: [{ role: "user", content: [{ type: "text", text: "改登录" }], timestamp: 1 }], state },
			model: {
				provider: PROVIDER, model: MODEL,
				streamFn: async () => {
					assert.ok(requests < script.length, `request ${requests + 1} is past the end of the script`);
					return script[requests++];
				},
			},
			tools: { available: planModeTools([read, submitPlanTool as unknown as Tool], state), requestApproval: async () => ({ answer: "要改" }), env: { cwd: "/tmp" } },
			control: { maxTurns: 8, onStop: async () => check() },
		}),
		async (event) => {
			if (event.type === "message_end") logged.push(event.message);
		},
	);
	return { outcome, requests, notes: outcome.messages.filter((message) => textOf(message) === UNSUBMITTED_PLAN_NOTE).length };
}

test("in the loop: a plan written as prose gets one more request, a second prose reply ends the run", async () => {
	const { outcome, requests, notes } = await run([readCall, prose("方案：加一个显示字段入口"), prose("方案同上")]);
	assert.equal(outcome.reason, "done");
	assert.equal(requests, 3, "one extra request after the reminder, and no more");
	assert.equal(notes, 1);
});

test("in the loop: answering the reminder with submit_plan ends there", async () => {
	const submit = said([{ type: "toolCall", id: "p1", name: "submit_plan", arguments: { plan: "# 加显示字段\n\n## 改动\n- 入口" }, argumentsText: "{}" }], "toolUse");
	const { outcome, requests, notes } = await run([readCall, prose("方案：加一个显示字段入口"), submit, prose("等你改完再交")]);
	assert.equal(outcome.reason, "done");
	assert.equal(requests, 4);
	assert.equal(notes, 1, "the plan went in; the closing prose is not reminded again");
});
