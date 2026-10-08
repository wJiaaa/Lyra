import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, UserMessage } from "@plume/core";
import { attachmentBody } from "../src/lib/attachment-placeholders.ts";
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
