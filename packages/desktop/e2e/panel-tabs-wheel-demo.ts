/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 右栏标签条排不下时，用普通滚轮横着滚——边验边录。
 *
 * 开终端，再从「+」里连开侧边聊天直到标签条溢出；量两头还有没有方向键、竖直滚轮能不能把它往右
 * 推、渐隐跟不跟、滚回头、触摸板式的横向量照旧能走、滚完以后标签和「+」还点得中。
 *
 * 用法：node --experimental-strip-types e2e/panel-tabs-wheel-demo.ts [before|after] [输出目录]
 * `before` 只拍溢出那一张，给改动前对照用。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume标签条滚轮测试");
const PORT = 9495;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "tabs-wheel";
const STRIP = '[data-ly-toolbar-panel] [role="tablist"]';

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
		appearance: { theme: "dark", panelLayout: "tabs" },
	}));
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const meta = { id: SESSION, title: "标签条滚轮", cwd: project, projectId, projectName: "project", createdAt: 1, updatedAt: 2, modelId: "none", messageCount: 1, usage: { ...zero, cost: zero }, seq: 2 };
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "开很多个侧边聊天" }], timestamp: 2 } },
		],
	} as never]);
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

interface Strip { scrollLeft: number; max: number; tabs: number; arrows: number; fadeLeft: string; fadeRight: string; x: number; y: number }

let app: RunningApp | undefined;
const recorded: Frame[] = [];
let shotIndex = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const page = app;
	const capture = async (name: string) => {
		const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shotIndex).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	// 方向键按「往左滚 / 往右滚」的名字找，看得见的才算——改动前它们是浮在标签条两头的那两颗。
	const measure = () => page.evaluate<Strip>(`(() => {
		const el = document.querySelector(${JSON.stringify(STRIP)});
		const r = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const arrows = [...document.querySelectorAll('[data-ly-toolbar-panel] button[aria-label="往左滚"], [data-ly-toolbar-panel] button[aria-label="往右滚"]')].filter((b) => getComputedStyle(b).opacity !== "0").length;
		return {
			scrollLeft: Math.round(el.scrollLeft), max: Math.round(el.scrollWidth - el.clientWidth),
			tabs: el.querySelectorAll("[data-panel-tab]").length, arrows,
			fadeLeft: style.getPropertyValue("--ly-fade-left").trim(), fadeRight: style.getPropertyValue("--ly-fade-right").trim(),
			x: r.x + r.width / 2, y: r.y + r.height / 2,
		};
	})()`);
	const wheel = async (deltaY: number, deltaX = 0) => {
		const { x, y } = await measure();
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
		await frames(page, 20);
	};

	await until(page, `document.querySelector("[data-ly-row='${SESSION}'] > button")`, 3600);
	await openSession(page, SESSION);
	const stop = LABEL === "before" ? null : await startRecording(PORT, recorded);
	await pause(800);

	await click(page, '[data-ly-panel-quick] button[aria-label^="终端"]');
	await until(page, `document.querySelector(${JSON.stringify(STRIP)})`, 1200);
	// 侧边聊天能开好几个，一直加到标签条装不下为止。
	for (let i = 0; i < 8; i++) {
		const { max } = await measure();
		if (max > 120) break;
		await click(page, '[data-ly-toolbar-panel] button[aria-label="添加面板"]');
		await click(page, '[role="menuitem"]', "侧边聊天", "starts");
		await frames(page, 30);
		await pause(300);
	}
	// 新开的标签会被滚进视野，先回到最左边，从头开始滚。
	await page.evaluate(`document.querySelector(${JSON.stringify(STRIP)}).scrollLeft = 0`);
	await frames(page, 20);
	await pause(800);
	const start = await measure();
	await capture("标签条溢出");
	console.log("溢出：", start);
	if (LABEL === "before") {
		await app.stop();
		process.exit(0);
	}

	check("标签条确实溢出了", start.max > 0 && start.tabs >= 3, start);
	check("两头没有方向键", start.arrows === 0, start.arrows);
	check("在最左边：左边不化开，右边化开", start.fadeLeft === "0px" && start.fadeRight === "20px", start);

	// 竖直滚轮，不按 Shift：一格一格往右推。
	const steps: number[] = [];
	for (let i = 0; i < 3; i++) {
		await wheel(100);
		steps.push((await measure()).scrollLeft);
		await pause(500);
	}
	const mid = await measure();
	await capture("滚轮往右滚");
	check("普通滚轮往下滚，标签条往右走", steps[0] > 0 && steps[1] > steps[0], steps);
	check("滚开以后左边也化开", mid.fadeLeft !== "0px", mid);

	await wheel(4000);
	await pause(700);
	const end = await measure();
	await capture("滚到最右");
	check("一直滚到最右，停在尽头", Math.abs(end.scrollLeft - end.max) <= 1 && end.fadeRight === "0px", end);

	await wheel(-4000);
	await pause(700);
	const back = await measure();
	check("往上滚回到最左", back.scrollLeft === 0, back);

	// 触摸板两指横划报的是 deltaX，交给浏览器，不再叠一次竖向量。
	await wheel(0, 80);
	await pause(700);
	const swipe = await measure();
	check("横向量（触摸板横划）照样能滚", swipe.scrollLeft > 0, swipe);

	// 滚完以后标签和「+」都还点得中。
	await wheel(4000);
	await pause(500);
	const last = await page.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(`${STRIP} [data-panel-tab]`)})].at(-1).dataset.panelTab`);
	await click(page, `${STRIP} [data-panel-tab="${last}"] [role="tab"]`);
	await pause(700);
	const picked = await page.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(`${STRIP} [data-panel-tab="${last}"] [aria-selected="true"]`)}))`);
	check("滚到最右后，最右那个标签点得中", picked, last);
	await click(page, '[data-ly-toolbar-panel] button[aria-label="添加面板"]');
	const menu = await page.evaluate<boolean>(`Boolean(document.querySelector('[role="menuitem"]'))`);
	await capture("加号菜单");
	check("「+」还在、点得开", menu, menu);
	await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
	await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
	await pause(800);
	await stop?.();

	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${STAMP}_标签条滚轮_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
