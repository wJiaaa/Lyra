/**
 * 供应商的自定义请求头：一行一个「名字: 值」，边打字边存，半截的行不存。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { ProviderConfig } from "@lyra/core";

import { ProviderEditor } from "../../src/features/settings/ProviderEditor.tsx";
import { fire, mount } from "../helpers/mount.ts";

const provider: ProviderConfig = {
	id: "p",
	name: "OpenCode Go",
	baseUrl: "https://opencode.ai/zen/go",
	api: "openai-chat-completions",
	apiKey: "k",
	enabled: true,
	headers: { "x-opencode-session": "{{sessionId}}" },
	models: [],
};

async function type(field: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
	assert.ok(setter);
	setter.call(field, value);
	await fire(field, new Event("input", { bubbles: true }));
}

test("已有的请求头逐行显示；改动按行解析，没冒号和名字不合法的行跳过，清空即删除", async () => {
	const patches: Partial<ProviderConfig>[] = [];
	const noop = () => {};
	const view = await mount(
		h(ProviderEditor, {
			provider,
			defaultModelId: null,
			testResult: null,
			testing: false,
			onTest: noop,
			onChange: (patch: Partial<ProviderConfig>) => patches.push(patch),
			onRemove: noop,
			onEditModel: noop,
			onRemoveModel: noop,
			onSetDefault: noop,
		}),
	);
	const field = view.find<HTMLTextAreaElement>("textarea");
	assert.equal(field.value, "x-opencode-session: {{sessionId}}");

	await type(field, "x-opencode-session: {{sessionId}}\nuser-agent: Lyra/0.1\nhalf-typed\nbad name: x");
	assert.deepEqual(patches.at(-1), { headers: { "x-opencode-session": "{{sessionId}}", "user-agent": "Lyra/0.1" } });

	await type(field, "");
	assert.deepEqual(patches.at(-1), { headers: undefined });
	await view.unmount();
});
