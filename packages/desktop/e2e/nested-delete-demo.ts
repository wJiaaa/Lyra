/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 删除一个下面嵌套着会话的会话：确认框说出嵌套了几个、只删它会怎样，并给出「删除此会话」和「删除 N 个会话」两条路。
 *
 * 只有归档的会话能删，所以两个父会话都已归档，从「已归档的聊天」里删：「重构登录」下面一层建议、一层建议的
 * 建议，走「删除 3 个会话」，三个一起没了；「修样式」下面一个，走「删除此会话」，子会话留在侧栏里。
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/nested-delete-demo.ts [before|after] [outDir]`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp } from "./app.ts";
import { click, closeSettings, openSettings, shot, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = process.argv[3] ?? join(homedir(), "Desktop", "Plume删除嵌套会话测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9886;
process.env.PLUME_E2E_ARTIFACTS = OUT;

const checks: boolean[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push(ok);
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const app = await startApp({ port: PORT, seed: async (home) => {
	const cwd = join(home, "alpha");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820, x: 40, y: 40 }));
	const at = Date.now() - 3_600_000;
	const session = (id: string, title: string, minute: number, from?: string) => ({
		meta: { id, title, cwd, projectId: "alpha", projectName: "alpha", createdAt: at + minute * 60_000, updatedAt: at + minute * 60_000, modelId: "m", messageCount: 2, usage, seq: 1, archived: !from, ...(from ? { spawnedFrom: { sessionId: from, toolCallId: `call-${id}` } } : {}) },
		records: [],
	});
	seedSessions(home, [
		session("login", "重构登录", 0),
		session("login-a", "删掉 legacyLogin", 1, "login"),
		session("login-b", "补登录测试", 2, "login-a"),
		session("style", "修样式", 3),
		session("style-a", "统一按钮圆角", 4, "style"),
	] as Parameters<typeof seedSessions>[1]);
	await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, uiLocale: "zh-CN", appearance: { theme: "dark", vibrancy: false }, providers: [], mcpServers: [], projects: [{ id: "alpha", name: "alpha", path: cwd, pinned: false, lastOpenedAt: 1 }], hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [] }));
} });

const row = (id: string) => `document.querySelector('[data-ly-row="${id}"]')`;
const archived = (id: string) => `document.querySelector('[data-ly-archive-row="${id}"]')`;
const dialogText = () => app.evaluate<string>(`document.querySelector("[data-ly-modal]")?.textContent ?? ""`);
const buttons = () => app.evaluate<string[]>(`[...document.querySelectorAll("[data-ly-modal] button")].map((b) => b.textContent)`);

async function askDelete(id: string, title: string) {
	await openSettings(app, "已归档的聊天");
	await until(app, archived(id), 3000);
	// The project's group in the archive starts folded: the row is in the tree but out of the pointer's reach.
	if (await app.evaluate<boolean>(`document.querySelector("[data-ly-archive-toggle]")?.getAttribute("aria-expanded") === "false"`)) await click(app, "[data-ly-archive-toggle]");
	await pause(800);
	await click(app, `[data-ly-archive-row="${id}"] button`, `删除「${title}」`);
	await until(app, `document.querySelector("[data-ly-modal]")`, 3000);
	await pause(900);
}

try {
	await until(app, `document.querySelectorAll("[data-ly-row]").length >= 3`, 8000);
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	await pause(1000);
	await shot(app, `${STAMP}_${MODE}_01_删除前的侧栏`);

	console.log(`\n== ${MODE}：重构登录（已归档，下面嵌套两层）`);
	await askDelete("login", "重构登录");
	await shot(app, `${STAMP}_${MODE}_02_嵌套会话的删除确认`);
	const text = await dialogText();
	check("说出嵌套了几个、只删它会怎样", /它下面嵌套着 2 个会话。只删这一个的话，它们会留下，成为独立的会话。/.test(text), text);
	check("三颗按钮：取消、删除 3 个会话、删除此会话", JSON.stringify(await buttons()) === JSON.stringify(["取消", "删除 3 个会话", "删除此会话"]), await buttons());
	check("焦点在取消上", await app.evaluate<string>(`document.activeElement?.textContent ?? ""`) === "取消", await app.evaluate<string>(`document.activeElement?.textContent ?? ""`));
	if (MODE === "after") {
		await click(app, "[data-ly-modal] button", "删除 3 个会话");
		await until(app, `!${archived("login")}`, 5000);
		await pause(900);
		await closeSettings(app);
		await pause(900);
		const gone = await app.evaluate<boolean>(`!${row("login-a")} && !${row("login-b")} && Boolean(${row("style-a")})`);
		check("删除 3 个会话：父会话和侧栏里的两个子会话都没了，别的不动", gone, "");

		console.log("\n== 修样式（已归档，下面嵌套一个），只删它");
		await askDelete("style", "修样式");
		await click(app, "[data-ly-modal] button", "删除此会话");
		await until(app, `!${archived("style")}`, 5000);
		await pause(900);
		await closeSettings(app);
		await pause(900);
		check("删除此会话：子会话留在侧栏", await app.evaluate<boolean>(`Boolean(${row("style-a")})`), "");
		await shot(app, `${STAMP}_${MODE}_03_只删父会话后子会话还在`);
	}
	await pause(800);
	await stop();
	const passed = checks.filter(Boolean).length;
	await mkdir(OUT, { recursive: true });
	await encode(recorded, join(OUT, `${STAMP}_${MODE}_删除嵌套会话_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} passed · ${OUT}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app.stop();
}
