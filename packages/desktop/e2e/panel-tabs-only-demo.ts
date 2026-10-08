/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 面板只剩标签页一种排法——边验边录。
 *
 * 开终端、再开浏览器：两个都是右栏的标签，同一时间只画一个；标题栏里没有第二颗关闭；点标签能切、✕ 能关；外观设置里不再有「面板：标签页 / 分栏」那一行。
 *
 * 用法：node --experimental-strip-types e2e/panel-tabs-only-demo.ts [before|after] [输出目录]
 * `before` 只拍开了两个面板、外观设置这两张，给改动前对照用。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openPane, openSession, openSettings, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume面板只留标签页测试");
const PORT = 9498;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "tabs-only";

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760, x: 0, y: 0 }));
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
		appearance: { theme: "dark" },
	}));
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const meta = { id: SESSION, title: "面板只留标签页", cwd: project, projectId, projectName: "project", createdAt: 1, updatedAt: 2, modelId: "none", messageCount: 1, usage: { ...zero, cost: zero }, seq: 2 };
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "开终端和浏览器" }], timestamp: 2 } },
		],
	} as never]);
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

/** 屏上看得见的面板、标签条里的标签、标题栏里关闭按钮的个数。 */
interface Dock { shown: string[]; tabs: string[]; headerCloses: number }

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
	const measure = () => page.evaluate<Dock>(`(() => {
		const visible = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
		return {
			shown: [...document.querySelectorAll("[data-dock-pane]")].filter(visible).map((e) => e.dataset.dockPane).sort(),
			tabs: [...document.querySelectorAll('[role="tablist"] [data-panel-tab]')].filter(visible).map((e) => e.dataset.panelTab),
			headerCloses: [...document.querySelectorAll('[data-dock-header] button[aria-label^="关闭"]')].filter(visible).length,
		};
	})()`);

	await until(page, `document.querySelector("[data-ly-row='${SESSION}'] > button")`, 3600);
	await openSession(page, SESSION);
	const stop = LABEL === "before" ? null : await startRecording(PORT, recorded);
	await pause(800);

	await openPane(page, "终端");
	await frames(page, 40);
	await pause(600);
	await openPane(page, "浏览器");
	await frames(page, 40);
	await pause(900);
	const both = await measure();
	await capture("开了终端和浏览器");
	console.log("两个面板：", both);

	if (LABEL !== "before") {
		check("终端和浏览器都是右栏的标签，后开的排在后面", JSON.stringify(both.tabs) === JSON.stringify(["terminal", "browser"]), both.tabs);
		check("同一时间只画当前那个标签", JSON.stringify(both.shown) === JSON.stringify(["browser", "conversation"]), both.shown);
		check("标题栏里没有第二颗关闭，关闭只在标签上", both.headerCloses === 0, both.headerCloses);

		await click(page, '[data-panel-tab="terminal"] [role="tab"]');
		await frames(page, 30);
		await pause(800);
		const switched = await measure();
		check("点终端标签切过去", JSON.stringify(switched.shown) === JSON.stringify(["conversation", "terminal"]), switched.shown);

		await click(page, '[data-panel-tab="terminal"] button[aria-label^="关闭"]');
		await frames(page, 30);
		await pause(800);
		const closed = await measure();
		await capture("关掉终端标签");
		check("✕ 关掉终端，剩下浏览器", JSON.stringify(closed.tabs) === JSON.stringify(["browser"]) && JSON.stringify(closed.shown) === JSON.stringify(["browser", "conversation"]), closed);
	}

	await openSettings(page, "外观");
	// 「面板」那一行原本紧挨在「调用链」下面，不在首屏；滚过去拍，前后两张才对得上同一块。
	await page.evaluate(`[...document.querySelectorAll("main *")].find((e) => e.children.length === 0 && e.textContent.trim() === "调用链")?.scrollIntoView({ block: "center" })`);
	await frames(page, 20);
	await pause(900);
	const appearance = await page.evaluate<{ row: boolean; split: boolean }>(`(() => ({
		row: document.body.innerText.includes("标签页：所有面板收在右侧"),
		split: [...document.querySelectorAll("button, [role=radio]")].some((e) => e.textContent.trim() === "分栏"),
	}))()`);
	await capture("外观设置");
	console.log("外观设置：", appearance);
	if (LABEL === "before") {
		await app.stop();
		process.exit(0);
	}
	check("外观设置里没有「面板：标签页 / 分栏」这一项", !appearance.row && !appearance.split, appearance);
	await pause(600);
	await stop?.();

	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${STAMP}_面板只留标签页_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
