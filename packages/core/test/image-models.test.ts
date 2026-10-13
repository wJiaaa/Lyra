/**
 * Which models draw, and which one a call means.
 *
 * Rules rather than plumbing, so they are pinned here one case at a time: a name misread as an image
 * model disappears from the chat picker, and a chat model read as one is offered to draw.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { imageModelRows, isImageModel, isImageModelId, resolveImageModel } from "../src/config/image-models.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { promptCapabilities } from "../src/runtime/prompt-context.ts";
import { imageTool } from "../src/tools/image.ts";
import type { Tool } from "../src/types.ts";
import type { ModelConfig, ProviderConfig } from "../src/types/provider.ts";

const model = (providerId: string, modelId: string, extra: Partial<ModelConfig> = {}): ModelConfig => ({
	id: `${providerId}/${modelId}`,
	providerId,
	modelId,
	name: modelId,
	contextWindow: 0,
	maxOutputTokens: 0,
	supportsThinking: false,
	supportsImages: true,
	supportsTools: true,
	...extra,
});

const provider = (id: string, models: ModelConfig[], enabled = true): ProviderConfig => ({
	id,
	name: id,
	baseUrl: "https://relay.example",
	api: "openai-responses",
	apiKey: "k",
	enabled,
	models,
});

test("image models are recognised by name, across the houses that make them", () => {
	for (const id of [
		"gpt-image-1",
		"gpt-image-2.5",
		"chatgpt-image-latest",
		"dall-e-3",
		"gemini-3.1-flash-image",
		"gemini-2.5-flash-image-preview",
		"gemini-3-pro-image-preview",
		"google/gemini-2.5-flash-image",
		"imagen-4.0-generate-001",
		"black-forest-labs/flux-1.1-pro",
		"flux.1-dev",
		"doubao-seedream-4-0-250828",
		"grok-2-image",
		"qwen-image",
		"nano-banana-pro",
	]) {
		assert.equal(isImageModelId(id), true, id);
	}
});

test("chat and vision models are not mistaken for image models", () => {
	for (const id of ["gpt-4o", "gpt-5", "o3", "gemini-3.8-flash-high", "gemini-2.5-flash", "claude-opus-4-5", "qwen3.8", "qwen-vl-max", "llama-3.2-11b-vision", "deepseek-v3", "glm-4v", "imagine-chat"]) {
		assert.equal(isImageModelId(id), false, id);
	}
});

test("a stored choice outranks the name, in both directions", () => {
	assert.equal(isImageModel(model("p", "gemini-3.1-flash-image", { imageOutput: false })), false);
	assert.equal(isImageModel(model("p", "house-artist", { imageOutput: true })), true);
	assert.equal(isImageModel(model("p", "house-artist")), false);
});

test("only enabled providers offer image models, in configured order", () => {
	const rows = imageModelRows([
		provider("off", [model("off", "gpt-image-1")], false),
		provider("relay", [model("relay", "gemini-3.8-flash-high"), model("relay", "gemini-3.1-flash-image")]),
		provider("openai", [model("openai", "gpt-image-1")]),
	]);
	assert.deepEqual(rows.map((row) => row.model.id), ["relay/gemini-3.1-flash-image", "openai/gpt-image-1"]);
});

test("the model a call means: named exactly, then uniquely in part, else the default", () => {
	const providers = [
		provider("relay", [model("relay", "gemini-3.1-flash-image"), model("relay", "gpt-image-2.5")]),
		provider("openai", [model("openai", "gpt-image-1"), model("openai", "dall-e-3")]),
	];
	assert.equal(resolveImageModel(providers, null).row?.model.id, "relay/gemini-3.1-flash-image");
	assert.equal(resolveImageModel(providers, "openai/dall-e-3").row?.model.id, "openai/dall-e-3");
	assert.equal(resolveImageModel(providers, "gone/model").row?.model.id, "relay/gemini-3.1-flash-image", "a default that no longer resolves falls back");
	assert.equal(resolveImageModel(providers, null, "GPT-Image-2.5").row?.model.id, "relay/gpt-image-2.5");
	assert.equal(resolveImageModel(providers, null, "dall").row?.model.id, "openai/dall-e-3");

	const ambiguous = resolveImageModel(providers, null, "gpt-image");
	assert.equal(ambiguous.row, undefined);
	assert.equal("reason" in ambiguous && ambiguous.reason, "ambiguous");

	const unknown = resolveImageModel(providers, null, "midjourney-v7");
	assert.equal("reason" in unknown && unknown.reason, "unknown", "an unknown name is not quietly replaced by the default");
	assert.equal(resolveImageModel([], null).row, undefined);
});

test("image_generate is offered only once there is an image model to draw with", () => {
	const tools = [imageTool as unknown as Tool];
	const offered = (providers: ProviderConfig[]) => promptCapabilities({ settings: { ...DEFAULT_SETTINGS, providers }, tools }).tools.map((tool) => tool.name);
	assert.deepEqual(offered([provider("relay", [model("relay", "gpt-5")])]), []);
	assert.deepEqual(offered([provider("relay", [model("relay", "gpt-image-1")], false)]), []);
	assert.deepEqual(offered([provider("relay", [model("relay", "gpt-5"), model("relay", "gpt-image-1")])]), ["image_generate"]);
});
