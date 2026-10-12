import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "../src/runtime/session.ts";
import { mainChatExcerpt, mainMessageText, readMainChatTool as bind } from "../src/runtime/side-chat/sidechat-history.ts";
import { emptyUsage, type Message, type ModelConfig, type ToolResult } from "../src/types.ts";

const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: true, supportsTools: true, supportsImages: true };
const ctx = { cwd: process.cwd(), sessionId: "unrelated-caller", state: new Map<string, unknown>() };
/** The tool reads the main session live; these tests only need its id and messages. */
const readMainChatTool = (id: string, messages: Message[], selected: ModelConfig) => bind({ meta: { id }, messages } as unknown as AgentSession, () => selected);
const user = (text: string): Message => ({ role: "user", timestamp: 1, content: [{ type: "text", text }] });
interface Page {
	sessionId: string; totalMessages: number;
	messages: { index: number; text: string; offset: number; totalChars: number }[];
	next: { start: number; offset?: number; query?: string } | null;
}
function page(result: ToolResult): Page {
	const text = result.content[0]; assert.equal(text.type, "text");
	return JSON.parse(text.text);
}

test("every character of a long tool result can be paged without overlap or loss", async () => {
	const message: Message = { role: "toolResult", toolName: "read", toolCallId: "r", isError: false, timestamp: 1, content: [{ type: "text", text: "起点" + "😀 long output\n".repeat(5000) + "END_OF_OUTPUT" }] };
	const tool = readMainChatTool("bound-main", [message], model);
	let next: Page["next"] = { start: 0 }; let read = ""; let requests = 0;
	while (next) {
		const result = page(await tool.execute({ ...next, maxChars: 4096 }, ctx));
		assert.equal(result.sessionId, "bound-main"); assert.equal(result.totalMessages, 1);
		assert.equal(result.messages[0].offset, read.length);
		read += result.messages[0].text; next = result.next;
		assert.ok(++requests < 100);
	}
	assert.equal(read, mainMessageText(message));
});

test("hundreds of messages keep the snapshot bounded and early or late keyword matches stay searchable", async () => {
	const messages = Array.from({ length: 500 }, (_, index) => user(`${index}: ${"detail ".repeat(300)} ${index === 0 || index === 499 ? "NEEDLE" : "other"}`));
	const excerpt = mainChatExcerpt(messages, 0, model);
	assert.ok(excerpt.length < 14000);
	assert.match(excerpt, /Only the most recent part is shown/);
	const tool = readMainChatTool("main", messages, model);
	const first = page(await tool.execute({ query: "needle", limit: 1 }, ctx));
	assert.equal(first.messages[0].index, 0); assert.match(first.messages[0].text, /NEEDLE/);
	assert.ok(first.next);
	const last = page(await tool.execute(first.next, ctx));
	assert.equal(last.messages[0].index, 499); assert.match(last.messages[0].text, /NEEDLE/); assert.equal(last.next, null);
	assert.equal(page(await tool.execute({ query: "DOES_NOT_EXIST" }, ctx)).messages.length, 0);
});

test("visible reasoning and complete tool arguments are readable, opaque provider handles are not", async () => {
	const message: Message = { role: "assistant", api: "openai-responses", provider: "test", model: "model", usage: emptyUsage(), stopReason: "toolUse", timestamp: 1, content: [
		{ type: "thinking", thinking: "VISIBLE_REASONING", encrypted: "OPAQUE_SECRET", signature: "OPAQUE_SIGNATURE" },
		{ type: "toolCall", id: "x", name: "read", arguments: { path: "a".repeat(900) + "ARGS_END" } },
	] };
	const text = JSON.stringify(page(await readMainChatTool("main", [message], model).execute({}, ctx)));
	assert.match(text, /VISIBLE_REASONING/); assert.match(text, /ARGS_END/); assert.doesNotMatch(text, /OPAQUE_SECRET|OPAQUE_SIGNATURE/);
});

test("images are returned by content index only when the selected model supports them", async () => {
	const image = { type: "image", data: "cGl4ZWw=", mimeType: "image/png" } satisfies import("../src/types.ts").ImageContent;
	const message: Message = { role: "user", timestamp: 1, content: [{ type: "text", text: "Look" }, image] };
	assert.deepEqual((await readMainChatTool("main", [message], model).execute({ imageBlock: 1 }, ctx)).content[1], image);
	assert.equal((await readMainChatTool("main", [message], { ...model, supportsImages: false }).execute({ imageBlock: 1 }, ctx)).isError, true);
	assert.equal((await readMainChatTool("main", [message], model).execute({ imageBlock: 9 }, ctx)).isError, true);
});

test("invalid cursors cannot trigger unbounded reads or read other sessions", async () => {
	const tool = readMainChatTool("main", [user("hello")], model);
	for (const args of [{ start: -1 }, { start: Infinity }, { offset: 0.5 }, { limit: 0 }, { maxChars: NaN }]) assert.equal((await tool.execute(args, ctx)).isError, true);
	assert.equal(page(await tool.execute({ start: 100 }, ctx)).messages.length, 0);
	assert.deepEqual(page(await tool.execute({}, ctx)).messages.map((entry) => entry.index), [0]);
});
