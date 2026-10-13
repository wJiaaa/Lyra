/**
 * 生图画布在图到之前占的位置：要几张占几块，形状按要的比例，没说比例的改图按原图的比例；
 * 图到了按工具记下的宽高定尺寸，不等图片载入。
 *
 * 占错了的样子是图到的那一帧整块跳一下——方块变成横条，下面的对话跟着挪。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import type { ToolResult } from "@plume/core";
import { GeneratedImages } from "../../src/features/conversation/ImageCanvas.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const previous = useApp.getState();
afterEach(() => useApp.setState(previous, true));

async function draw(args: Record<string, unknown>, status: "running" | "done" | "error", result?: ToolResult) {
	useApp.setState({
		activeSessionId: "s",
		toolRuns: { g: { toolCallId: "g", toolName: "image_generate", summary: "Generate image 一只狐狸", args, status, startedAt: Date.now(), ...(result ? { result } : {}) } },
	});
	return mount(h(GeneratedImages, { calls: ["g"] }));
}

const widths = (view: Awaited<ReturnType<typeof draw>>, selector: string) => view.all(selector).map((element) => Math.round(Number.parseFloat(element.style.width)));

test("the place is held at the ratio asked for, one per picture", async () => {
	const view = await draw({ prompt: "一只狐狸", aspect_ratio: "16:9", count: 2 }, "running");
	assert.deepEqual(widths(view, '[data-ly-canvas="pending"]'), [427, 427]);
	await view.unmount();
});

test("an edit with no ratio asked is held at the shape of the picture it starts from", async () => {
	const progress: ToolResult = { content: [], details: { kind: "image_generate", count: 1, shapeHint: 3 } };
	const view = await draw({ prompt: "改成夜景", images: ["#1"] }, "running", progress);
	assert.deepEqual(widths(view, '[data-ly-canvas="pending"]'), [720]);
	await view.unmount();
});

test("nothing said about the shape is a square", async () => {
	const view = await draw({ prompt: "一只狐狸" }, "running");
	assert.deepEqual(widths(view, '[data-ly-canvas="pending"]'), [240]);
	await view.unmount();
});

test("a finished picture takes the size the tool read from it, before it has loaded", async () => {
	const result: ToolResult = {
		// 落在 session-media 的图：测试里不会真的载入，量到的就是载入前的尺寸。
		content: [{ type: "text", text: "Drew 1 image" }, { type: "image", data: "", media: "a.png", mimeType: "image/png" }],
		details: { kind: "image_generate", count: 1, images: [{ media: "a.png", mimeType: "image/png", width: 1536, height: 1024 }] },
	};
	const view = await draw({ prompt: "一只狐狸" }, "done", result);
	assert.deepEqual(widths(view, '.ly-canvas[data-ly-canvas]'), [360]);
	await view.unmount();
});

const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "";

test("while drawing, the line above says the stage and the last place carries the estimate", async () => {
	const progress: ToolResult = { content: [], details: { kind: "image_generate", count: 2, model: "relay/gemini-3.1-flash-image", modelName: "Gemini", startedAt: Date.now() } };
	const view = await draw({ prompt: "一只狐狸", count: 2 }, "running", progress);
	assert.equal(text("figcaption"), "正在理解需求");
	assert.equal(view.all("[data-ly-image-progress]").length, 1, "one reading for the whole card");
	assert.match(text("[data-ly-image-progress]"), /^\d+%$/);
	await view.unmount();
});

test("a retry in progress is said as one, not as a stage that is not happening", async () => {
	const progress: ToolResult = { content: [], details: { kind: "image_generate", count: 1, startedAt: Date.now(), retry: { attempt: 1, delayMs: 2000, reason: "503" } } };
	const view = await draw({ prompt: "一只狐狸" }, "running", progress);
	assert.equal(text("figcaption"), "连接不稳，正在重试");
	await view.unmount();
});

test("once drawn, the line names the model and the size, and the picture has edit and download", async () => {
	const result: ToolResult = {
		content: [{ type: "text", text: "Drew 1 image" }, { type: "image", data: "", media: "a.png", mimeType: "image/png" }],
		details: { kind: "image_generate", count: 2, modelName: "GPT Image 1", images: [{ media: "a.png", mimeType: "image/png", width: 1536, height: 1024 }] },
	};
	const view = await draw({ prompt: "一只狐狸", count: 2 }, "done", result);
	assert.equal(text("figcaption"), "GPT Image 1 · 1536×1024 · 1 张没有生成出来");
	await view.unmount();
});

test("a spent quota is a card that says so and when it comes back", async () => {
	const result: ToolResult = {
		content: [{ type: "text", text: "no quota left" }],
		isError: true,
		details: { kind: "image_generate", count: 1, modelName: "GPT Image 1", error: { summary: "quota", hint: "check-billing", retryAfterMs: 6_765_000 } },
	};
	const view = await draw({ prompt: "一只狐狸" }, "error", result);
	assert.match(text('[data-ly-image-card="error"]'), /GPT Image 1 的额度用完了.*约 1h 53m 后恢复/);
	await view.unmount();
});

test("a failure with nothing recorded about it stays in the tool's own row", async () => {
	const view = await draw({ prompt: "一只狐狸" }, "error", { content: [{ type: "text", text: "bad" }], isError: true });
	assert.equal(view.all("[data-ly-image-card]").length, 0);
	await view.unmount();
});
