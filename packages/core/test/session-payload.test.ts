import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INLINE_IMAGE_CHARS, parkMessage, slimJsonlLine } from "../src/session/payload.ts";
import { SessionStore } from "../src/session/store.ts";
import type { UserMessage } from "../src/types.ts";

test("slimJsonlLine drops oversized data without keeping the payload", () => {
	const blob = "A".repeat(20_000);
	const line = `{"type":"message","message":{"content":[{"type":"image","data":"${blob}","mimeType":"image/png"}]}}`;
	const slim = slimJsonlLine(line);
	assert.ok(slim.length < 200);
	assert.doesNotMatch(slim, /A{20}/);
	const parsed = JSON.parse(slim) as { message: { content: Array<{ data: string }> } };
	assert.equal(parsed.message.content[0]?.data, "");
});

test("a multi-megabyte image line slims without parsing the pixels", () => {
	const blob = "B".repeat(2_000_000);
	const line = `{"seq":1,"type":"message","message":{"role":"user","content":[{"type":"image","data":"${blob}","mimeType":"image/png"}],"timestamp":1}}`;
	const started = performance.now();
	const parsed = JSON.parse(slimJsonlLine(line)) as { message: { content: Array<{ data: string }> } };
	const elapsed = performance.now() - started;
	assert.equal(parsed.message.content[0]?.data, "");
	assert.ok(elapsed < 50, `slimmed a 2 MB line in ${elapsed.toFixed(1)}ms`);
});

test("append parks large images so the log line stays small; display load does not rehydrate", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-payload-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = join(root, "home");
	try {
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, "fake/model");
	const data = Buffer.alloc(6_100, 9).toString("base64");
	assert.ok(data.length > INLINE_IMAGE_CHARS);
	const message: UserMessage = {
		role: "user",
		content: [{ type: "image", mimeType: "image/png", data }],
		timestamp: 1,
	};
	await store.append(meta, { type: "message", message });
	assert.equal(message.content[0]?.type === "image" ? message.content[0].data : "", data, "live message keeps pixels");

	const records = [];
	for await (const record of store.read(meta.id)) records.push(record);
	const written = records.at(-1) as unknown as {
		message: { content: Array<{ data: string; media?: string }> };
	};
	assert.equal(written.message.content[0]?.data, "");
	assert.ok(written.message.content[0]?.media);

	const shown = await store.load(meta.id, { display: true });
	const shownImage = shown?.messages[0];
	assert.ok(shownImage?.role === "user" && shownImage.content[0]?.type === "image");
	if (shownImage?.role === "user" && shownImage.content[0]?.type === "image") {
		assert.equal(shownImage.content[0].data, "");
		assert.ok(shownImage.content[0].media);
	}

	const full = await store.load(meta.id);
	const fullImage = full?.messages[0];
	assert.ok(fullImage?.role === "user" && fullImage.content[0]?.type === "image");
	if (fullImage?.role === "user" && fullImage.content[0]?.type === "image") {
		assert.equal(fullImage.content[0].data, data);
	}
	} finally {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
	}
});

test("parkMessage does not touch a small icon", () => {
	const icon: UserMessage = {
		role: "user",
		content: [{ type: "image", mimeType: "image/png", data: "icon" }],
		timestamp: 1,
	};
	assert.equal(parkMessage(icon), icon);
});

test("deleting a conversation takes the pictures only it showed, and keeps the ones another still shows", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-payload-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = join(root, "home");
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	const store = new SessionStore(join(root, "sessions"));
	const picture = (fill: number): UserMessage => ({ role: "user", content: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(6_100, fill).toString("base64") }], timestamp: 1 });
	const doomed = await store.create(root, "fake/model");
	const kept = await store.create(root, "fake/model");
	await store.append(doomed, { type: "message", message: picture(1) });
	await store.append(doomed, { type: "message", message: picture(2) });
	await store.append(kept, { type: "message", message: picture(2) });
	const files = () => readdir(join(root, "home", "session-media"));
	assert.equal((await files()).length, 2, "the shared picture is one file");

	await store.deleteMany([doomed.id]);
	const left = await files();
	assert.equal(left.length, 1);
	const shown = await store.load(kept.id, { display: true });
	const image = shown?.messages[0]?.role === "user" ? shown.messages[0].content[0] : undefined;
	assert.equal(image?.type === "image" ? image.media : undefined, left[0], "the one still shown stays");
});
