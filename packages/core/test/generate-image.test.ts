/**
 * `generate_image`：设置里选的模型要真的到达工具，端点的几种返回格式都要收成图片并落盘。
 *
 * fetch 换成桩，不碰网络；`PLUME_HOME` 指到临时目录，图片落在那里，测完删掉。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { toolPolicy } from "../src/runtime/tool-policy.ts";
import { generateImageTool } from "../src/tools/image.ts";
import type { Message, ModelConfig, ProviderConfig, ToolContext } from "../src/types.ts";

/** 1×1 透明 PNG。 */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const model: ModelConfig = {
	id: "relay/gpt-image-1",
	providerId: "relay",
	modelId: "gpt-image-1",
	name: "GPT Image 1",
	contextWindow: 0,
	maxOutputTokens: 0,
	supportsThinking: false,
	supportsImages: true,
	supportsTools: false,
	samplingParams: { quality: "low" },
};
const provider: ProviderConfig = { id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", api: "openai-chat-completions", apiKey: "sk-test", enabled: true, models: [model] };

let home = "";
const savedHome = process.env.PLUME_HOME;
const realFetch = globalThis.fetch;
before(() => {
	home = mkdtempSync(join(tmpdir(), "plume-image-"));
	process.env.PLUME_HOME = home;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});
after(() => {
	if (savedHome === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

function ctx(imageModel: ToolContext["imageModel"]): ToolContext {
	return { cwd: home, sessionId: "s", state: new Map(), imageModel };
}

/** 记下每次请求，按顺序回放给定的响应。 */
function stubFetch(responses: Response[]): { url: string; init?: RequestInit }[] {
	const seen: { url: string; init?: RequestInit }[] = [];
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		seen.push({ url: String(url), init });
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		return next;
	}) as typeof fetch;
	return seen;
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("settings resolve the chosen image model for the run, and nothing when none is picked", () => {
	const settings: Settings = { ...DEFAULT_SETTINGS, providers: [provider], imageModelId: model.id };
	assert.equal(toolPolicy(settings, home).imageModel?.model.modelId, "gpt-image-1");
	assert.equal(toolPolicy({ ...settings, imageModelId: null }, home).imageModel, null);
	// 供应商停用了，选过的模型也不算数。
	assert.equal(toolPolicy({ ...settings, providers: [{ ...provider, enabled: false }] }, home).imageModel, null);
});

test("with no image model picked, the tool says where to pick one and sends nothing", async () => {
	const seen = stubFetch([]);
	const result = await generateImageTool.execute({ prompt: "a fox" }, ctx(null));
	assert.equal(result.isError, true);
	assert.match(text(result), /图片生成模型/);
	assert.equal(seen.length, 0);
});

test("a b64_json answer comes back as an image the model sees, saved to disk", async () => {
	const seen = stubFetch([Response.json({ data: [{ b64_json: PNG, revised_prompt: "a red fox" }] })]);
	const result = await generateImageTool.execute({ prompt: "a fox", size: "1024x1024" }, ctx({ provider, model }));

	assert.equal(result.isError, undefined);
	// baseUrl 已经以 /v1 结尾，不能再拼出 /v1/v1。
	assert.equal(seen[0].url, "https://relay.example/v1/images/generations");
	assert.equal((seen[0].init!.headers as Record<string, string>).authorization, "Bearer sk-test");
	assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { quality: "low", model: "gpt-image-1", prompt: "a fox", size: "1024x1024" });

	const image = result.content.find((c) => c.type === "image");
	assert.deepEqual(image, { type: "image", data: PNG, mimeType: "image/png" });
	const path = (result.details as { paths: string[] }).paths[0];
	assert.ok(path.startsWith(join(home, "session-media")), path);
	assert.equal(readFileSync(path).toString("base64"), PNG);
	assert.match(text(result), /a red fox/);
	// 图已经在对话里显示了，结果要告诉模型别再贴一个指向它的链接。
	assert.match(text(result), /不要再附图片链接或路径/);
});

test("a url answer is downloaded, since those links expire", async () => {
	const bytes = Buffer.from(PNG, "base64");
	const seen = stubFetch([
		Response.json({ data: [{ url: "https://cdn.example/fox" }] }),
		new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
	]);
	const result = await generateImageTool.execute({ prompt: "a fox" }, ctx({ provider, model }));

	assert.equal(seen[1].url, "https://cdn.example/fox");
	// 内容类型说的不是图片时，以文件头为准。
	assert.deepEqual(result.content.find((c) => c.type === "image"), { type: "image", data: PNG, mimeType: "image/png" });
});

test("a refused request reports the provider's own words", async () => {
	stubFetch([Response.json({ error: { message: "Your organization must be verified" } }, { status: 403 })]);
	const result = await generateImageTool.execute({ prompt: "a fox" }, ctx({ provider, model }));
	assert.equal(result.isError, true);
	assert.match(text(result), /HTTP 403/);
	assert.match(text(result), /must be verified/);
});

test("an Anthropic provider is turned away before any request", async () => {
	const seen = stubFetch([]);
	const result = await generateImageTool.execute({ prompt: "a fox" }, ctx({ provider: { ...provider, api: "anthropic-messages" }, model }));
	assert.equal(result.isError, true);
	assert.equal(seen.length, 0);
});

/** 两张参考图：一张内联在消息里，一张已经挪进 session-media，块里只剩文件名。 */
function conversationWithImages(): Message[] {
	const parkedName = `${"a".repeat(40)}.png`;
	mkdirSync(join(home, "session-media"), { recursive: true });
	writeFileSync(join(home, "session-media", parkedName), Buffer.from(PNG, "base64"));
	return [
		{ role: "user", content: [{ type: "text", text: "这张" }, { type: "image", data: "", mimeType: "image/png", media: parkedName }], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "还有这张" }, { type: "image", data: PNG, mimeType: "image/jpeg" }], timestamp: 2 },
	] as Message[];
}

test("recent_images sends the latest conversation images to the edits endpoint, parked ones included", async () => {
	const seen = stubFetch([Response.json({ data: [{ b64_json: PNG }] })]);
	const context = { ...ctx({ provider, model }), transcript: async () => conversationWithImages() };
	const result = await generateImageTool.execute({ prompt: "改成水墨风", recent_images: 2 }, context);

	assert.equal(result.isError, undefined, text(result));
	assert.equal(seen[0].url, "https://relay.example/v1/images/edits");
	const form = seen[0].init!.body as FormData;
	assert.ok(form instanceof FormData);
	assert.equal(form.get("model"), "gpt-image-1");
	assert.equal(form.get("prompt"), "改成水墨风");
	assert.equal(form.get("quality"), "low");
	const images = form.getAll("image[]") as File[];
	// 按出现的先后：先是挪出去的那张，再是内联的那张。
	assert.deepEqual(images.map((image) => image.type), ["image/png", "image/jpeg"]);
	assert.equal(Buffer.from(await images[0].arrayBuffer()).toString("base64"), PNG);
	assert.match(text(result), /参考 2 张图/);
});

test("images reads reference files from local paths", async () => {
	writeFileSync(join(home, "ref.png"), Buffer.from(PNG, "base64"));
	const seen = stubFetch([Response.json({ data: [{ b64_json: PNG }] })]);
	const result = await generateImageTool.execute({ prompt: "加一顶帽子", images: ["ref.png"] }, ctx({ provider, model }));
	assert.equal(result.isError, undefined, text(result));
	assert.equal(seen[0].url, "https://relay.example/v1/images/edits");
	assert.equal((seen[0].init!.body as FormData).getAll("image[]").length, 1);
});

test("asking for more conversation images than there are says so and sends nothing", async () => {
	const seen = stubFetch([]);
	const context = { ...ctx({ provider, model }), transcript: async () => conversationWithImages() };
	const result = await generateImageTool.execute({ prompt: "x", recent_images: 3 }, context);
	assert.equal(result.isError, true);
	assert.match(text(result), /只找到 2 张/);
	assert.equal(seen.length, 0);
});

test("images and recent_images together are refused", async () => {
	const result = await generateImageTool.execute({ prompt: "x", images: ["ref.png"], recent_images: 1 }, ctx({ provider, model }));
	assert.equal(result.isError, true);
});
