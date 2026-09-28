import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { BUILTIN_AGENTS, DEFAULT_SETTINGS, type ModelConfig, type Settings } from "@plume/core";
import { AgentsSettings } from "../../src/features/settings/AgentsSettings.tsx";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";
import { I18nProvider } from "../../src/i18n/index.ts";

const model: ModelConfig = { id: "qa/model", modelId: "gpt-5.6-sol", providerId: "qa", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: true, supportsImages: false, supportsTools: true };
const settings: Settings = { ...DEFAULT_SETTINGS, defaultModelId: model.id, providers: [{ id: "qa", name: "QA", api: "openai-responses", baseUrl: "http://localhost", apiKey: "test", enabled: true, models: [model, { ...model, id: "qa/fast", name: "Fast", supportsThinking: false }] }] };
const capabilities = { agents: [{ name: "explore", source: "builtin", tools: "*", description: "Read" }], skills: [], skillDiagnostics: [], plugins: [], pluginDiagnostics: [], mcp: [], toolNames: [] } satisfies NonNullable<ReturnType<typeof useApp.getState>["capabilities"]>;
function setup(initial: Settings, save: (settings: Settings) => Promise<Settings>) {
	useApp.setState({ activeSessionId: "qa", meta: null, settings: initial, capabilities });
	Object.defineProperty(window, "plume", { configurable: true, value: { agentDefinitions: { list: async () => ({ records: BUILTIN_AGENTS.map(definition => ({ definition, id: definition.name, scope: "builtin", editable: true, customized: false, revision: "1", raw: "", shadowedSources: [] })), tools: [] }) }, sessions: { capabilities: async () => capabilities }, settings: { save } } });
}
async function choose(text: string) {
	const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith(text));
	assert.ok(item, text); await click(item);
}

test("built-in profiles are configurable before a session exists and while a cold session has no capabilities", async () => {
	for (const sessionId of [null, "cold-session"]) {
		setup(settings, async (next) => next);
		useApp.setState({ activeSessionId: sessionId, capabilities: null });
		Object.defineProperty(window, "plume", { configurable: true, value: { agentDefinitions: { list: async () => ({ records: BUILTIN_AGENTS.map(definition => ({ definition, id: definition.name, scope: "builtin", editable: true, customized: false, revision: "1", raw: "", shadowedSources: [] })), tools: [] }) }, sessions: { capabilities: async () => null } } });
		const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(AgentsSettings) }));
		try {
			// 名字来自 BUILTIN_AGENTS 本身，而不是抄一份：抄的那份在改名时不会红，只会悄悄少测两个。
			for (const name of BUILTIN_AGENTS.map((agent) => agent.name)) {
				assert.ok(view.host.querySelector(`[data-agent-profile="${name}"]`), `${sessionId}: ${name}`);
				assert.ok(view.host.querySelector(`[aria-label="${name} 模型"]`));
			}
			assert.ok(view.host.querySelector('[aria-label="compact 模型"]'));
			assert.equal(view.host.querySelector('[aria-label="compact 思考等级"]'), null);
		} finally { await view.unmount(); }
	}
});

test("choosing a project reloads the catalogue and lists only that project's own agents", async () => {
	setup({ ...settings, projects: [{ id: "project", name: "Project", path: "/qa-project", lastOpenedAt: 0 }] }, async next => next);
	const own = (description: string, scope: "user" | "project") => ({ definition: { ...BUILTIN_AGENTS[0], name: scope, description, source: scope === "project" ? "workspace" as const : "user" as const }, id: scope, scope, editable: true, customized: false, revision: "1", raw: "", shadowedSources: [] });
	Object.defineProperty(window, "plume", { configurable: true, value: { agentDefinitions: { list: async (projectId: string | null) => ({ records: projectId ? [own("Global policy", "user"), own("Project exploration policy", "project")] : [own("Global policy", "user")], tools: [] }) } } });
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(AgentsSettings) }));
	try {
		assert.match(view.text(), /Global policy/);
		await click(view.find("[data-ly-project-scope]")); await choose("Project");
		assert.match(view.text(), /Project exploration policy/);
		assert.doesNotMatch(view.text(), /Global policy/, "the user-level one belongs to the other scope");
	} finally { await view.unmount(); }
});

test("switching to a non-reasoning model clears the incompatible saved effort and offers no fake levels", async () => {
	let saved: Settings | undefined;
	setup({ ...settings, subAgentProfiles: { explore: { modelId: model.id, thinking: "ultra" } } }, async (next) => { saved = next; return next; });
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(AgentsSettings) }));
	try {
		await click(view.find('[aria-label="explore 模型"]')); await choose("Fast");
		assert.deepEqual(saved?.subAgentProfiles?.explore, { modelId: "qa/fast" });
		assert.equal(view.host.querySelector('[aria-label="explore 思考等级"]'), null);
		await click(view.find('[aria-label="explore 模型"]')); await choose("跟随主会话");
		assert.deepEqual(saved?.subAgentProfiles, {});
		assert.ok(view.host.querySelector('[aria-label="explore 思考等级"]'));
	} finally { await view.unmount(); }
});

test("unavailable profiles stay visibly invalid and a failed save preserves the previous setting", async () => {
	setup({ ...settings, subAgentProfiles: { explore: { modelId: "removed/model" } } }, async () => { throw new Error("disk full"); });
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(AgentsSettings) }));
	try {
		assert.match(view.text(), /模型不可用/);
		await click(view.find('[aria-label="explore 模型"]')); await choose("QA");
		assert.match(view.find('[role="alert"]').textContent ?? "", /disk full/);
		assert.equal(useApp.getState().settings?.subAgentProfiles?.explore.modelId, "removed/model");
		assert.equal(view.find<HTMLFieldSetElement>("fieldset").disabled, false);
	} finally { await view.unmount(); }
});
