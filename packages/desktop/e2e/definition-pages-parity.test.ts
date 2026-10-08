/**
 * 插件、智能体、命令、钩子——四个定义页长成一个样子，两个编辑页也是。
 *
 * They drifted apart once already: each page had its own search box height, its own card, its own
 * row padding and title weight, and the subagent editor ran its fields 32px tall on a lighter fill.
 * Nothing caught it, because each page on its own looked finished.
 *
 * So every assertion here compares the pages with one another, never with a pixel value. A later
 * restyle that moves all four together passes untouched; one page moving on its own fails, and the
 * message names which one and what it measured.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { shot } from "./drive.ts";

let app: RunningApp;

const AGENT = "reviewer";
const AGENT_DETAIL = "审阅改动并指出风险";
const COMMAND_DETAIL = "按仓库约定审一遍当前改动";
const PLUGIN = "Git Helper";
const PLUGIN_DETAIL = "提交、分支与变基的常用操作";

/** One entry per page: its settings nav label, its root, and a row the seed puts on it. */
const PAGES = [
	{ nav: "插件", root: "[data-ly-extensions-page]", title: PLUGIN, detail: PLUGIN_DETAIL },
	{ nav: "智能体", root: "[data-agent-settings]", title: AGENT, detail: AGENT_DETAIL },
	{ nav: "命令", root: "[data-ly-commands-settings]", title: "/review", detail: COMMAND_DETAIL },
	{ nav: "钩子", root: "[data-ly-hooks-settings]", title: "PreToolUse", detail: "echo hi" },
] as const;

before(async () => {
	app = await startApp({ port: 9861, seed: async (home) => {
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1240, height: 860 }));
		await writeFile(join(home, "settings.json"), JSON.stringify({
			version: 1, providers: [], mcpServers: [], projects: [], appearance: { theme: "light" },
			hooks: { events: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } },
		}));
		await mkdir(join(home, "commands"), { recursive: true });
		await writeFile(join(home, "commands", "review.md"), `---\ndescription: ${COMMAND_DETAIL}\n---\nReview the diff.\n`);
		await mkdir(join(home, "agents"), { recursive: true });
		await writeFile(join(home, "agents", `${AGENT}.md`), `---\nname: ${AGENT}\ndescription: ${AGENT_DETAIL}\ntools: [read]\n---\nYou review changes.\n`);
		const plugin = join(home, "plugins", "git-helper");
		await mkdir(join(plugin, ".lyra-plugin"), { recursive: true });
		await mkdir(join(plugin, "skills", "rebase"), { recursive: true });
		await writeFile(join(plugin, ".lyra-plugin", "plugin.json"), JSON.stringify({
			name: "git-helper", version: "1.0.0", description: PLUGIN_DETAIL, skills: "skills",
			interface: { displayName: PLUGIN, shortDescription: PLUGIN_DETAIL },
		}));
		await writeFile(join(plugin, "skills", "rebase", "SKILL.md"), "---\nname: rebase\ndescription: 在用户要求整理提交历史时，按仓库约定执行交互式变基并说明每一步。\n---\n\n变基。\n");
	} });
	// The rail's gear when the rail is shown, the sidebar foot's otherwise; both carry this mark.
	await app.evaluate(`[...document.querySelectorAll("[data-ly-open-settings]")].find((b) => b.checkVisibility())?.dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
	await until(`document.querySelector("[data-ly-settings]")`);
});

after(async () => {
	await app?.stop();
});

async function until(expression: string, what = expression) {
	await app.evaluate(`new Promise((resolve,reject)=>{let n=300;const f=()=>{if(${expression})resolve();else if(--n)requestAnimationFrame(f);else reject(new Error(${JSON.stringify(what)}));};f();})`);
}
async function wait(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Shared by every probe: the visible root (a hidden workspace view keeps its own `main` and forms
 * in the document, so the first match is not always the one on screen), and the innermost element
 * carrying a piece of text, however React split it into nodes.
 */
const HELPERS = `
	const shown = (el) => el.checkVisibility({ visibilityProperty: true });
	const within = (selector) => [...document.querySelectorAll(selector)].find(shown);
	const carrying = (root, text) => [...root.querySelectorAll("*")].filter((el) => shown(el) && el.textContent.trim() === text)
		.find((el) => ![...el.children].some((child) => child.textContent.trim() === text));
	const style = (el) => getComputedStyle(el);
`;

async function open(page: (typeof PAGES)[number]) {
	// Settings is loaded on first open: its shell is up before its navigation is.
	await until(`(() => { ${HELPERS} return [...document.querySelectorAll("[data-ly-settings] nav button")].some((b) => shown(b) && b.textContent.trim() === ${JSON.stringify(page.nav)}); })()`, `settings nav: ${page.nav}`);
	await app.evaluate(`(() => {
		${HELPERS}
		const button = [...document.querySelectorAll("[data-ly-settings] nav button")].find((b) => shown(b) && b.textContent.trim() === ${JSON.stringify(page.nav)});
		if (!button) throw new Error("settings nav has no ${page.nav}");
		button.click();
	})()`);
	await until(`(() => { ${HELPERS} const root = within(${JSON.stringify(page.root)}); return root && carrying(root, ${JSON.stringify(page.title)}); })()`, `${page.nav}: row ${page.title}`);
	await wait(300);
}

interface ListMetrics {
	search: { height: number; background: string; ring: string; radius: string; font: string };
	card: { radius: string; border: string; line: string; background: string };
	row: { height: number; titleX: number };
	title: { size: string; weight: string; color: string };
	detail: { size: string; color: string };
}

function measureList(page: (typeof PAGES)[number]) {
	return app.evaluate<ListMetrics>(`(() => {
		${HELPERS}
		const root = within(${JSON.stringify(page.root)});
		const field = [...root.querySelectorAll("[data-ly-field]")].find(shown);
		const input = field.querySelector("input");
		const title = carrying(root, ${JSON.stringify(page.title)});
		const detail = carrying(root, ${JSON.stringify(page.detail)});
		const card = title.closest(".ly-settings-card");
		let row = title;
		while (row.parentElement !== card) row = row.parentElement;
		const f = style(field), c = style(card), t = style(title), d = style(detail);
		return {
			search: { height: field.getBoundingClientRect().height, background: f.backgroundColor, ring: f.boxShadow + " / " + f.borderTopWidth + " " + f.borderTopColor, radius: f.borderTopLeftRadius, font: style(input).fontSize },
			card: { radius: c.borderTopLeftRadius, border: c.borderTopWidth, line: c.borderTopColor, background: c.backgroundColor },
			row: { height: Math.round(row.getBoundingClientRect().height * 100) / 100, titleX: Math.round(title.getBoundingClientRect().left - card.getBoundingClientRect().left) },
			title: { size: t.fontSize, weight: t.fontWeight, color: t.color },
			detail: { size: d.fontSize, color: d.color },
		};
	})()`);
}

/** Each page against the first, one section at a time, so a failure says which part drifted. */
function sameAcross<T extends object>(measured: Record<string, T>, keys: (keyof T)[]) {
	const [[firstName, first], ...rest] = Object.entries(measured);
	for (const [name, metrics] of rest) {
		for (const key of keys) assert.deepEqual(metrics[key], first[key], `${String(key)}: ${name} ≠ ${firstName}`);
	}
}

test("the four definition pages share one search field, one card and one row", async () => {
	const measured: Record<string, ListMetrics> = {};
	for (const page of PAGES) {
		await open(page);
		measured[page.nav] = await measureList(page);
		await shot(app, `parity_${page.nav}`);
	}
	console.log(JSON.stringify(measured));
	// Guard against a probe that measures nothing: equal `undefined`s would pass the comparison below.
	const sample = measured[PAGES[0].nav];
	assert.ok(sample.search.height > 20 && parseFloat(sample.card.radius) > 0 && parseFloat(sample.card.border) > 0);
	sameAcross(measured, ["search", "card", "title", "detail"]);
	// Row height and the title's inset go together: padding, leading mark and gap all land in them.
	sameAcross(measured, ["row"]);
});

test("a search with no match leaves each page with a settings card, not a bare line", async () => {
	const measured: Record<string, { size: string; color: string; align: string } | null> = {};
	for (const page of PAGES) {
		await open(page);
		await app.evaluate(`(() => {
			${HELPERS}
			const input = [...within(${JSON.stringify(page.root)}).querySelectorAll("[data-ly-field] input")].find(shown);
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "zzqqxx-no-such-thing");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`);
		await until(`(() => { ${HELPERS} return !carrying(within(${JSON.stringify(page.root)}), ${JSON.stringify(page.title)}); })()`, `${page.nav}: search did not filter`);
		await wait(200);
		measured[page.nav] = await app.evaluate(`(() => {
			${HELPERS}
			const root = within(${JSON.stringify(page.root)});
			const card = [...root.querySelectorAll(".ly-settings-card")].find(shown);
			const text = card && [...card.querySelectorAll("p, div")].find((el) => shown(el) && el.children.length === 0 && el.textContent.trim());
			if (!text) return null;
			const s = style(text);
			return { size: s.fontSize, color: s.color, align: s.textAlign };
		})()`);
		await shot(app, `parity_${page.nav}_无结果`);
		// Clear it again: the next test starts from these pages' lists.
		await app.evaluate(`(() => {
			${HELPERS}
			const input = [...within(${JSON.stringify(page.root)}).querySelectorAll("[data-ly-field] input")].find(shown);
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		})()`);
	}
	console.log(JSON.stringify(measured));
	for (const [name, value] of Object.entries(measured)) assert.ok(value, `${name}: no match shows no card`);
	sameAcross(measured as Record<string, { size: string; color: string; align: string }>, ["size", "color", "align"]);
});

test("row actions on subagents stay hidden until the row is hovered, as on commands", async () => {
	const seen: Record<string, { rest: string; hovered: string }> = {};
	for (const page of [PAGES[1], PAGES[2]]) {
		await open(page);
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
		await wait(400);
		const probe = `(() => {
			${HELPERS}
			const title = carrying(within(${JSON.stringify(page.root)}), ${JSON.stringify(page.title)});
			const row = title.closest("[data-row-actions]");
			const action = row.querySelector(".ly-row-action");
			const r = row.getBoundingClientRect();
			return { opacity: style(action).opacity, x: r.left + r.width / 3, y: r.top + r.height / 2 };
		})()`;
		const rest = await app.evaluate<{ opacity: string; x: number; y: number }>(probe);
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rest.x, y: rest.y });
		await wait(400);
		const hovered = await app.evaluate<{ opacity: string }>(probe);
		await shot(app, `parity_${page.nav}_悬停`);
		seen[page.nav] = { rest: rest.opacity, hovered: hovered.opacity };
	}
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
	console.log(JSON.stringify(seen));
	assert.deepEqual(seen["智能体"], { rest: "0", hovered: "1" });
	assert.deepEqual(seen["智能体"], seen["命令"]);
});

interface EditorMetrics {
	crumb: { tag: string; height: number };
	heading: { size: string; weight: string; top: number };
	card: { top: number; width: number; radius: string; background: string };
	field: { height: number; background: string; ring: string };
	label: { size: string; weight: string; color: string };
	footer: string[];
}

function measureEditor(root: string) {
	return app.evaluate<EditorMetrics>(`(() => {
		${HELPERS}
		const root = within(${JSON.stringify(root)});
		const crumb = root.firstElementChild;
		const h1 = root.querySelector("h1");
		const card = [...root.querySelectorAll(".ly-settings-card")].find(shown);
		const field = [...card.querySelectorAll(".ly-field")].find((el) => shown(el) && el.tagName !== "TEXTAREA");
		// The caption, not the <label>: the label wraps the field too and only inherits the caption's type.
		const label = [...card.querySelectorAll("label > :first-child")].find((el) => shown(el) && el.children.length === 0 && el.textContent.trim());
		const h = style(h1), c = style(card), f = style(field), l = style(label);
		const buttons = [...root.querySelectorAll("button")].filter(shown).map((b) => b.textContent.trim()).filter(Boolean);
		return {
			crumb: { tag: crumb.tagName, height: crumb.getBoundingClientRect().height },
			heading: { size: h.fontSize, weight: h.fontWeight, top: Math.round(h1.getBoundingClientRect().top) },
			card: { top: Math.round(card.getBoundingClientRect().top), width: Math.round(card.getBoundingClientRect().width), radius: c.borderTopLeftRadius, background: c.backgroundColor },
			field: { height: field.getBoundingClientRect().height, background: f.backgroundColor, ring: f.boxShadow + " / " + f.borderTopWidth + " " + f.borderTopColor },
			label: { size: l.fontSize, weight: l.fontWeight, color: l.color },
			footer: buttons.slice(-2),
		};
	})()`);
}

test("the subagent editor is laid out like the hook form", async () => {
	await open(PAGES[1]);
	await app.evaluate(`document.querySelector(${JSON.stringify(`[aria-label="编辑 ${AGENT}"]`)}).click()`);
	await until(`document.querySelector("[data-agent-editor] h1")`, "subagent editor did not open");
	await wait(300);
	const agent = await measureEditor("[data-agent-editor]");
	await shot(app, "parity_智能体编辑");

	await open(PAGES[3]);
	await app.evaluate(`(() => {
		${HELPERS}
		const button = [...within("[data-ly-hooks-settings]").querySelectorAll("button")].find((b) => shown(b) && b.textContent.trim() === "新建");
		button.click();
	})()`);
	await until(`document.querySelector("[data-ly-hook-form] h1")`, "hook form did not open");
	await wait(300);
	const hook = await measureEditor("[data-ly-hook-form]");
	await shot(app, "parity_钩子编辑");
	console.log(JSON.stringify({ agent, hook }));

	assert.equal(agent.crumb.tag, "NAV", "the subagent editor lost its breadcrumb");
	assert.deepEqual(agent.footer, ["取消", "保存"], "cancel then save, save last");
	sameAcross({ 智能体编辑: agent, 钩子编辑: hook }, ["crumb", "heading", "card", "field", "label", "footer"]);
});
