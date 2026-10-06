/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * The sidebar without its 项目/聊天 switch or its control row: one list, 列表设置 beside 新建项目 on
 * 「项目」 shown on hover, the archive left to settings, more room under the title, and search still
 * showing every match in one run.
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/sidebar-no-tabs-demo.ts [before|after] [outDir]`
 * `before` only takes the pictures — run it on the old build to have something to compare with.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "./app.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = process.argv[3] ?? join(homedir(), "Desktop", "Plume侧栏去掉标签测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9881;
const W = 1280;
const H = 820;

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const PROJECTS = ["alpha", "beta", "gamma"];

async function seed(home: string) {
	const loose = join(home, "workspaces", "general");
	await mkdir(loose, { recursive: true });
	const sessions: { id: string; title: string; cwd: string; project?: string; ago: number }[] = [];
	for (const [p, name] of PROJECTS.entries()) {
		await mkdir(join(home, name), { recursive: true });
		for (let i = 0; i < 3; i++) sessions.push({ id: `${name}-${i}`, title: `${name} 会话 ${i + 1}`, cwd: join(home, name), project: name, ago: 30 + p * 7 + i * 3 });
	}
	sessions.push({ id: "loose-0", title: "随便聊聊", cwd: loose, ago: 5 });
	sessions.push({ id: "loose-1", title: "你好", cwd: loose, ago: 60 * 50 });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: W, height: H, x: 40, y: 40 }));
	seedSessions(home, sessions.map((session) => {
		const at = Date.now() - session.ago * 60_000;
		const meta = { id: session.id, title: session.title, cwd: session.cwd, projectId: session.project ?? "elsewhere", projectName: session.project ?? "elsewhere", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage, seq: 1 };
		return { meta, records: [] } as Parameters<typeof seedSessions>[1][number];
	}));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		appearance: { theme: "dark", vibrancy: false },
		providers: [],
		mcpServers: [],
		projects: PROJECTS.map((name, i) => ({ id: name, name, path: join(home, name), pinned: false, lastOpenedAt: 10 - i })),
		defaultModelId: null,
		permissionMode: "auto",
		thinking: "off",
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

let app: RunningApp;
const frames: Frame[] = [];

const SIDEBAR = ".ly-sidebar-fill";
async function until(expression: string, ms = 15_000) {
	for (let i = 0; i < ms / 100; i++) {
		if (await app.evaluate(`Boolean(${expression})`)) return true;
		await pause(100);
	}
	throw new Error(`UI condition not reached: ${expression}`);
}
/** A sidebar button by its accessible name, clicked with a real pointer. */
async function press(label: string) {
	const expression = `[...document.querySelectorAll("${SIDEBAR} button")].find((b) => (b.getAttribute("aria-label") ?? "").includes(${JSON.stringify(label)}))`;
	await until(expression);
	const p = await app.evaluate<{ x: number; y: number }>(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
	for (const type of ["mousePressed", "mouseReleased"]) await app.send("Input.dispatchMouseEvent", { type, ...p, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
	await pause(1000);
}
async function shot(name: string) {
	const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, `${STAMP}_${MODE}_${name}.png`), Buffer.from(picture.data, "base64"));
}

interface Layout {
	tabs: number;
	strip: number;
	archiveButtons: number;
	titleToNewChat: number;
	sections: string[];
	rows: string[];
	heads: string[];
	/** Each section heading's text colour and how much of it is drawn, ancestors included. */
	labels: { section: string; color: string; opacity: number }[];
	actions: string[];
}
const layout = () => app.evaluate<Layout>(`(() => {
	const pane = document.querySelector("${SIDEBAR}");
	const head = pane.querySelector(".ly-sidebar-head");
	const newChat = [...pane.querySelectorAll("nav button")].find((b) => b.innerText.includes("新对话"));
	const visible = (el) => el.getBoundingClientRect().height > 0;
	const drawn = (el) => { let o = 1; for (let n = el; n && n !== pane; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return Math.round(o * 100) / 100; };
	return {
		tabs: pane.querySelectorAll("[role='tablist'], [data-ly-tab]").length,
		strip: pane.querySelectorAll("[data-ly-rail]").length,
		archiveButtons: [...pane.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("已归档")).length,
		titleToNewChat: Math.round(newChat.getBoundingClientRect().top - head.getBoundingClientRect().bottom),
		sections: [...pane.querySelectorAll("[data-ly-section]")].map((el) => el.getAttribute("data-ly-section")),
		rows: [...pane.querySelectorAll("[data-ly-row]")].filter(visible).map((el) => el.getAttribute("data-ly-row")),
		heads: [...pane.querySelectorAll("[data-ly-head]")].map((el) => el.innerText.trim()),
		labels: [...pane.querySelectorAll("[data-ly-section]")].map((el) => ({ section: el.getAttribute("data-ly-section"), color: getComputedStyle(el).color, opacity: drawn(el) })),
		actions: [...(pane.querySelector("[data-ly-section='projects']")?.parentElement.querySelectorAll("[data-ly-section-action] button") ?? [])].map((b) => b.getAttribute("aria-label")),
	};
})()`);
const actionOpacity = () => app.evaluate<number>(`Number(getComputedStyle(document.querySelector("${SIDEBAR} [data-ly-section='projects']").parentElement.querySelector("[data-ly-section-action]")).opacity)`);
async function hoverProjects() {
	const p = await app.evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector("${SIDEBAR} [data-ly-section='projects']").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
	await pause(1000);
}

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
	const stop = await startRecording(PORT, frames);
	try {
		await app.evaluate("document.fonts.ready");
		await until(`document.querySelectorAll("[data-ly-row]").length >= 2`);
		await pause(1000);
		await shot("01_侧栏");
		const at = await layout();
		console.log("\n== A 侧栏静止状态", JSON.stringify(at));
		if (MODE === "before") return;

		check("侧栏里没有「项目 / 聊天」切换", at.tabs === 0, at.tabs);
		check("筛选 / 归档那一行没了，侧栏里没有归档入口", at.strip === 0 && at.archiveButtons === 0, { strip: at.strip, archive: at.archiveButtons });
		check("标题和新对话之间留出 ≥ 8px", at.titleToNewChat >= 8, at.titleToNewChat);
		check("列表是项目 + 最近", at.sections.join(",") === "projects,recent", at.sections);
		const [projects, recent] = at.labels;
		check("「项目」和「最近」字色、透明度一致", projects?.color === recent?.color && projects?.opacity === recent?.opacity, at.labels);

		console.log("\n== B 列表设置挪到「项目」右侧，鼠标移入才显示");
		check("「项目」右侧是 列表设置 + 新建项目", at.actions.join(",") === "列表设置,新建项目", at.actions);
		check("静止时不显示", (await actionOpacity()) < 0.01, await actionOpacity());
		await hoverProjects();
		await shot("02_鼠标移入项目");
		check("鼠标移入后显示", (await actionOpacity()) > 0.99, await actionOpacity());
		await press("列表设置");
		const menu = await app.evaluate<string>(`document.querySelector("[role='menu'], [role='dialog']")?.innerText ?? ""`);
		await shot("03_列表设置");
		check("列表设置里有排序和收起全部项目", menu.includes("最近更新") && menu.includes("收起全部项目"), menu.replace(/\s+/g, " "));
		await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 600 });
		await pause(1000);

		console.log("\n== C 搜索：扁平列表，关掉回到项目列表");
		await press("搜索会话");
		const searching = await layout();
		await shot("04_搜索中");
		check("搜索时列出所有会话，跨项目", searching.rows.length === PROJECTS.length * 3 + 2, searching.rows.length);
		check("按日期分段", searching.heads.includes("今天"), searching.heads);
		await press("搜索会话");
		check("关掉搜索回到项目 + 最近", (await layout()).sections.join(",") === "projects,recent", "");
	} finally {
		await stop();
		await app.stop();
	}
	if (MODE === "before") return;
	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT, `${STAMP}_${MODE}_侧栏去掉标签_${passed}of${checks.length}.mp4`);
	await encode(frames, video);
	console.log(`\n${passed}/${checks.length}  →  ${video}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
