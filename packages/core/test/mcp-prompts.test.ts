/**
 * MCP prompt：在 `/` 里叫什么、打的参数怎么对上声明、选中后发出去的是什么。
 *
 * 后半段连一台真的服务器（`mcp-http-fixture.ts`），因为「列表翻页」「展开回来的消息」都是协议的
 * 来回，对着一个假的对象测不出我们有没有照规范问。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/commands/expand.ts";
import { bindPromptArguments, findPrompt, promptArgumentHint, type McpPromptEntry } from "../src/commands/mcp-prompt.ts";
import { McpManager } from "../src/mcp/client.ts";
import { promptContent } from "../src/mcp/prompts.ts";
import { startMcpHttpFixture } from "./mcp-http-fixture.ts";

const review: McpPromptEntry = {
	name: "mcp__fx__review",
	server: "fx",
	serverName: "Fixture",
	prompt: "review",
	description: "Review",
	arguments: [{ name: "code", required: true }, { name: "language" }],
};
const single: McpPromptEntry = { ...review, name: "mcp__fx__ask", prompt: "ask", arguments: [{ name: "question", required: true }] };

test("`/mcp__服务器__prompt` 是一行命令：名字里的下划线不再把它挡在外面", () => {
	assert.deepEqual(parseInvocation("/mcp__fx__review a.ts"), { name: "mcp__fx__review", rest: "a.ts" });
	assert.equal(findPrompt([review], parseInvocation("/MCP__fx__Review")!)?.prompt, "review", "大小写不论");
	assert.equal(findPrompt([review], parseInvocation("/mcp__fx__other")!), undefined);
});

test("参数提示：必填的尖括号，可选的方括号，没有参数就没有提示", () => {
	assert.equal(promptArgumentHint(review), "<code> [language]");
	assert.equal(promptArgumentHint({ arguments: [] }), undefined);
});

test("参数按名字、按位置都能给；只有一个参数时整段就是它", () => {
	assert.deepEqual(bindPromptArguments(review, "x=1 ts"), { ok: true, args: { code: "x=1", language: "ts" } }, "不是声明过的名字，`x=1` 就是一个普通的值");
	assert.deepEqual(bindPromptArguments(review, 'language=go "a b"'), { ok: true, args: { code: "a b", language: "go" } });
	assert.deepEqual(bindPromptArguments(review, "code=f() language=rust"), { ok: true, args: { code: "f()", language: "rust" } });
	assert.deepEqual(bindPromptArguments(review, "one two three"), { ok: true, args: { code: "one", language: "two three" } }, "多出来的接在最后一个参数后面，不丢");
	assert.deepEqual(bindPromptArguments(single, "这个函数为什么慢 是不是 N+1"), { ok: true, args: { question: "这个函数为什么慢 是不是 N+1" } });
	assert.deepEqual(bindPromptArguments(single, "question=为什么"), { ok: true, args: { question: "为什么" } });
});

test("必填的没给就不发，说出缺的是哪几个", () => {
	assert.deepEqual(bindPromptArguments(review, ""), { ok: false, missing: ["code"] });
	assert.deepEqual(bindPromptArguments(review, "language=go"), { ok: false, missing: ["code"] });
	assert.deepEqual(bindPromptArguments({ arguments: [] }, ""), { ok: true, args: {} });
});

test("展开回来的消息按先后接成一条用户输入；资源只留文本，二进制留地址", () => {
	const content = promptContent([
		{ role: "user", content: { type: "text", text: "a" } },
		{ role: "assistant", content: { type: "text", text: "b" } },
		{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
		{ role: "user", content: { type: "resource", resource: { uri: "file:///x", text: "body" } } },
		{ role: "user", content: { type: "resource", resource: { uri: "file:///y", blob: "AAAA" } } },
	]);
	assert.deepEqual(content, [
		{ type: "text", text: "a" },
		{ type: "text", text: "b" },
		{ type: "image", data: "AAAA", mimeType: "image/png" },
		{ type: "text", text: "body" },
		{ type: "text", text: "[resource file:///y]" },
	]);
});

test("连上服务器：prompt 一页页列全，名字照工具的规则，展开时参数原样交给服务器", async (t) => {
	const fixture = await startMcpHttpFixture({ promptPage: 1 });
	const manager = new McpManager({ timeoutMs: 5000 });
	t.after(async () => {
		await manager.dispose();
		await fixture.close();
	});
	const [status] = await manager.connectAll([{ id: "fx", name: "Fixture", transport: "http", url: fixture.url, enabled: true }]);
	assert.equal(status?.state, "connected", status?.error);
	assert.deepEqual(manager.allPrompts().map((prompt) => prompt.name), ["mcp__fx__hello", "mcp__fx__review"], "每页一个，两页都要拿到");
	assert.deepEqual(status?.prompts?.map((prompt) => prompt.prompt).sort(), ["hello", "review"], "设置页、新对话的菜单读的是状态里这一份");
	const entry = manager.allPrompts().find((prompt) => prompt.prompt === "review")!;
	assert.deepEqual(entry.arguments, [{ name: "code", description: "The code", required: true }, { name: "language" }]);

	const content = await manager.getPrompt("mcp__fx__review", { code: "let x = 1", language: "ts" });
	assert.deepEqual(content, [
		{ type: "text", text: "Review this ts:" },
		{ type: "text", text: "let x = 1" },
	]);
	await assert.rejects(manager.getPrompt("mcp__fx__nothing", {}), /没有连着的 MCP 服务器提供/);
});
