/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 标签页排法、单屏时，右栏的标签条画在窗口顶栏里——边验边录。
 *
 * 开终端、从顶栏的「+」开浏览器；量标签条左缘是否落在右栏分隔线上、右栏里是否还留着那一行；
 * 拖分隔线、收起侧栏时左缘跟不跟；全屏时会话标题还在不在；切到插件页标签条走不走；
 * 右栏收起、展开，收着时按工具栏按钮会不会展开，终端有没有被重建。
 *
 * 用法：node --experimental-strip-types e2e/toolbar-panel-tabs-demo.ts [before|after] [输出目录]
 * `before` 只拍开了两个面板的那一张，给改动前对照用。
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
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume面板标签上提测试");
const PORT = 9494;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "tabs-up";

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1320, height: 860, x: 0, y: 0 }));
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
	const meta = { id: SESSION, title: "为什么一个简单的删除要跑这么久", cwd: project, projectId, projectName: "project", createdAt: 1, updatedAt: 2, modelId: "none", messageCount: 2, usage: { ...zero, cost: zero }, seq: 3 };
	seedSessions(home, [{
		meta,
		records: [
			{ seq: 1, ts: 1, type: "meta", meta },
			{ seq: 2, ts: 2, type: "message", message: { role: "user", content: [{ type: "text", text: "为什么一个简单的删除要跑这么久？" }], timestamp: 2 } },
			{ seq: 3, ts: 3, type: "message", message: { role: "assistant", content: [{ type: "text", text: "删除本身很快，慢在删之前的检查。" }], timestamp: 3 } },
		],
	} as never]);
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

interface Geometry {
	bar: { left: number; right: number; top: number; height: number } | null;
	divider: number | null;
	tabs: string[];
	pane: { kind: string; left: number; top: number; contentTop: number } | null;
	frameTop: number;
	conversationTop: number;
	paneHeaders: number;
	endButtons: number;
	end: { left: number; right: number };
	toolbarRight: number;
	title: { right: number } | null;
	conversationRight: number;
	frameRight: number;
	toggle: string | null;
	/** 顶栏右半边从会话按钮到窗口角的每一颗：宽、高、图标宽，以及和前一颗的间距。 */
	buttons: { w: number; h: number; icon: number; gap: number }[];
}

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
	// 从看得见的东西取证：顶栏里的标签条在哪、右栏里当前那一格在哪、它自己还有没有标题行。
	const measure = () => page.evaluate<Geometry>(`(() => {
		const round = (n) => Math.round(n * 10) / 10;
		const bar = document.querySelector("[data-ly-main-toolbar] [data-ly-toolbar-panel]");
		const panes = [...document.querySelectorAll("[data-dock-pane]")].filter((p) => p.dataset.dockPane !== "conversation" && !p.inert && getComputedStyle(p).opacity !== "0");
		const pane = panes[0];
		const r = bar?.getBoundingClientRect();
		const p = pane?.getBoundingClientRect();
		const title = document.querySelector("[data-ly-toolbar-title]")?.getBoundingClientRect();
		return {
			bar: r ? { left: round(r.left), right: round(r.right), top: round(r.top), height: round(r.height) } : null,
			divider: bar?.querySelector("[data-ly-toolbar-divider]") ? round(bar.querySelector("[data-ly-toolbar-divider]").getBoundingClientRect().left) : null,
			tabs: [...(bar ?? document).querySelectorAll("[data-panel-tab]")].filter((t) => t.checkVisibility()).map((t) => t.dataset.panelTab),
			pane: pane ? { kind: pane.dataset.dockPane, left: round(p.left), top: round(p.top), contentTop: round(pane.querySelector("[data-dock-content]").getBoundingClientRect().top) } : null,
			frameTop: round(document.querySelector("[data-ly-frame-panel]").getBoundingClientRect().top),
			conversationTop: round(document.querySelector('[data-dock-pane="conversation"] [data-dock-content]').getBoundingClientRect().top),
			paneHeaders: panes.filter((x) => x.querySelector("[data-dock-header]")).length,
			endButtons: document.querySelectorAll("[data-ly-main-toolbar] [data-ly-toolbar-end] button").length,
			end: (() => { const e = document.querySelector("[data-ly-main-toolbar] [data-ly-toolbar-end]").getBoundingClientRect(); return { left: round(e.left), right: round(e.right) }; })(),
			toolbarRight: round(document.querySelector("[data-ly-main-toolbar]").getBoundingClientRect().right),
			conversationRight: round(document.querySelector('[data-dock-pane="conversation"]').getBoundingClientRect().right),
			frameRight: round(document.querySelector("[data-dock-panes]").getBoundingClientRect().right),
			toggle: bar?.querySelector('button[aria-label$="右侧面板"]')?.getAttribute("aria-label") ?? null,
			buttons: (() => {
				const list = [...document.querySelectorAll("[data-ly-main-toolbar] [data-ly-toolbar-end] button, [data-ly-main-toolbar] [data-ly-toolbar-panel] [data-dock-actions] button, [data-ly-main-toolbar] [data-ly-toolbar-panel] button[aria-label$='右侧面板']")].filter((b) => b.checkVisibility());
				return list.map((b, i) => { const r = b.getBoundingClientRect(); const prev = list[i - 1]?.getBoundingClientRect(); return { w: round(r.width), h: round(r.height), icon: round(b.querySelector("svg")?.getBoundingClientRect().width ?? 0), gap: prev ? round(r.left - prev.right) : 0 }; });
			})(),
			title: title ? { right: round(title.right) } : null,
		};
	})()`);
	const aligned = (g: Geometry) => g.divider !== null && g.pane !== null && Math.abs(g.divider - g.pane.left) <= 1;

	await until(page, `document.querySelector("[data-ly-row='${SESSION}'] > button")`, 3600);
	await openSession(page, SESSION);
	const stop = LABEL === "before" ? null : await startRecording(PORT, recorded);
	await pause(900);

	await click(page, '[data-ly-panel-quick] button[aria-label^="终端"]');
	await until(page, `document.querySelector('[data-dock-pane="terminal"] .xterm')`, 1200);
	await pause(900);
	// 浏览器从标签条的「+」里开：改动前它在右栏里，改动后在顶栏里，选择器两边都认。
	// 浏览器那一格总挂着（关着时也在），它的标题栏里也有一颗「+」，所以要圈定在终端那一格或顶栏里。
	await click(page, `[data-dock-pane="terminal"] button[aria-label="添加面板"], [data-ly-toolbar-panel] button[aria-label="添加面板"]`);
	await click(page, '[role="menuitem"]', "浏览器", "starts");
	await until(page, `[...document.querySelectorAll("[data-panel-tab]")].length >= 2`);
	await frames(page, 40);
	await pause(800);
	await capture("终端和浏览器两个标签");
	const two = await measure();
	console.log("两个标签：", two);
	if (LABEL === "before") {
		await app.stop();
		process.exit(0);
	}

	check("标签条在窗口顶栏里，两个标签都在", two.bar !== null && JSON.stringify(two.tabs) === JSON.stringify(["terminal", "browser"]), two);
	check("右栏里不再有自己的标题行", two.paneHeaders === 0, two.paneHeaders);
	check("右栏内容从顶栏下沿开始，和对话同高", two.pane !== null && Math.abs(two.pane.contentTop - two.conversationTop) <= 1 && Math.abs(two.pane.top - two.frameTop) <= 2, two);
	check("顶栏里那一小段线落在右栏分隔线上（±1px）", aligned(two), { divider: two.divider, pane: two.pane?.left });
	check("开面板的按钮一个没少，停在右栏分隔线左边", two.endButtons >= 4 && two.divider !== null && two.end.right <= two.divider && two.divider - two.end.right <= 8, { buttons: two.endButtons, end: two.end, divider: two.divider });
	const rightHalf = two.buttons.slice(two.endButtons);
	check("右栏的按钮和会话那组一样大（28px，图标 13–15px）", rightHalf.length >= 2 && two.buttons.every((b) => b.w === 28 && b.h === 28 && b.icon >= 13 && b.icon <= 15), two.buttons);
	check("右栏那组按钮之间都隔 2px，开关也不例外", rightHalf.slice(1).every((b) => b.gap === 2), rightHalf);
	check("窗口角上是右栏自己的按钮（全屏在最右）", two.bar !== null && two.toolbarRight - two.bar.right <= 8, { bar: two.bar, toolbarRight: two.toolbarRight });

	// 点顶栏里的「终端」标签切回去。
	await click(page, '[data-ly-toolbar-panel] [data-panel-tab="terminal"] [role="tab"]');
	await pause(900);
	const back = await measure();
	check("点顶栏里的标签能切换", back.pane?.kind === "terminal", back.pane);

	// 拖分隔线：左缘跟着走。
	const splitter = await page.evaluate<{ x: number; y: number } | null>(`(() => { const s = document.querySelector("[data-dock-panes] .ly-splitter"); if (!s) return null; const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	if (splitter) {
		await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...splitter });
		await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...splitter, button: "left", clickCount: 1 });
		for (let step = 1; step <= 12; step++) {
			await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: splitter.x - step * 10, y: splitter.y, button: "left", buttons: 1 });
			await pause(30);
		}
		await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: splitter.x - 120, y: splitter.y, button: "left", clickCount: 1 });
	}
	await pause(900);
	const dragged = await measure();
	await capture("拖宽右栏");
	check("拖分隔线后，标签条左缘跟着右栏走", Boolean(splitter) && aligned(dragged) && (dragged.pane?.left ?? 0) < (back.pane?.left ?? 0) - 60, { before: back.pane?.left, after: dragged.pane?.left, divider: dragged.divider });

	// 收起侧栏：滑动的每一帧都量一次，看左缘有没有掉队。
	const drift = await page.evaluate<number>(`(async () => {
		document.querySelector('button[aria-label^="隐藏侧边栏"]').click();
		let worst = 0;
		for (let n = 0; n < 30; n++) {
			await new Promise(requestAnimationFrame);
			// 量画出来的那一帧：rAF 里 ResizeObserver 还没回调，量到的是上一帧的标签条。
			await new Promise((r) => setTimeout(r, 0));
			const d = document.querySelector("[data-ly-toolbar-panel] [data-ly-toolbar-divider]").getBoundingClientRect().left;
			const p = [...document.querySelectorAll("[data-dock-pane]")].find((x) => x.dataset.dockPane === "terminal").getBoundingClientRect().left;
			worst = Math.max(worst, Math.abs(d - p));
		}
		return Math.round(worst * 10) / 10;
	})()`);
	await pause(700);
	const closed = await measure();
	await capture("收起侧栏");
	check("收起侧栏时每一帧左缘都贴着分隔线（最大偏差 ≤1px）", drift <= 1 && aligned(closed), { drift, closed: { divider: closed.divider, pane: closed.pane?.left } });
	await click(page, 'button[aria-label^="显示侧边栏"]');
	await pause(900);

	// 全屏：右栏盖满，会话标题还在，标签条从标题后面开始。
	await click(page, '[data-ly-toolbar-panel] button[aria-label^="全屏"]');
	await pause(1000);
	const full = await measure();
	await capture("右栏全屏");
	check("全屏时会话标题还在，标签条不压着它", full.title !== null && full.bar !== null && full.title.right <= full.bar.left, full);
	await click(page, '[data-ly-toolbar-panel] button[aria-label^="退出全屏"]');
	await pause(900);
	const restored = await measure();
	check("退出全屏后左缘回到分隔线", aligned(restored), restored);

	// 去插件页再回来：标签条只在对话页的顶栏里。
	await click(page, '[data-ly-rail-item="plugins"]');
	await pause(1000);
	const away = await measure();
	await capture("插件页");
	check("插件页的顶栏里没有标签条", away.bar === null, away.bar);
	await click(page, '[data-ly-rail-item="chat"]');
	await pause(1000);
	const home = await measure();
	check("回到对话，标签条回来且对齐", home.bar !== null && aligned(home), home);
	check("窗口角上有收起右栏的开关", home.toggle === "收起右侧面板" && home.bar !== null && home.toolbarRight - home.bar.right <= 8, home.toggle);

	// 收起右栏：对话占满，顶栏里只剩开关，面板按钮回到右端；终端没被关。
	await page.evaluate(`document.querySelector('[data-dock-pane="terminal"] .xterm').setAttribute("data-demo-shell", "")`);
	await click(page, '[data-ly-toolbar-panel] button[aria-label="收起右侧面板"]');
	await pause(1000);
	const folded = await measure();
	await capture("收起右栏");
	check("收起后右栏不画，对话占满", folded.pane === null && Math.abs(folded.conversationRight - folded.frameRight) <= 1, folded);
	check("收起后顶栏里只剩「展开」开关，标签条走了", folded.toggle === "展开右侧面板" && folded.tabs.length === 0 && folded.divider === null, folded);
	check("收起后面板按钮紧挨开关、在顶栏右端", folded.bar !== null && folded.end.right <= folded.bar.left + 1 && folded.toolbarRight - folded.bar.right <= 8, { end: folded.end, bar: folded.bar });
	check("收起后开关和 ⋮ 之间也是 2px，没有另留边", folded.buttons.at(-1)?.gap === 2 && folded.buttons.at(-1)?.w === 28, folded.buttons.slice(-2));

	await click(page, '[data-ly-toolbar-panel] button[aria-label="展开右侧面板"]');
	await pause(1000);
	const unfolded = await measure();
	await capture("展开右栏");
	const sameShell = await page.evaluate<boolean>(`Boolean(document.querySelector("[data-demo-shell]")?.isConnected)`);
	check("展开回到原来那一格，标签条对齐，两个标签都在", unfolded.pane?.kind === home.pane?.kind && aligned(unfolded) && unfolded.tabs.length === 2, unfolded);
	check("收起再展开，终端还是原来那一个", sameShell, sameShell);

	// 收着时按工具栏的「浏览器」：展开并切到浏览器，不是把它关掉。
	await click(page, '[data-ly-toolbar-panel] button[aria-label="收起右侧面板"]');
	await pause(800);
	await click(page, '[data-ly-panel-quick] button[aria-label^="浏览器"]');
	await pause(1000);
	const reopened = await measure();
	await capture("收着时按浏览器");
	check("收着时按工具栏的浏览器，是展开去看它", reopened.pane?.kind === "browser" && reopened.tabs.length === 2 && aligned(reopened), reopened);

	// 关掉两个标签：右栏没了，顶栏里的标签条也没了。
	await click(page, '[data-ly-toolbar-panel] [data-panel-tab="terminal"] button[aria-label^="关闭"]');
	await pause(700);
	await click(page, '[data-ly-toolbar-panel] [data-panel-tab="browser"] button[aria-label^="关闭"]');
	await pause(1000);
	const none = await measure();
	await capture("关掉所有标签");
	check("标签都关掉后顶栏里没有标签条", none.bar === null && none.pane === null, none);
	check("没有右栏时，开面板的按钮回到顶栏右端", none.toolbarRight - none.end.right <= 8, { end: none.end, toolbarRight: none.toolbarRight });
	await pause(600);
	await stop?.();

	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${STAMP}_顶栏标签条_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
