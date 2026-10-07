/* oxlint-disable no-console -- 输出真实窗口的测量结果 */
/**
 * 侧栏顶上的放大镜打开命令面板：会话和命令在一个框里找。打开时侧栏列表原地不动，方向键和回车
 * 能用，输入框不随结果多少上下跳，命令执行的效果在窗口里看得见。
 *
 * 量的都是屏幕上的东西——框的位置、哪一行 `aria-selected`、哪一行 `aria-current`——不读 store。
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, COMMAND_PALETTE, frames, hover, openCommandPalette, press, shot, type as typeText, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const PORT = 9898;
const DAY = 86_400_000;
const PROJECTS = ["alpha", "beta", "gamma"];
/** 每个项目六条，落在 今天/昨天/过去 7 天/过去 30 天/更早 各段里。 */
const AGES = [0, 0, 1, 3, 9, 40];
const ITEM = "[data-ly-palette-item]";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);

async function seed(home: string): Promise<void> {
	const now = Date.now();
	const metas = [];
	let n = 0;
	for (const name of PROJECTS) {
		const cwd = join(home, "work", name);
		await mkdir(cwd, { recursive: true });
		for (const [i, age] of AGES.entries()) {
			const updatedAt = now - age * DAY - n * 60_000;
			metas.push({
				id: `s${n}`,
				title: `${name} 会话 ${i + 1}`,
				cwd,
				projectId: name,
				projectName: name,
				createdAt: updatedAt - 60_000,
				updatedAt,
				modelId: "m",
				messageCount: 2,
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				seq: 1,
				archived: false,
			});
			n++;
		}
	}
	seedSessions(home, metas.map((meta) => ({ meta, records: [] })));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 800 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [],
		projects: PROJECTS.map((name, i) => ({ path: join(home, "work", name), name, pinned: false, lastOpenedAt: 100 - i })),
		appearance: { theme: "light" },
	}));
}

interface View {
	open: boolean;
	focused: boolean;
	expanded: string | null;
	inputTop: number;
	items: { id: string; text: string; selected: boolean }[];
	groups: string[];
	empty: string;
	sidebarRows: number;
	firstRowTop: number;
}

const read = (app: RunningApp) => app.evaluate<View>(`(() => {
	const input = document.querySelector(${JSON.stringify(COMMAND_PALETTE)});
	const dialog = input?.closest('[role="dialog"]');
	const rows = [...document.querySelectorAll('.ly-sidebar-fill [data-ly-row]')];
	return {
		open: Boolean(dialog),
		focused: Boolean(input) && document.activeElement === input,
		expanded: document.querySelector('button[aria-label="搜索会话"]').getAttribute('aria-expanded'),
		inputTop: input ? input.getBoundingClientRect().top : -1,
		items: [...document.querySelectorAll(${JSON.stringify(ITEM)})].map((e) => ({
			id: e.dataset.lyPaletteItem, text: e.innerText.replace(/\\s+/g, ' ').trim(), selected: e.getAttribute('aria-selected') === 'true',
		})),
		groups: dialog ? [...dialog.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label')) : [],
		empty: dialog?.querySelector('[role="listbox"] > p')?.textContent ?? '',
		sidebarRows: rows.length,
		firstRowTop: rows[0]?.getBoundingClientRect().top ?? -1,
	};
})()`);

const closed = `!document.querySelector(${JSON.stringify(COMMAND_PALETTE)})`;
const selectedIndex = (view: View) => view.items.findIndex((item) => item.selected);

test("命令面板：会话和命令一起找，侧栏不动，键盘和鼠标都能执行", async () => {
	const app = await startApp({ port: PORT, seed });
	const recording: Frame[] = [];
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	let stopRecording: (() => Promise<void>) | undefined;
	let passed = 0;
	function check(label: string, ok: boolean, detail: unknown) {
		console.log(`${ok ? "✅" : "❌"} ${label}：${JSON.stringify(detail)}`);
		assert.ok(ok, label);
		passed++;
	}
	/** 在面板里打一句、等它排好，再按回车执行第一条。 */
	const runFirst = async (query: string) => {
		await openCommandPalette(app);
		await typeText(app, COMMAND_PALETTE, query);
		await frames(app, 10);
		const view = await read(app);
		await pause(900);
		await press(app, "Enter", 13);
		await until(app, closed);
		return view;
	};
	try {
		if (directory) stopRecording = await startRecording(PORT, recording);
		await until(app, `document.querySelectorAll('.ly-sidebar-fill [data-ly-row]').length > 0`);
		await frames(app, 30);
		const before = await read(app);
		await shot(app, `${STAMP}_01_打开前`);
		await pause(800);

		await openCommandPalette(app);
		const idle = await read(app);
		check("点放大镜弹出命令面板，输入框拿到焦点", idle.open && idle.focused && idle.expanded === "true", idle.expanded);
		check("侧栏列表原地不动", idle.sidebarRows === before.sidebarRows && idle.firstRowTop === before.firstRowTop,
			{ rows: [before.sidebarRows, idle.sidebarRows], top: [before.firstRowTop, idle.firstRowTop] });
		check("空输入：最近会话在前，后面是常用命令；项目和设置项要打字才出现",
			idle.groups.join() === "最近会话,对话,前往,面板,主题", idle.groups);
		const recent = idle.items.filter((item) => item.id.startsWith("session:")).map((item) => item.id.slice(8));
		check("最近会话六条，按最后活动从新到旧", recent.join() === "s0,s1,s6,s7,s12,s13", recent);
		check("会话行带项目名，命令行带快捷键", idle.items[0]!.text === "alpha 会话 1 alpha"
			&& idle.items.some((item) => item.id === "toggle-sidebar" && item.text.endsWith("⌘B")), idle.items.map((item) => item.text));
		check("第一行默认高亮", selectedIndex(idle) === 0, idle.items.filter((item) => item.selected));
		await shot(app, `${STAMP}_02_空输入`);
		await pause(1200);

		await typeText(app, COMMAND_PALETTE, "beta");
		await frames(app, 10);
		const beta = await read(app);
		const betaSessions = beta.items.filter((item) => item.id.startsWith("session:"));
		check("打字后会话按标题筛，项目也能搜到，名字整个对上的那组排在前面",
			beta.groups.join() === "项目,会话" && betaSessions.length === 6 && betaSessions.every((item) => item.text.startsWith("beta")),
			{ groups: beta.groups, items: beta.items.map((item) => item.text) });
		check("结果变了输入框不跳", beta.inputTop === idle.inputTop, [idle.inputTop, beta.inputTop]);
		await shot(app, `${STAMP}_03_搜项目和会话`);
		await pause(1200);

		await typeText(app, COMMAND_PALETTE, "会话 4");
		await frames(app, 10);
		await press(app, "ArrowDown", 40);
		const down = await read(app);
		check("↓ 移动高亮", selectedIndex(down) === 1, down.items.map((item) => item.selected));
		await pause(500);
		await press(app, "ArrowUp", 38);
		await press(app, "ArrowUp", 38);
		const wrapped = await read(app);
		check("↑ 从第一行绕到最后一行", selectedIndex(wrapped) === wrapped.items.length - 1 && wrapped.items.length === 3, wrapped.items);
		await pause(800);
		const target = wrapped.items.at(-1)!.id.slice(8);
		await press(app, "Enter", 13);
		await until(app, `${closed} && document.querySelector('[data-ly-row="${target}"] > button[aria-current]')`);
		check("回车打开高亮的会话并关掉面板", true, target);
		await shot(app, `${STAMP}_04_回车打开会话`);
		await pause(1000);

		const dark = await runFirst("深色");
		await until(app, `document.documentElement.classList.contains('dark')`);
		check("搜「深色」执行主题命令，窗口换成深色", dark.groups[0] === "主题", dark.groups);
		await shot(app, `${STAMP}_05_切到深色`);
		await pause(1000);
		await openCommandPalette(app);
		const themes = (await read(app)).items.filter((item) => item.id.startsWith("theme-"));
		check("当前主题在面板里打着勾", (await app.evaluate<string | null>(`document.querySelector('[data-ly-palette-item="theme-dark"]').getAttribute('aria-checked')`)) === "true", themes);
		await press(app, "Escape", 27);
		await until(app, closed);
		await runFirst("浅色");
		await until(app, `!document.documentElement.classList.contains('dark')`);
		check("再切回浅色", true, "light");
		await pause(800);

		const panel = await runFirst("终端");
		await until(app, `document.querySelector('.xterm')`);
		check("搜「终端」排在最前的是面板，回车把终端打开", panel.groups[0] === "面板" && panel.items[0]!.text.startsWith("终端"), panel.items[0]);
		await shot(app, `${STAMP}_06_打开终端`);
		await pause(1200);

		const settings = await runFirst("模型");
		// 设置页导航里被标成当前的那一行（图标栏的「设置」也带 aria-current，所以按字认）。
		await until(app, `[...document.querySelectorAll('[data-ly-settings] [aria-current="page"]')].some((e) => e.textContent.trim() === '模型设置')`);
		check("设置项打字才出现，回车直接打开那一页", settings.groups.includes("设置") && !idle.groups.includes("设置"), settings.groups);
		await shot(app, `${STAMP}_07_打开模型设置`);
		await pause(1200);
		await click(app, "[data-ly-settings] button", "返回工作区");
		await until(app, `document.querySelector('button[aria-label="搜索会话"]')`);

		await openCommandPalette(app);
		const reopened = await app.evaluate<string>(`document.querySelector(${JSON.stringify(COMMAND_PALETTE)}).value`);
		check("再开时输入框是空的", reopened === "", reopened);
		await typeText(app, COMMAND_PALETTE, "不存在的东西");
		await frames(app, 10);
		const none = await read(app);
		check("没有匹配时说出来", none.items.length === 0 && none.empty === "没有匹配的会话或命令", none.empty);
		await shot(app, `${STAMP}_08_无匹配`);
		await pause(1000);
		await press(app, "Escape", 27);
		await until(app, `${closed} && document.activeElement?.getAttribute('aria-label') === '搜索会话'`);
		check("Escape 关掉面板，焦点回到放大镜", (await read(app)).expanded === "false", "focus on button");
		await pause(800);

		await openCommandPalette(app);
		await hover(app, `${ITEM}[data-ly-palette-item="session:s12"]`);
		const hovered = await read(app);
		check("指针所在的行就是唯一高亮的行", hovered.items.filter((item) => item.selected).map((item) => item.id).join() === "session:s12",
			hovered.items.filter((item) => item.selected).map((item) => item.id));
		await shot(app, `${STAMP}_09_悬停`);
		await pause(800);
		await click(app, `${ITEM}[data-ly-palette-item="session:s12"]`);
		await until(app, `${closed} && document.querySelector('[data-ly-row="s12"] > button[aria-current]')`);
		check("点击结果打开会话", true, "s12");
		await pause(1000);
	} finally {
		await stopRecording?.();
		await app.stop();
		if (directory && recording.length > 1) await encode(recording, join(directory, `${STAMP}_命令面板_${passed}of21.mp4`), 30);
	}
});
