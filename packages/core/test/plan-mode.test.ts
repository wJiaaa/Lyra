/**
 * 计划模式：工具表不变、执行期拒绝；批准那一刻开关关掉、步骤进清单、计划跨压缩不丢。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { ApprovalGate } from "../src/runtime/approvals.ts";
import { compactIfNeeded } from "../src/runtime/compaction/compaction.ts";
import { inPlanMode, PLAN_MODE_KEY, planModeTools, renderPlan } from "../src/runtime/plan-mode.ts";
import { PLAN_APPROVE, PLAN_REVISE, submitPlanTool } from "../src/runtime/plan-tool.ts";
import { formatTaskContext, taskContextFromHistory } from "../src/runtime/compaction/task-context.ts";
import { TODOS_KEY } from "../src/tools/todo.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool, type ToolContext } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text ?? "").join("");

/** 一个只记录自己有没有跑过、跑的时候拿到什么沙箱的假工具。 */
function fake(name: string, extra: Partial<Tool> = {}) {
	const calls: { args: Record<string, unknown>; sandboxMode: string | undefined }[] = [];
	const tool = {
		name, description: name, parameters: { type: "object", properties: {} },
		execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
			calls.push({ args, sandboxMode: ctx.sandboxMode });
			return { content: [{ type: "text", text: `${name} ran` }] };
		},
		...extra,
	} as unknown as Tool;
	return { tool, calls };
}

const ctxWith = (state: Map<string, unknown>, sandboxMode = "workspace-write"): ToolContext =>
	({ cwd: "/tmp", sessionId: "s", state, sandboxMode }) as unknown as ToolContext;

test("in plan mode only read-only calls run, and the schemas are untouched", async () => {
	const state = new Map<string, unknown>([[PLAN_MODE_KEY, true]]);
	const edit = fake("edit", { mutating: true });
	const read = fake("read");
	const bash = fake("bash");
	const lsp = fake("lsp");
	const mcpRead = fake("mcp_db_query", { mutating: false });
	const mcpWrite = fake("mcp_db_insert", { mutating: true });
	const unknown = fake("something_new");
	const wrapped = planModeTools([edit.tool, read.tool, bash.tool, lsp.tool, mcpRead.tool, mcpWrite.tool, unknown.tool], state);
	for (const [index, tool] of wrapped.entries()) {
		const original = [edit, read, bash, lsp, mcpRead, mcpWrite, unknown][index].tool;
		assert.equal(tool.name, original.name);
		assert.equal(tool.description, original.description);
		assert.equal(tool.parameters, original.parameters, "the definition the model sees is the same object");
	}
	const [wEdit, wRead, wBash, wLsp, wMcpRead, wMcpWrite, wUnknown] = wrapped;
	const ctx = ctxWith(state);

	assert.match(textOf(await wEdit.execute({}, ctx)), /Plan mode: it can change things, so "edit" did not run/);
	assert.equal(edit.calls.length, 0);
	await wRead.execute({ path: "a" }, ctx);
	assert.equal(read.calls.length, 1);

	assert.match(textOf(await wBash.execute({ command: "rm -rf x" }, ctx)), /not recognised as read-only/);
	assert.match(textOf(await wBash.execute({ command: "ls", escalate: "danger-full-access" }, ctx)), /read-only sandbox/);
	await wBash.execute({ command: "ls -la" }, ctx);
	assert.deepEqual(bash.calls.map((call) => call.sandboxMode), ["read-only"], "a read-only command still runs confined");

	assert.match(textOf(await wLsp.execute({ operation: "rename", newName: "x" }, ctx)), /rename edits files/);
	await wLsp.execute({ operation: "references" }, ctx);
	assert.equal(lsp.calls.length, 1);

	await wMcpRead.execute({}, ctx);
	assert.equal(mcpRead.calls.length, 1, "an MCP tool that says it is read-only passes");
	assert.match(textOf(await wMcpWrite.execute({}, ctx)), /did not run/);
	assert.match(textOf(await wUnknown.execute({}, ctx)), /did not run/, "unknown tools are refused, not waved through");
	// 子代理拿到的是同一张包过的表、带着自己的状态图；管事的是包的时候那一张（主会话的）。
	assert.match(textOf(await wEdit.execute({}, ctxWith(new Map()))), /did not run/);
	assert.equal(edit.calls.length, 0);

	// 开关一关，同一张表原样放行，沙箱也回到外层给的那一档。
	state.set(PLAN_MODE_KEY, false);
	await wEdit.execute({}, ctx);
	await wBash.execute({ command: "rm -rf x" }, ctx);
	assert.equal(edit.calls.length, 1);
	assert.equal(bash.calls.at(-1)?.sandboxMode, "workspace-write");
});

function approvalFixture(mode: "ask" | "auto" | "full" = "full") {
	const gate = new ApprovalGate({ mode: () => mode, cwd: () => "/tmp", ask: async () => {}, remember: () => {} });
	const state = new Map<string, unknown>([[PLAN_MODE_KEY, true]]);
	const ctx: ToolContext = { ...ctxWith(state), requestApproval: (request) => gate.request(request) };
	return { gate, state, ctx };
}
const PLAN = { title: "改登录", steps: [{ what: "加 OAuth 回调", files: ["src/auth.ts"] }, { what: "补测试" }], risks: ["回调地址要配"], unknowns: [] };

test("approving the plan turns plan mode off and puts the steps on the task list", async () => {
	const { gate, state, ctx } = approvalFixture("full");
	const pending = submitPlanTool.execute(PLAN, ctx);
	const [request] = gate.list();
	assert.ok(request, "full access does not approve a plan by itself");
	assert.equal(request.request.subject, "submit_plan");
	assert.deepEqual(request.request.options, [PLAN_APPROVE, PLAN_REVISE]);
	assert.match(request.request.detail, /1\. 加 OAuth 回调（src\/auth\.ts）/);
	gate.resolve(request.id, { answer: PLAN_APPROVE });
	const result = await pending;
	assert.equal(result.isError, undefined);
	assert.equal(inPlanMode(state), false);
	assert.deepEqual(state.get(TODOS_KEY), [{ content: "加 OAuth 回调", status: "pending" }, { content: "补测试", status: "pending" }]);
	const details = result.details as { kind: string; plan: { steps: unknown[]; approvedAt: number } };
	assert.equal(details.kind, "plan");
	assert.equal(details.plan.steps.length, 2);
	assert.ok(details.plan.approvedAt > 0);
});

test("feedback sends the plan back without leaving plan mode; silence ends the turn", async () => {
	const { gate, state, ctx } = approvalFixture();
	let pending = submitPlanTool.execute(PLAN, ctx);
	gate.resolve(gate.list()[0].id, { answer: "第二步先做" });
	let result = await pending;
	assert.match(textOf(result), /Feedback: 第二步先做/);
	assert.equal(inPlanMode(state), true);
	assert.equal(result.terminate, undefined);

	pending = submitPlanTool.execute(PLAN, ctx);
	gate.resolve(gate.list()[0].id, { answer: PLAN_REVISE });
	assert.match(textOf(await pending), /no reason given/);

	pending = submitPlanTool.execute(PLAN, ctx);
	gate.rejectAll();
	result = await pending;
	assert.equal(result.terminate, true, "no feedback means nothing to revise: the person speaks next");
	assert.equal(inPlanMode(state), true);
});

test("a malformed plan is refused with a reason, and plan mode off has nothing to approve", async () => {
	const { ctx, state } = approvalFixture();
	assert.match(textOf(await submitPlanTool.execute({ steps: [] }, ctx)), /at least one step/);
	assert.match(textOf(await submitPlanTool.execute({ steps: [{ what: "  " }] }, ctx)), /nonempty `what`/);
	state.set(PLAN_MODE_KEY, false);
	assert.match(textOf(await submitPlanTool.execute(PLAN, ctx)), /Plan mode is off/);
});

const LOOP_MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const LOOP_PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [LOOP_MODEL] };
const said = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage =>
	({ role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content });
const call = (id: string, name: string, args: Record<string, unknown>) => said([{ type: "toolCall", id, name, arguments: args, argumentsText: JSON.stringify(args) }]);

test("one run: a write is refused, the plan is approved, the same tool table then writes", async () => {
	const state = new Map<string, unknown>([[PLAN_MODE_KEY, true]]);
	const edit = fake("edit", { mutating: true });
	const tools = planModeTools([edit.tool, submitPlanTool as unknown as Tool], state);
	const script = [call("c1", "edit", { path: "a" }), call("c2", "submit_plan", PLAN), call("c3", "edit", { path: "a" }), said([{ type: "text", text: "done" }], "stop")];
	let at = 0;
	const result = await runAgent(
		runConfig({
			session: { sessionId: "plan", systemPrompt: "x", messages: [{ role: "user", content: [{ type: "text", text: "改登录" }], timestamp: 1 }], state },
			model: { provider: LOOP_PROVIDER, model: LOOP_MODEL, streamFn: async () => script[Math.min(at++, script.length - 1)] },
			tools: { available: tools, requestApproval: async () => ({ answer: PLAN_APPROVE }), env: { cwd: "/tmp" } },
			control: { maxTurns: 6 },
		}),
		async () => {},
	);
	assert.equal(result.reason, "done");
	const results = result.messages.filter((message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult");
	assert.equal(results.length, 3);
	assert.equal(results[0].isError, true, "the first edit was refused");
	assert.equal(results[1].isError, false);
	assert.equal(results[2].isError, false, "after approval the same tool object runs");
	assert.equal(edit.calls.length, 1);
	assert.equal(inPlanMode(state), false);
});

test("the approved plan survives compaction beside the task list; feedback does not", async () => {
	const model: ModelConfig = { ...LOOP_MODEL, contextWindow: 20_000, maxOutputTokens: 2000 };
	const provider: ProviderConfig = { ...LOOP_PROVIDER, models: [model] };
	const reply = (text: string): AssistantMessage => said([{ type: "text", text }], "stop");
	const approved: Message = { role: "toolResult", toolName: "submit_plan", toolCallId: "p1", content: [{ type: "text", text: "approved" }], isError: false, timestamp: 1, details: { kind: "plan", plan: { ...PLAN, approvedAt: 5 } } };
	const feedback: Message = { ...approved, toolCallId: "p0", details: { kind: "plan-feedback", feedback: "再想想" } };
	const filler = Array.from({ length: 24 }, (_, i) => reply(`Details ${i}: ${"implementation ".repeat(180)}`));
	const stream = async function* () { yield { type: "start" as const, partial: reply("") }; return reply("A summary that forgets the plan."); };

	assert.equal(taskContextFromHistory([feedback]).plan, undefined);
	const context = taskContextFromHistory([feedback, approved]);
	assert.equal(context.plan?.steps.length, 2);
	assert.match(formatTaskContext(context), /User-approved plan/);
	assert.match(formatTaskContext(context), /2\. 补测试/);

	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "改登录" }], timestamp: 1 }, approved, ...filler];
	const first = await compactIfNeeded({ messages, model, provider, streamFn: stream, force: true });
	assert.ok(first);
	const second = await compactIfNeeded({ messages: [...first.messages, ...filler], model, provider, streamFn: stream, force: true });
	assert.ok(second);
	const text = second.messages.flatMap((m) => m.content).filter((b) => b.type === "text").map((b) => b.text).join("\n");
	assert.match(text, /1\. 加 OAuth 回调（src\/auth\.ts）/);
	assert.deepEqual(taskContextFromHistory(second.messages).plan, context.plan);
});

test("the system prompt explains plan mode only while it is on", async () => {
	const base = { cwd: "/tmp", tools: [], skills: [], projectInstructions: [], platform: "linux", modelName: "m", isGitRepo: false };
	assert.doesNotMatch(await buildSystemPrompt(base), /Plan mode is on/);
	assert.match(await buildSystemPrompt({ ...base, planMode: true }), /Plan mode is on[\s\S]*submit_plan/);
});

test("renderPlan leaves out empty sections", () => {
	const rendered = renderPlan({ steps: [{ what: "只有一步" }], risks: [], unknowns: [] });
	assert.equal(rendered, "## 步骤\n1. 只有一步");
});
