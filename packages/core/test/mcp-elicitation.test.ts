/**
 * MCP elicitation：服务器的 schema 变成哪几格、人的三种回答怎么交回去、问不了人的客户端怎么答。
 *
 * 后半段对着一台真的 SDK 服务器（`mcp-http-fixture.ts`）：它在工具调用中途发 `elicitation/create`，
 * 把拿到的回答记下来——要钉住的正是「服务器那头收到的是什么」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { McpManager } from "../src/mcp/client.ts";
import { elicitResult } from "../src/mcp/elicitation.ts";
import { checkFormValues, formFields, initialValues, UnsupportedFormError } from "../src/mcp/form.ts";
import { ApprovalGate, type PendingApproval } from "../src/runtime/approvals.ts";
import type { ApprovalDecision, ApprovalRequest } from "../src/types.ts";
import { FORM_SCHEMA, startMcpHttpFixture } from "./mcp-http-fixture.ts";

test("schema 到表单字段：四种原始类型、两种单选写法、格式和上下限都读出来", () => {
	const fields = formFields(FORM_SCHEMA);
	assert.deepEqual(fields, [
		{ name: "name", label: "Name", required: true, type: "string", minLength: 1 },
		{ name: "color", label: "color", required: false, type: "string", options: [{ value: "red", label: "Red" }, { value: "green", label: "Green" }] },
		{ name: "email", label: "email", required: false, type: "string", format: "email" },
		{ name: "age", label: "age", required: true, type: "integer", minimum: 0, maximum: 150 },
		{ name: "score", label: "score", required: false, type: "number" },
		{ name: "subscribe", label: "subscribe", required: false, type: "boolean", default: false },
	]);
	const titled = formFields({ type: "object", properties: { size: { type: "string", title: "尺寸", description: "选一个", oneOf: [{ const: "s", title: "小" }, { const: "l", title: "大" }], default: "s" } } });
	assert.deepEqual(titled, [{ name: "size", label: "尺寸", description: "选一个", required: false, type: "string", options: [{ value: "s", label: "小" }, { value: "l", label: "大" }], default: "s" }]);
	assert.deepEqual(initialValues(fields), { subscribe: false }, "复选框没有「没填」");
	assert.deepEqual(initialValues(titled), { size: "s" });
});

test("规范之外的类型整张表拒掉，不画一张缺格的表", () => {
	assert.throws(() => formFields({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }), UnsupportedFormError);
	assert.throws(() => formFields({ type: "object", properties: { nested: { type: "object", properties: {} } } }), UnsupportedFormError);
	assert.throws(() => formFields({ type: "string" }), UnsupportedFormError);
});

test("交上来的值按表单检查：必填、类型、选项、格式、上下限；没填的可选格不交", () => {
	const fields = formFields(FORM_SCHEMA);
	assert.deepEqual(checkFormValues(fields, { name: "Ada", age: 36, color: "", subscribe: true }), { ok: true, values: { name: "Ada", age: 36, subscribe: true } });
	assert.deepEqual(checkFormValues(fields, {}), { ok: false, problems: { name: "required", age: "required" } });
	assert.deepEqual(checkFormValues(fields, { name: "A", age: 1.5 }), { ok: false, problems: { age: "type" } });
	assert.deepEqual(checkFormValues(fields, { name: "A", age: 200 }), { ok: false, problems: { age: "maximum" } });
	assert.deepEqual(checkFormValues(fields, { name: "A", age: 3, color: "blue" }), { ok: false, problems: { color: "option" } });
	assert.deepEqual(checkFormValues(fields, { name: "A", age: 3, email: "nope" }), { ok: false, problems: { email: "format" } });
	assert.deepEqual(checkFormValues(fields, { name: "A", age: "3" }), { ok: false, problems: { age: "type" } }, "数字格交字符串不收，窗口要先换成数字");
});

test("卡片的回答换成协议的三种", () => {
	assert.deepEqual(elicitResult({ values: { a: 1 } }), { action: "accept", content: { a: 1 } });
	assert.deepEqual(elicitResult("reject"), { action: "decline" });
	assert.deepEqual(elicitResult("cancel"), { action: "cancel" });
});

const form: ApprovalRequest = { kind: "form", title: "Fixture", detail: "Who are you?", subject: "mcp_elicitation:fx", fields: formFields(FORM_SCHEMA) };

function gate(mode: "ask" | "auto" | "full" = "full", questionTimeoutMs = 60_000) {
	const asked: PendingApproval[] = [];
	const settled: string[] = [];
	const instance = new ApprovalGate({ mode: () => mode, cwd: () => "/tmp", ask: async (pending) => void asked.push(pending), remember: () => {}, settled: (id) => void settled.push(id), questionTimeoutMs });
	return { instance, asked, settled };
}

test("表单在完全访问模式下也要人来填；交的值不对不收", async () => {
	const { instance, asked } = gate("full");
	const answer = instance.request(form);
	await delay(0);
	assert.equal(asked.length, 1, "完全访问给的是许可，不是答案");
	const id = asked[0]!.id;
	assert.equal(instance.resolve(id, { values: { name: "A" } }), false, "缺 age");
	assert.equal(instance.resolve(id, "once"), false, "许可的回答不是表单的回答");
	assert.equal(instance.resolve(id, { values: { name: "Ada", age: 36 } }), true);
	assert.deepEqual(await answer, { values: { name: "Ada", age: 36 } });
});

test("拒绝是 reject（decline），超时、服务器撤回、收卡都是 cancel，卡片跟着下来", async () => {
	{
		const { instance, asked } = gate();
		const answer = instance.request(form);
		await delay(0);
		instance.resolve(asked[0]!.id, "reject");
		assert.equal(await answer, "reject");
	}
	{
		const { instance, settled } = gate("full", 20);
		assert.equal(await instance.request(form), "cancel", "没人答是取消，不是人说了不");
		assert.equal(settled.length, 1);
	}
	{
		const { instance, settled } = gate();
		const controller = new AbortController();
		const answer = instance.request(form, controller.signal);
		await delay(0);
		controller.abort();
		assert.equal(await answer, "cancel");
		assert.equal(settled.length, 1, "服务器取消了，卡片收走");
		assert.equal(instance.list().length, 0);
	}
	{
		const { instance } = gate();
		const answer = instance.request(form);
		await delay(0);
		instance.rejectAll();
		assert.equal(await answer, "cancel");
	}
});

const server = (url: string) => ({ id: "fx", name: "Fixture", transport: "http" as const, url, enabled: true });

test("能问人的才声明 elicitation；交上去的三种回答服务器原样收到", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	const answers: ApprovalDecision[] = [{ values: { name: "Ada", age: 36, subscribe: true } }, "reject", "cancel"];
	const asked: ApprovalRequest[] = [];
	const manager = new McpManager({
		timeoutMs: 5000,
		ask: async (request) => {
			asked.push(request);
			return answers.shift()!;
		},
	});
	t.after(() => manager.dispose());
	await manager.connectAll([server(fixture.url)]);
	assert.deepEqual(fixture.capabilities.at(-1)?.elicitation, { form: {} });
	const tool = manager.allTools().find((one) => one.name === "mcp__fx__ask")!;
	for (let i = 0; i < 3; i++) await tool.execute({}, { cwd: "/tmp", sessionId: "s" });
	assert.deepEqual(fixture.answers, [
		{ action: "accept", content: { name: "Ada", age: 36, subscribe: true } },
		{ action: "decline" },
		{ action: "cancel" },
	]);
	assert.equal(asked[0]?.kind, "form");
	assert.equal(asked[0]?.detail, "Who are you?");
	assert.equal(asked[0]?.title, "Fixture");
	assert.deepEqual(asked[0]?.fields?.map((field) => field.name), ["name", "color", "email", "age", "score", "subscribe"]);
});

test("同一台服务器同时来几张表单：一张一张问，一张也不丢", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	let open = 0;
	let most = 0;
	let n = 0;
	const manager = new McpManager({
		timeoutMs: 5000,
		ask: async () => {
			open += 1;
			most = Math.max(most, open);
			await delay(30);
			open -= 1;
			n += 1;
			return { values: { name: `p${n}`, age: n } };
		},
	});
	t.after(() => manager.dispose());
	await manager.connectAll([server(fixture.url)]);
	const tool = manager.allTools().find((one) => one.name === "mcp__fx__ask")!;
	await Promise.all([1, 2, 3].map(() => tool.execute({}, { cwd: "/tmp", sessionId: "s" })));
	assert.equal(most, 1, "同一时刻只摊开一张");
	assert.deepEqual(fixture.answers.map((answer) => answer.content?.name).sort(), ["p1", "p2", "p3"]);
});

test("问不了人的客户端：不声明能力，服务器硬发来就回 decline", async (t) => {
	const fixture = await startMcpHttpFixture();
	t.after(() => fixture.close());
	const manager = new McpManager({ timeoutMs: 5000 });
	t.after(() => manager.dispose());
	await manager.connectAll([server(fixture.url)]);
	assert.equal(fixture.capabilities.at(-1)?.elicitation, undefined);
	const result = await manager.allTools().find((one) => one.name === "mcp__fx__ask")!.execute({}, { cwd: "/tmp", sessionId: "s" });
	assert.equal(result.isError, false);
	assert.deepEqual(fixture.answers, [{ action: "decline" }]);
});
