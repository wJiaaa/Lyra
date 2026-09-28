/**
 * 设置页和编辑器上的那些脸：人人不同、新来的不撞脸、挑脸时别人的那张挑不走、存下去的就是看见的那张。
 *
 * 挂载真组件，数据走和窗口里一样的 `window.plume.agentDefinitions`——这一页的每个承诺都是关于
 * 「画出来的是什么」的，所以都从 DOM 上读。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { BUILTIN_AGENTS, DEFAULT_SETTINGS, type AgentDefinitionRecord, type AgentDefinitionSave, type Settings } from "@plume/core";
import { AgentsSettings } from "../../src/features/settings/AgentsSettings.tsx";
import { useApp } from "../../src/store/index.ts";
import { I18nProvider } from "../../src/i18n/index.ts";
import { click, fire, mount, type Mounted } from "../helpers/mount.ts";

const record = (definition: AgentDefinitionRecord["definition"], over: Partial<AgentDefinitionRecord> = {}): AgentDefinitionRecord => ({
	id: definition.name,
	definition,
	scope: definition.source === "builtin" ? "builtin" : "user",
	editable: true,
	customized: false,
	revision: "1",
	raw: "",
	shadowedSources: [],
	...over,
});

const records: AgentDefinitionRecord[] = [
	// 覆盖了内置的 general、文件里没写脸：它还是 general 那张。
	record({ ...BUILTIN_AGENTS[0], source: "user", avatar: undefined }, { id: "general-override", scope: "user", customized: true }),
	...BUILTIN_AGENTS.slice(1).map((definition) => record(definition)),
	// 手写的，没有 avatar 那一行：按名字算一张。
	record({ name: "boss", description: "编排者", systemPrompt: "BOSS", tools: "*", source: "user" }),
	record({ name: "docs-writer", description: "整理文档", systemPrompt: "Docs", tools: ["read"], source: "user", avatar: "ghost-plum" }),
];

async function open(save: (input: AgentDefinitionSave) => Promise<{ warning?: string }> = async () => ({})): Promise<Mounted> {
	const settings: Settings = { ...DEFAULT_SETTINGS };
	useApp.setState({ activeSessionId: null, meta: null, settings, capabilities: null, workspace: null });
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			agentDefinitions: {
				list: async () => ({ records, tools: ["read", "glob", "grep", "ls", "write", "edit", "bash", "task", "web_fetch", "mcp__qa__lookup"] }),
				read: async (_project: string | null, id: string) => records.find((one) => one.id === id),
				save: (_project: string | null, input: AgentDefinitionSave) => save(input),
			},
			sessions: { capabilities: async () => null },
		},
	});
	return mount(h(I18nProvider, { locale: "zh-CN", children: h(AgentsSettings) }));
}

const facesOf = (view: Mounted) =>
	Object.fromEntries(view.all<HTMLElement>("[data-agent-profile]").flatMap((row) => {
		const face = row.querySelector<HTMLElement>(".ly-avatar");
		return face ? [[row.dataset.agentProfile, face.dataset.avatar]] : [];
	}));

/** 「已安装」那一组右上角的「新建」。 */
const newButton = (view: Mounted) => {
	const found = view.all<HTMLButtonElement>("button").find((button) => button.textContent === "新建");
	assert.ok(found, "the new button is on the page");
	return found;
};

test("every agent on the page wears a different face, own ones listed apart from the built-in seven", async () => {
	const view = await open();
	try {
		const faces = facesOf(view);
		assert.equal(Object.keys(faces).length, BUILTIN_AGENTS.length + 2, JSON.stringify(faces));
		assert.equal(new Set(Object.values(faces)).size, Object.keys(faces).length, `no two alike: ${JSON.stringify(faces)}`);
		assert.equal(faces["docs-writer"], "ghost-plum", "a written face is drawn as written");
		assert.equal(faces.general, "circle-blue", "an override of general is still general's face");
		/*
		 * 这一页分「已安装」「内置智能体」两组，按定义从哪里来分：覆盖了内置的 general 是用户目录里的
		 * 一份文件，列在「已安装」里，行上标「内置 · 已自定义」。
		 */
		const sections = view.all<HTMLElement>("section");
		assert.match(sections[0].textContent ?? "", /已安装\s*3 项/);
		assert.ok(sections[0].querySelector('[data-agent-profile="boss"]') && sections[0].querySelector('[data-agent-profile="docs-writer"]'));
		assert.match(sections[0].querySelector('[data-agent-profile="general"]')?.textContent ?? "", /内置 · 已自定义/);
		assert.match(sections[1].textContent ?? "", new RegExp(`内置智能体\\s*${BUILTIN_AGENTS.length - 1} 项`));
		assert.ok(!sections[1].querySelector('[data-agent-profile="general"]'), "general is listed once, as the override");
	} finally { await view.unmount(); }
});

test("the whole row opens the editor, and the editor shows the face the row showed; a copy is somebody new", async () => {
	const view = await open();
	try {
		const faces = facesOf(view);
		// 整行铺着一层「编辑」按钮；行里的复制按钮先接住自己的点击，进的是复制，不是编辑。
		await click(view.find('[aria-label="编辑 docs-writer"]'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(view.find("[data-agent-avatar]").dataset.agentAvatar, faces["docs-writer"]);
		await click(view.find('[aria-label="返回智能体"]'));
		await click(view.find('[aria-label="编辑 boss"]'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(view.find("[data-agent-avatar]").dataset.agentAvatar, faces.boss);
		await click(view.find('[aria-label="返回智能体"]'));
		// 复制出来的是另一个人：换一张没人用的脸。
		await click(view.find('[aria-label="将 docs-writer 复制为新智能体"]'));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const copied = view.find("[data-agent-avatar]").dataset.agentAvatar ?? "";
		assert.ok(copied && !Object.values(faces).includes(copied), `the copy wears ${copied}, not one of ${Object.values(faces)}`);
		await click(view.find('[aria-label="返回智能体"]'));
	} finally { await view.unmount(); }
});

test("a new agent arrives with a face nobody has; shuffling gives another; somebody else's cannot be picked; saving writes the one shown", async () => {
	let saved: AgentDefinitionSave | undefined;
	const view = await open(async (input) => { saved = input; return {}; });
	try {
		const taken = new Set(Object.values(facesOf(view)));
		await click(newButton(view));
		const shown = () => view.find("[data-agent-avatar]").dataset.agentAvatar ?? "";
		const first = shown();
		assert.ok(first && !taken.has(first), `fresh face ${first} is not one of ${[...taken]}`);

		await click(view.find("[data-agent-shuffle]"));
		const second = shown();
		assert.ok(second !== first && !taken.has(second), `shuffled to ${second}`);

		// 挑脸：docs-writer 的那张（幽灵·梅紫）挑不走。先把形状换成幽灵，再去点梅紫。
		await click(view.find('[aria-label="换个形象"]'));
		const ghost = document.querySelector<HTMLElement>('[data-avatar-picker] [data-avatar-shape="ghost"]');
		assert.ok(ghost, "the picker opened");
		if (ghost.getAttribute("aria-disabled") !== "true") await click(ghost);
		const plum = document.querySelector<HTMLElement>('[data-avatar-picker] [data-avatar-color="plum"]');
		assert.ok(plum);
		if (shown().startsWith("ghost-")) {
			assert.equal(plum.getAttribute("aria-disabled"), "true", "ghost-plum is docs-writer's");
			assert.match(plum.dataset.lyTip ?? "", /@docs-writer/, "and the tip says whose it is");
			await click(plum);
			assert.notEqual(shown(), "ghost-plum", "clicking it changes nothing");
		}
		const sky = document.querySelector<HTMLElement>('[data-avatar-picker] [data-avatar-color="sky"]');
		assert.ok(sky);
		await click(sky);
		const chosen = shown();
		assert.ok(chosen.endsWith("-sky"), chosen);

		const setter = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
			const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
			element.dispatchEvent(new Event("input", { bubbles: true }));
		};
		setter(view.find<HTMLInputElement>('[aria-label="智能体调用名"]'), "qa-new");
		setter(view.find<HTMLInputElement>('[aria-label="智能体用途"]'), "Test");
		setter(view.find<HTMLTextAreaElement>('[aria-label="智能体指令"]'), "Do it.");
		await fire(view.find("form"), new Event("submit", { bubbles: true, cancelable: true }));
		assert.equal(saved?.draft.avatar, chosen, "the saved definition carries the face that was on screen");
	} finally { await view.unmount(); }
});
