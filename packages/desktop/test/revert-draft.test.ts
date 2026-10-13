import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, UserMessage } from "@plume/core";
import { attachmentBody, unmarkedIn } from "../src/lib/attachment-placeholders.ts";
import { draftFromUserMessage, lastUserMessageIndex } from "../src/lib/revert-draft.ts";

test("lastUserMessageIndex skips synthetic notes", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "go on" }], timestamp: 3, synthetic: true },
	] as Message[];
	assert.equal(lastUserMessageIndex(messages), 0);
});

test("draftFromUserMessage prefers displayText and keeps image pixels", () => {
	const message = {
		role: "user",
		content: [
			{ type: "image", mimeType: "image/png", data: "abc" },
			{ type: "text", text: attachmentBody("notes.md", "secret body") },
			{ type: "text", text: "look at this" },
		],
		displayText: "look at this",
		attachments: [
			{ name: "shot.png", kind: "image", mimeType: "image/png", label: "图片 1" },
			{ name: "notes.md", kind: "text", mimeType: "text/markdown", path: "/tmp/notes.md", label: "文档 1" },
		],
		sessionRefs: [{ id: "s1", title: "Earlier" }],
		timestamp: 1,
	} as UserMessage;
	const draft = draftFromUserMessage(message);
	assert.equal(draft.text, "look at this");
	assert.equal(draft.attachments.length, 2);
	assert.equal(draft.attachments[0].data, "abc");
	assert.equal(draft.attachments[0].label, "图片 1");
	assert.equal(draft.attachments[1].text, "secret body");
	assert.equal(draft.attachments[1].path, "/tmp/notes.md");
	assert.deepEqual(draft.sessionRefs, [{ id: "s1", title: "Earlier" }]);
});

test("draftFromUserMessage keeps the file name of an image parked in session-media", () => {
	// 真实照片几乎都超过内联上限：日志里的块只剩 media 名字。只拷 data 的话，重发出去是一行「contents not included」。
	const message = {
		role: "user",
		content: [
			{ type: "text", text: "改成竹林" },
			{ type: "image", mimeType: "image/png", data: "", media: "5448dd02.png" },
		],
		attachments: [{ name: "689839.PNG", kind: "image", mimeType: "image/png" }],
		timestamp: 1,
	} as UserMessage;
	const [image] = draftFromUserMessage(message).attachments;
	assert.equal(image.data, undefined);
	assert.equal(image.media, "5448dd02.png");
});

test("a restored draft already names its files, so none of them is marked again", () => {
	// 发出去的那句话就是 displayText，标记在里面。撤回/分叉递回输入框时再补一枚，同一份附件就提了两遍。
	const message = {
		role: "user",
		content: [
			{ type: "image", mimeType: "image/png", data: "abc" },
			{ type: "text", text: attachmentBody("notes.md", "body") },
			{ type: "text", text: "照着 【图片 1】 改，参考 【notes.md】" },
		],
		displayText: "照着 【图片 1】 改，参考 【notes.md】",
		attachments: [
			{ name: "image.png", kind: "image", mimeType: "image/png", label: "图片 1" },
			{ name: "notes.md", kind: "text", mimeType: "text/markdown", label: "notes.md" },
		],
		timestamp: 1,
	} as UserMessage;
	const draft = draftFromUserMessage(message);
	assert.deepEqual(unmarkedIn(draft.text, draft.attachments), []);
});

test("files the text does not mention are the ones still to be marked", () => {
	const shot = { name: "标注图.png", label: "标注图.png" };
	const notes = { name: "notes.md" };
	const twin = { name: "notes.md" };
	// 什么都没写：生成图「添加到对话」、查看器里标注完，都是这样递进来的。
	assert.deepEqual(unmarkedIn("", [shot]), [shot]);
	// 按名字加次序配对：一枚【notes.md】只认得第一份，同名的第二份还没有标记。
	assert.deepEqual(unmarkedIn("看 【notes.md】", [shot, notes, twin]), [shot, twin]);
	// 普通的中文方括号不是标记。
	assert.deepEqual(unmarkedIn("这个【重要】", [notes]), [notes]);
});
