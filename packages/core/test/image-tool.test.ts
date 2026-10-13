/**
 * `image_generate`：设置里选的模型要真的到达工具，对话里的图要能按 `#N` 指到，结果要落盘、说清楚。
 *
 * fetch 换成桩，不碰网络；`PLUME_HOME` 指到临时目录，图片落在那里，测完删掉。端点的各种回法在
 * `image-generate.test.ts`，这里只看工具这一层。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { resetImageRoutes } from "../src/images/generate.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";
import { RECENT_IMAGES_KEY } from "../src/images/recent.ts";
import { toolPolicy } from "../src/runtime/tool-policy.ts";
import { sessionMediaPath } from "../src/session/payload.ts";
import { imageTool } from "../src/tools/image.ts";
import type { Message, ModelConfig, ProviderConfig, Tool, ToolContext, ToolResult } from "../src/types.ts";

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
	samplingParams: { moderation: "low" },
};
const provider: ProviderConfig = { id: "relay", name: "Relay", baseUrl: "https://relay.example/v1", api: "openai-chat-completions", apiKey: "sk-test", enabled: true, models: [model] };

let home = "";
let workspace = "";
const savedHome = process.env.PLUME_HOME;
const realFetch = globalThis.fetch;
before(() => {
	home = mkdtempSync(join(tmpdir(), "plume-image-"));
	workspace = join(home, "project");
	mkdirSync(workspace, { recursive: true });
	process.env.PLUME_HOME = home;
});
afterEach(() => {
	globalThis.fetch = realFetch;
	resetImageRoutes();
});
after(() => {
	if (savedHome === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

function ctx(providers: ProviderConfig[], preferred: string | null = null, messages?: Message[]): ToolContext {
	return { cwd: workspace, sessionId: "s", state: new Map(), imageModels: { providers, preferred }, transcript: async () => messages ?? [] };
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

const drawn = () => Response.json({ data: [{ b64_json: PNG }] });
const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const sentImages = (init: RequestInit | undefined) => {
	const body = init?.body;
	return body instanceof FormData ? (body.getAll(body.has("image") ? "image" : "image[]") as File[]) : [];
};

test("settings carry every provider and the chosen default to the run", () => {
	const settings: Settings = { ...DEFAULT_SETTINGS, providers: [provider], imageModelId: model.id };
	assert.deepEqual(toolPolicy(settings, home).imageModels, { providers: [provider], preferred: model.id });
	assert.deepEqual(toolPolicy({ ...settings, imageModelId: undefined }, home).imageModels?.preferred, null);
});

test("with no image model configured, the tool says where to add one and sends nothing", async () => {
	const seen = stubFetch([]);
	for (const providers of [[], [{ ...provider, enabled: false }]]) {
		const result = await imageTool.execute({ prompt: "a fox" }, ctx(providers));
		assert.equal(result.isError, true);
		assert.match(text(result), /No image model is configured/);
	}
	assert.equal(seen.length, 0);
});

test("a model the user names is the one drawn with; an unknown name is not swapped for the default", async () => {
	const dalle: ModelConfig = { ...model, id: "relay/dall-e-3", modelId: "dall-e-3", name: "dall-e-3" };
	const both: ProviderConfig = { ...provider, models: [model, dalle] };
	const seen = stubFetch([drawn()]);
	const named = await imageTool.execute({ prompt: "a fox", model: "DALL-E-3" }, ctx([both], model.id));
	assert.equal(named.isError, undefined, text(named));
	assert.equal(JSON.parse(String(seen[0].init?.body)).model, "dall-e-3");

	const unknown = await imageTool.execute({ prompt: "a fox", model: "midjourney-v7" }, ctx([both], model.id));
	assert.equal(unknown.isError, true);
	assert.match(text(unknown), /gpt-image-1/);
	assert.equal(seen.length, 1, "nothing is sent for a name that matches no image model");
});

test("a drawing is saved as session media, shown to the model, and #1 now means it", async () => {
	const seen = stubFetch([Response.json({ data: [{ b64_json: PNG, revised_prompt: "a red fox" }] })]);
	const context = ctx([provider]);
	const result = await imageTool.execute({ prompt: "a fox", aspect_ratio: "16:9", quality: "max" }, context);
	assert.equal(result.isError, undefined, text(result));

	// baseUrl 已经以 /v1 结尾，不能再拼出 /v1/v1。
	assert.equal(seen[0].url, "https://relay.example/v1/images/generations");
	assert.equal((seen[0].init!.headers as Record<string, string>).authorization, "Bearer sk-test");
	// 比例和画质按 gpt-image 的说法翻过去；模型编辑器里的额外参数照样带上。
	assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { moderation: "low", model: "gpt-image-1", prompt: "a fox", n: 1, size: "1536x1024", quality: "high" });

	assert.deepEqual(result.content.find((c) => c.type === "image"), { type: "image", data: PNG, mimeType: "image/png" });
	const details = result.details as { paths: string[]; images: { media: string; width?: number; height?: number }[] };
	assert.ok(details.paths[0].startsWith(join(home, "session-media")), details.paths[0]);
	assert.equal(readFileSync(details.paths[0]).toString("base64"), PNG);
	assert.equal(sessionMediaPath(details.images[0].media), details.paths[0]);
	assert.deepEqual([details.images[0].width, details.images[0].height], [1, 1]);
	assert.match(text(result), /Drew 1 image with GPT Image 1 \(1×1\)/);
	assert.match(text(result), /a red fox/);
	// 图已经在对话里显示了，结果要告诉模型别再贴一个指向它的链接。
	assert.match(text(result), /Don't link the picture/);
	assert.deepEqual(context.state.get(RECENT_IMAGES_KEY), [{ media: details.images[0].media, mimeType: "image/png" }]);
});

test("a url answer is downloaded, since those links expire", async () => {
	const seen = stubFetch([Response.json({ data: [{ url: "https://cdn.example/fox" }] }), new Response(Buffer.from(PNG, "base64"), { headers: { "content-type": "application/octet-stream" } })]);
	const result = await imageTool.execute({ prompt: "a fox" }, ctx([provider]));
	assert.equal(seen[1].url, "https://cdn.example/fox");
	// 内容类型说的不是图片时，以文件头为准。
	assert.deepEqual(result.content.find((c) => c.type === "image"), { type: "image", data: PNG, mimeType: "image/png" });
});

test("a refused request reports the provider's own words and is not retried", async () => {
	const seen = stubFetch([Response.json({ error: { message: "Your organization must be verified" } }, { status: 403 })]);
	const result = await imageTool.execute({ prompt: "a fox" }, ctx([provider]));
	assert.equal(result.isError, true);
	assert.match(text(result), /must be verified/);
	assert.equal(seen.length, 1);
});

test("a spent quota is reported with when it resets, without waiting on it", async () => {
	const seen = stubFetch([new Response(JSON.stringify({ error: { message: "Your quota will reset after 1h52m45s." } }), { status: 429 })]);
	const result = await imageTool.execute({ prompt: "a fox" }, ctx([provider]));
	assert.equal(result.isError, true);
	assert.match(text(result), /no quota left\. It resets in about 1h 53m/);
	assert.equal(seen.length, 1);
	// 卡片据此直接说「额度用完」和恢复时间，不只是一行红字。
	const error = (result.details as { error?: { hint?: string; retryAfterMs?: number } }).error;
	assert.equal(error?.hint, "check-billing");
	assert.equal(error?.retryAfterMs, 6_765_000);
});

test("a retry in progress is reported to the window, so the card says it is retrying", async () => {
	stubFetch([new Response("busy", { status: 503, headers: { "retry-after": "0" } }), drawn()]);
	const progress: ToolResult[] = [];
	const result = await imageTool.execute({ prompt: "a fox" }, { ...ctx([provider]), onProgress: (partial) => progress.push(partial) });
	assert.equal(result.isError, undefined, text(result));
	const retries = progress.map((one) => (one.details as { retry?: { attempt: number } }).retry);
	const at = retries.findIndex(Boolean);
	assert.equal(retries[at]?.attempt, 1);
	assert.ok(retries.slice(at + 1).some((retry) => retry === undefined), "once the wait is over the card is told it is drawing again");
	assert.equal((result.details as { retry?: unknown }).retry, undefined, "the finished result carries no stale retry");
});

test("an Anthropic provider is turned away before any request", async () => {
	const seen = stubFetch([]);
	const result = await imageTool.execute({ prompt: "a fox" }, ctx([{ ...provider, api: "anthropic-messages" }]));
	assert.equal(result.isError, true);
	assert.equal(seen.length, 0);
});

/** 两张图：先一张已经挪进 session-media、块里只剩文件名的，后一张内联在消息里。 */
function conversationWithImages(): Message[] {
	const parkedName = `${"a".repeat(40)}.png`;
	mkdirSync(join(home, "session-media"), { recursive: true });
	writeFileSync(join(home, "session-media", parkedName), Buffer.from(PNG, "base64"));
	return [
		{ role: "user", content: [{ type: "text", text: "这张" }, { type: "image", data: "", mimeType: "image/png", media: parkedName }], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "还有这张" }, { type: "image", data: PNG, mimeType: "image/jpeg" }], timestamp: 2 },
	] as Message[];
}

test("#N picks conversation images newest first, parked ones included, and goes to the edits endpoint", async () => {
	const seen = stubFetch([drawn()]);
	const result = await imageTool.execute({ prompt: "改成水墨风", images: ["#2", "#1"] }, ctx([provider], null, conversationWithImages()));
	assert.equal(result.isError, undefined, text(result));
	assert.equal(seen[0].url, "https://relay.example/v1/images/edits");
	const form = seen[0].init!.body as FormData;
	assert.equal(form.get("model"), "gpt-image-1");
	assert.equal(form.get("prompt"), "改成水墨风");
	const images = sentImages(seen[0].init);
	// #2 是挪出去的那张，#1 是后贴的内联那张。
	assert.deepEqual(images.map((image) => image.type), ["image/png", "image/jpeg"]);
	assert.equal(Buffer.from(await images[0].arrayBuffer()).toString("base64"), PNG);
	assert.equal((result.details as { references: number }).references, 2);
});

test("#N past the end says how many there are and sends nothing", async () => {
	const seen = stubFetch([]);
	const result = await imageTool.execute({ prompt: "x", images: ["#3"] }, ctx([provider], null, conversationWithImages()));
	assert.equal(result.isError, true);
	assert.match(text(result), /has 2 images \(#1 is the newest\)/);
	assert.equal(seen.length, 0);
});

test("a picture in the workspace goes in by path; something that is not a picture is refused", async () => {
	writeFileSync(join(workspace, "ref.png"), Buffer.from(PNG, "base64"));
	writeFileSync(join(workspace, "notes.txt"), "hello");
	const seen = stubFetch([drawn()]);
	const ok = await imageTool.execute({ prompt: "加一顶帽子", images: ["ref.png"] }, ctx([provider]));
	assert.equal(ok.isError, undefined, text(ok));
	assert.equal(sentImages(seen[0].init).length, 1);

	const refused = await imageTool.execute({ prompt: "x", images: ["notes.txt"] }, ctx([provider]));
	assert.match(text(refused), /not a PNG, JPEG or WebP/);
});

test("an earlier drawing can be passed back by its path without asking to read it", async () => {
	stubFetch([drawn(), drawn()]);
	const first = await imageTool.execute({ prompt: "a boat" }, ctx([provider]));
	const path = (first.details as { paths: string[] }).paths[0];
	assert.ok(existsSync(path));
	// 没有授权通道的上下文读工作区外的文件会被拒；自己画的图不该被拦。
	const again = await imageTool.execute({ prompt: "a red sail", images: [path] }, ctx([provider]));
	assert.equal(again.isError, undefined, text(again));
});

test("when to draw and how much to say after is a guideline, only while the tool is loaded", async () => {
	const input = { cwd: "/w", skills: [], projectInstructions: [], platform: "darwin", modelName: "M", isGitRepo: false };
	const guidelines = (prompt: string) => /Guidelines:\n([\s\S]*?)\n\n/.exec(prompt)?.[1] ?? "";
	const withTool = guidelines(await buildSystemPrompt({ ...input, tools: [imageTool as unknown as Tool] }));
	assert.match(withTool, /^- When the user asks for a picture[^\n]*use `image_generate`/m);
	assert.match(withTool, /^- The picture is shown to the user as it arrives/m);
	// 项目准则换掉的是通用的那几条，工具自己的约束还在。
	const overridden = guidelines(await buildSystemPrompt({ ...input, tools: [imageTool as unknown as Tool], guidelinesOverride: "- Be brief." }));
	assert.match(overridden, /use `image_generate`/);
	assert.doesNotMatch(await buildSystemPrompt({ ...input, tools: [] }), /image_generate/);
});

test("before anything arrives, the window is told the shape to hold: as asked, or for an edit the input's", async () => {
	// 文件头里写 300×100，窗口占位要的就只有这个。
	const wide = Buffer.from(PNG, "base64");
	wide.writeUInt32BE(300, 16);
	wide.writeUInt32BE(100, 20);
	writeFileSync(join(workspace, "wide.png"), wide);
	const run = async (args: Record<string, unknown>) => {
		const progress: ToolResult[] = [];
		stubFetch([drawn()]);
		const result = await imageTool.execute(args as never, { ...ctx([provider]), onProgress: (partial) => progress.push(partial) });
		return { progress, result };
	};

	const edit = await run({ prompt: "make it night", images: ["wide.png"], count: 2 });
	assert.equal(edit.progress.length, 1);
	assert.deepEqual(edit.progress[0].content, []);
	const { startedAt, ...first } = edit.progress[0].details as { startedAt: number };
	assert.ok(startedAt > 0);
	assert.deepEqual(first, { kind: "image_generate", model: model.id, modelName: "GPT Image 1", aspectRatio: undefined, quality: undefined, count: 2, edit: true, shapeHint: 3 });

	const asked = await run({ prompt: "make it night", images: ["wide.png"], aspect_ratio: "1:1" });
	assert.equal((asked.progress[0].details as { shapeHint?: number }).shapeHint, undefined, "a shape asked for is the shape");
	assert.equal((asked.progress[0].details as { aspectRatio?: string }).aspectRatio, "1:1");
});
