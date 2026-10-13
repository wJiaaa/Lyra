/**
 * 环境卡片「引用」一节收哪些、不收哪些。
 *
 * 规则在 `features/environment/references.ts` 顶上：人放进来的图片、文件、带引号的 @ 引用；agent
 * 生成的图、`write` 新建的文件。改过的已有文件、读过的文件、不带引号的 @名字都不收。放在 `test/ui`
 * 是因为它借了输入框那边认附件门类和认 @ 引用的两条规则，那个域的出口要靠 tsx 才加载得起来。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type Message } from "@plume/core";
import { referencesIn } from "../../src/features/environment/references.ts";

const PNG = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}): Message => ({
	role: "user",
	timestamp: 0,
	content: [{ type: "text", text }],
	...extra,
});

const call = (id: string, name: string, args: Record<string, unknown>): Message => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	api: "openai-responses",
	provider: "p",
	model: "m",
	usage: emptyUsage(),
	stopReason: "toolUse",
	timestamp: 0,
});

const result = (id: string, name: string, details: unknown, content: Extract<Message, { role: "toolResult" }>["content"] = [], isError = false): Message => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content,
	details,
	isError,
	timestamp: 0,
});

test("人放进来的图片、文件和带引号的 @ 引用都收，按出现的那一问记轮次", () => {
	const messages: Message[] = [
		user("看这张图", {
			content: [{ type: "text", text: "看这张图" }, PNG],
			attachments: [{ name: "image.png", kind: "image", mimeType: "image/png" }, { name: "复现步骤.md", kind: "text", path: "/p/复现步骤.md" }],
		}),
		user("再看看 @\"src/a.ts\" 和 @reviewer、@\"docs/\"", { displayText: "再看看 @\"src/a.ts\" 和 @reviewer、@\"docs/\"" }),
	];
	const { images, files } = referencesIn(messages);
	assert.equal(images.length, 1);
	assert.equal(images[0].block, PNG);
	assert.deepEqual([images[0].turn, images[0].index], [1, 0]);
	// 子智能体 @reviewer 和以 / 结尾的目录都不算文件。
	assert.deepEqual(files.map((file) => [file.path, file.turn, file.index]), [["/p/复现步骤.md", 1, 0], ["src/a.ts", 2, 1]]);
});

test("agent 生成的图和新建的文件收，改写已有文件、失败的调用不收", () => {
	const messages: Message[] = [
		user("画一张图，再写个测试"),
		call("g", "image_generate", { prompt: "猫" }),
		result("g", "image_generate", { kind: "image_generate", paths: ["/home/.plume/session-media/abc.png"] }, [PNG]),
		call("w1", "write", { path: "test/new.test.ts" }),
		result("w1", "write", { kind: "write", path: "test/new.test.ts", created: true }),
		call("w2", "write", { path: "src/old.ts" }),
		result("w2", "write", { kind: "write", path: "src/old.ts", created: false }),
		call("w3", "write", { path: "src/failed.ts" }),
		result("w3", "write", { kind: "write", path: "src/failed.ts", created: true }, [], true),
		call("e", "edit", { path: "src/edited.ts" }),
		result("e", "edit", { kind: "edit", path: "src/edited.ts" }),
	];
	const { images, files } = referencesIn(messages);
	assert.deepEqual(images.map((image) => [image.path, image.name, image.turn]), [["/home/.plume/session-media/abc.png", "abc.png", 1]]);
	assert.deepEqual(files.map((file) => file.path), ["test/new.test.ts"]);
});

test("同一份文件只记第一次出现；续跑提示和运行时插入的消息不开新的一轮", () => {
	const messages: Message[] = [
		user("改 @\"src/a.ts\""),
		user("运行时说的话", { synthetic: true }),
		user("又是 @\"src/a.ts\""),
	];
	const { files } = referencesIn(messages);
	assert.deepEqual(files.map((file) => [file.path, file.turn]), [["src/a.ts", 1]]);
	assert.deepEqual(referencesIn([user("你好")]), { images: [], files: [] });
});

test("配不上附件的图片块照样收，名字留空", () => {
	const { images } = referencesIn([user("", { content: [PNG, PNG] })]);
	assert.equal(images.length, 2);
	assert.ok(images.every((image) => image.name === "" && image.turn === 1));
});
