/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 侧栏回到毛玻璃上：没有图标栏，去处回到侧栏里，侧栏不刷底、透出 macOS 的窗口材质，会话是单独一张
 * 卡片，和侧栏之间隔 4px。钉住的项目名用模糊盖住从底下滚过去的会话。
 *
 * 材质是系统画的，不在页面里，CDP 截图拍不到，所以静态图用 `screencapture -l` 只拍这一扇窗口
 * （做法同 `header-native-probe.ts`，要屏幕录制权限）；开合侧栏的视频走 CDP screencast，只看动效。
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/sidebar-glass-demo.ts [before|after] [light|dark] [outDir]`
 * `before` only takes the pictures and prints the numbers — run it on the old build to compare with.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { startApp, type RunningApp } from "./app.ts";
import { click, frames as settleFrames, hover, openPane, openSession, openSettings, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const THEME = process.argv[3] === "dark" ? "dark" : "light";
const OUT = process.argv[4] ?? join(homedir(), "Desktop", "Plume侧栏毛玻璃测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9883;
const W = 1280;
const H = 820;
const exec = promisify(execFile);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}
function note(what: string, saw: unknown) {
	console.log(`   · ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const PROJECTS = ["alpha", "beta", "gamma", "delta"];

async function seed(home: string) {
	const sessions: { id: string; title: string; cwd: string; project: string; ago: number }[] = [];
	for (const [p, name] of PROJECTS.entries()) {
		await mkdir(join(home, name), { recursive: true });
		for (let i = 0; i < 5; i++) sessions.push({ id: `${name}-${i}`, title: `${name} 会话 ${i + 1}：整理一下侧栏的样式`, cwd: join(home, name), project: name, ago: 30 + p * 11 + i * 2 });
	}
	await writeFile(join(home, "window.json"), JSON.stringify({ width: W, height: H, x: 40, y: 40 }));
	seedSessions(home, sessions.map((session) => {
		const at = Date.now() - session.ago * 60_000;
		const meta = { id: session.id, title: session.title, cwd: session.cwd, projectId: session.project, projectName: session.project, createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage, seq: 1 };
		return { meta, records: [] } as Parameters<typeof seedSessions>[1][number];
	}));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		appearance: { theme: THEME },
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
let windowId = 0;

/** This window's number in the window server, found by a title nobody else has. */
async function findWindow(): Promise<number> {
	const title = `Plume glass QA ${Date.now()}`;
	await app.evaluate(`document.title = ${JSON.stringify(title)}`);
	await pause(300);
	const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", `
		ObjC.import('CoreGraphics'); ObjC.import('Foundation');
		const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)));
		JSON.stringify(windows.filter(w => w.kCGWindowName === ${JSON.stringify(title)} && w.kCGWindowLayer === 0).map(w => w.kCGWindowNumber));
	`], { timeout: 5_000 });
	const ids = JSON.parse(stdout) as number[];
	if (ids.length !== 1) throw new Error(`window lookup: ${stdout}`);
	return ids[0];
}

/** The window as it is on screen, material included — and nothing else on screen. */
async function nativeShot(name: string): Promise<Buffer> {
	const path = join(OUT, `${STAMP}_${MODE}_${THEME}_${name}.png`);
	await exec("screencapture", ["-x", "-o", "-l", String(windowId), path], { timeout: 5_000 });
	return readFile(path);
}

/** Mean per-channel difference, 0–255, between two captures inside a page-space box. */
async function regionDiff(a: Buffer, b: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<number> {
	return app.evaluate<number>(`(async () => {
		const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
		const [p, q] = await Promise.all([load('data:image/png;base64,${a.toString("base64")}'), load('data:image/png;base64,${b.toString("base64")}')]);
		const scale = p.width / innerWidth;
		const read = (img) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(Math.round(${box.x} * scale), Math.round(${box.y} * scale), Math.round(${box.w} * scale), Math.round(${box.h} * scale)).data; };
		const da = read(p), db = read(q);
		let sum = 0, n = 0;
		for (let i = 0; i < da.length; i += 4) for (let c = 0; c < 3; c++) { sum += Math.abs(da[i + c] - db[i + c]); n++; }
		return Math.round(sum / n * 100) / 100;
	})()`);
}

interface Layout {
	rail: boolean;
	destinations: string[];
	settingsInSidebar: boolean;
	sidebarFill: string[];
	gap: number | null;
	panel: { left: number; top: number; right: number; bottom: number; radius: string; border: string } | null;
	/** How far the sidebar toggle's centre is from the centre of the first card's title row. */
	toggleOff: number | null;
	toolbar: boolean;
	/** Back and forward: their centres against the same title row, and whether each takes a press. */
	nav: { label: string; off: number; disabled: boolean }[];
}
const layout = () => app.evaluate<Layout>(`(() => {
	const shown = (el) => el.checkVisibility({ visibilityProperty: true });
	const aside = [...document.querySelectorAll('aside[data-pane="beside"]')].find(shown);
	// The first card beside the sidebar: the conversation's, or a page's (settings, the catalogue).
	const panel = [...document.querySelectorAll('[data-dock-pane="conversation"] .ly-dock-card, .ly-card-page')].filter((c) => shown(c) && !c.closest('aside, [inert]')).sort((x, y) => x.getBoundingClientRect().left - y.getBoundingClientRect().left)[0];
	const a = aside?.getBoundingClientRect(), p = panel?.getBoundingClientRect();
	// Every fill from the list up to the window: all of them have to be clear for the material to show.
	const fills = [];
	for (let n = aside?.querySelector('.ly-sidebar-fill'); n && n !== document.documentElement; n = n.parentElement) {
		fills.push(getComputedStyle(n).backgroundColor);
	}
	const toggle = [...document.querySelectorAll('button[aria-label*="侧边栏 "]')].find(shown)?.getBoundingClientRect();
	return {
		rail: Boolean(document.querySelector('[data-ly-app-rail]')),
		destinations: [...(aside?.querySelectorAll('nav button, [data-ly-list] ~ * button, .ly-sidebar-fill > * button') ?? [])].map((b) => b.innerText.trim()).filter((t) => ['拉取请求', '已安排', '定时任务', '插件', '设置'].some((w) => t.startsWith(w))),
		settingsInSidebar: Boolean(aside?.querySelector('[data-ly-open-settings]')),
		sidebarFill: [...new Set(fills)],
		gap: a && p ? Math.round((p.left - a.right) * 10) / 10 : null,
		panel: p ? { left: Math.round(p.left), top: Math.round(p.top), right: Math.round(innerWidth - p.right), bottom: Math.round(innerHeight - p.bottom), radius: getComputedStyle(panel).borderRadius, border: getComputedStyle(panel).borderTopColor } : null,
		toggleOff: toggle && p ? Math.round((toggle.top + toggle.height / 2 - (p.top + panel.clientTop + 22)) * 10) / 10 : null,
		toolbar: Boolean(document.querySelector('[data-ly-main-toolbar]')),
		nav: ['后退 ⌘[', '前进 ⌘]'].map((label) => [...document.querySelectorAll('button[aria-label="' + label + '"]')].find(shown)).filter(Boolean).map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label'), off: p ? Math.round((r.top + r.height / 2 - (p.top + panel.clientTop + 22)) * 10) / 10 : NaN, left: Math.round(r.left), disabled: b.disabled }; }),
	};
})()`);

/**
 * Scroll the list until a project heading is held at the top, and far enough past it that it is still
 * held `then` pixels further on — so two pictures differ only in the rows passing under it.
 */
async function findHeld(then: number): Promise<{ offset: number; text: string; box: { x: number; y: number; w: number; h: number } } | null> {
	return app.evaluate(`(async () => {
		const view = document.querySelector('aside .ly-sidebar-fill .ly-scroll-view');
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const held = () => {
			const top = view.getBoundingClientRect().top;
			return [...view.querySelectorAll('[data-ly-head]')].find((h) => Math.abs(h.getBoundingClientRect().top - top) < 1);
		};
		for (let offset = 10; offset < view.scrollHeight; offset += 10) {
			view.scrollTop = offset; await frame();
			const a = held();
			if (!a) continue;
			view.scrollTop = offset + ${then}; await frame();
			if (held() !== a) continue;
			view.scrollTop = offset; await frame();
			const r = a.getBoundingClientRect();
			return { offset, text: a.innerText.trim(), box: { x: r.x + 2, y: r.y + 2, w: r.width - 4, h: r.height - 4 } };
		}
		return null;
	})()`);
}

const scrollTo = (offset: number) => app.evaluate(`(async () => { document.querySelector('aside .ly-sidebar-fill .ly-scroll-view').scrollTop = ${offset}; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);

/** Every heading's fill. */
const heads = () => app.evaluate<{ text: string; background: string }[]>(`[...document.querySelectorAll('aside .ly-sidebar-fill [data-ly-head]')].filter((h) => h.getBoundingClientRect().height > 0).map((h) => ({ text: h.innerText.trim(), background: getComputedStyle(h).backgroundColor }))`);

/** The rows near the top: where each is against the heading's underside, and how much of it is drawn. */
const rowsUnder = () => app.evaluate<{ top: number; bottom: number; drawn: number }[]>(`(() => {
	const view = document.querySelector('aside .ly-sidebar-fill .ly-scroll-view');
	const head = [...view.querySelectorAll('[data-ly-head]')].find((h) => Math.abs(h.getBoundingClientRect().top - view.getBoundingClientRect().top) < 1);
	const line = head ? head.getBoundingClientRect().bottom : view.getBoundingClientRect().top;
	return [...view.querySelectorAll('[data-ly-row]')].map((row) => {
		const r = row.getBoundingClientRect();
		const m = /opacity\\(([\\d.]+)\\)/.exec(getComputedStyle(row).filter);
		return { top: Math.round(r.top - line), bottom: Math.round(r.bottom - line), drawn: m ? Number(m[1]) : 1 };
	}).filter((row) => row.bottom > -40 && row.top < 80);
})()`);

/** A fill the material can show through: none at all, or one with some transparency in it. */
const clear = (fill: string) => fill === "rgba(0, 0, 0, 0)" || /\/ 0?\.\d+\)$|, 0?\.\d+\)$/.test(fill);

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	try {
		await app.evaluate("document.fonts.ready");
		await until(app, `document.querySelectorAll("[data-ly-row]").length >= 6`);
		windowId = await findWindow();
		await pause(800);
		console.log(`\n== ${MODE} · ${THEME}`);

		await nativeShot("01_侧栏");
		const at = await layout();
		note("布局", at);

		// Two scroll positions with the same heading held and different rows underneath it: what shows
		// through the heading is the only thing that differs between the two pictures.
		const atTop = await heads();
		const found = await findHeld(20);
		let bleed: number | null = null;
		let pinnedHeads: Awaited<ReturnType<typeof heads>> = [];
		let under: Awaited<ReturnType<typeof rowsUnder>> = [];
		if (found) {
			await pause(400);
			const shotA = await nativeShot("02_钉住的项目名");
			pinnedHeads = await heads();
			under = await rowsUnder();
			await scrollTo(found.offset + 20);
			await pause(400);
			const shotB = await nativeShot("02b_钉住的项目名_再往下");
			under = [...under, ...(await rowsUnder())];
			bleed = await regionDiff(shotA, shotB, found.box);
		}
		note("没滚动时的标题", atTop.slice(0, 3));
		note("钉住时的标题", { found, bleed, heads: pinnedHeads.slice(0, 3), under });
		await scrollTo(0);

		// No material — Windows and Linux: the column and a pinned heading on it are one colour.
		const flat = await app.evaluate<{ column: string; header: string }>(`(async () => {
			const root = document.documentElement, was = root.getAttribute('data-vibrancy');
			root.removeAttribute('data-vibrancy');
			const column = getComputedStyle(document.querySelector('aside .ly-nav-column, aside[data-pane="beside"]')).backgroundColor;
			const header = getComputedStyle(document.querySelector('aside .ly-sidebar-fill [data-ly-head]')).backgroundColor;
			if (was !== null) root.setAttribute('data-vibrancy', was);
			return { column, header };
		})()`);
		note("没有毛玻璃时", flat);

		if (MODE === "after") {
			check("没有图标栏", !at.rail, at.rail);
			check("拉取请求、已安排、插件回到侧栏，设置在侧栏底部", at.destinations.length >= 3 && at.settingsInSidebar, at.destinations);
			check("侧栏一路到窗口都没有实色，透出材质（只剩窗口自己那层半透明底）", at.sidebarFill.every(clear), at.sidebarFill);
			check("会话卡片和侧栏之间隔 4px", at.gap === 4, at.gap);
			check("没有顶栏，卡片离窗口上、右、下边各 4px", !at.toolbar && at.panel?.top === 4 && at.panel?.right === 4 && at.panel?.bottom === 4, at.panel);
			check("侧栏开关和卡片标题栏在一条中线上", at.toggleOff !== null && Math.abs(at.toggleOff) <= 0.5, at.toggleOff);
			check("后退、前进还在红绿灯旁边，和卡片标题栏同一条中线；刚打开时都无处可去", at.nav.length === 2 && at.nav.every((n) => Math.abs(n.off) <= 0.5 && n.disabled), at.nav);
			check("项目名不铺底，不是一条条浅色带（滚动前后都是）", [...atTop, ...pinnedHeads].every((h) => h.background === "rgba(0, 0, 0, 0)"), [...atTop, ...pinnedHeads].map((h) => [h.text, h.background]));
			// A row is 32px; by the time half of it is under the heading its text has reached the heading's.
			check("滑进标题底下过半的行已经淡没，标题下沿以下的行完整画出", under.some((row) => row.top < 0) && under.every((row) => (row.top <= -16 ? row.drawn === 0 : row.top >= 0 ? row.drawn === 1 : row.drawn > 0 && row.drawn < 1)), under);
			check("钉住的标题底下透不出会话文字（两次滚动之间平均差 < 1/255）", bleed !== null && bleed < 1, bleed);
			check("没有毛玻璃时侧栏和钉住的标题同一种实色", flat.column === flat.header && !clear(flat.column), flat);
		}

		// A conversation with a panel open beside it: two cards, 4px of window between them.
		await openSession(app, "alpha-0");
		await openPane(app, "终端");
		await until(app, `[...document.querySelectorAll('[data-dock-pane]:not([data-dock-pane="conversation"]) .ly-dock-card')].some((c) => c.checkVisibility() && c.getBoundingClientRect().width > 100)`);
		await pause(1200);
		await nativeShot("05_右侧面板");
		const pair = await app.evaluate<{ conversation: number[]; panel: number[]; top: number[]; between: number; right: number; bottom: number; buttons: [string, number, number][] } | null>(`(() => {
			const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom)]; };
			const conversation = [...document.querySelectorAll('[data-dock-pane="conversation"] .ly-dock-card')].find((c) => c.checkVisibility());
			// Not a retained pane put away: it keeps its box, inert and at zero opacity.
			const panel = [...document.querySelectorAll('[data-dock-pane]:not([data-dock-pane="conversation"]) .ly-dock-card')].find((c) => c.checkVisibility({ opacityProperty: true }) && !c.closest('[inert]') && c.getBoundingClientRect().width > 100);
			if (!conversation || !panel) return null;
			const c = conversation.getBoundingClientRect(), p = panel.getBoundingClientRect();
			const buttons = [...panel.closest('[data-dock-pane]').querySelectorAll('[data-dock-actions] button')].filter((b) => b.checkVisibility({ opacityProperty: true })).map((b) => [b.getAttribute('aria-label'), Math.round(b.getBoundingClientRect().width), Math.round(b.querySelector('svg')?.getBoundingClientRect().width ?? 0)]);
			return { conversation: box(conversation), panel: box(panel), top: [Math.round(c.top), Math.round(p.top)], between: Math.round((p.left - c.right) * 10) / 10, right: Math.round(innerWidth - p.right), bottom: Math.round(innerHeight - p.bottom), buttons };
		})()`);
		note("会话和右侧面板", pair);
		if (MODE === "after") {
			check("右侧面板和会话是两张卡片，中间隔 4px", pair !== null && pair.between === 4, pair);
			check("会话和右侧面板都离窗口顶 4px，右侧面板离窗口右边、下边各 4px", pair !== null && pair.top.every((t) => t === 4) && pair.right === 4 && pair.bottom === 4, pair);
			check("右侧面板标题栏的按钮（新窗口、全屏、收起）都是 28px，和会话那边一个大小", pair !== null && pair.buttons.length >= 3 && pair.buttons.every(([, w]) => w === 28) && pair.buttons.some(([l]) => l?.startsWith("收起右侧面板")), pair?.buttons);
		}
		// The column folds from its own card, and comes back from the conversation's title bar.
		await click(app, '[data-dock-pane]:not([inert]) button[aria-label^="收起右侧面板"]');
		await pause(900);
		await nativeShot("05c_右栏收起");
		const unfold = await app.evaluate<boolean>(`[...document.querySelectorAll('[data-dock-pane="conversation"] [data-dock-header] button[aria-label^="展开右侧面板"]')].some((b) => b.checkVisibility())`);
		if (MODE === "after") check("收起右栏后，展开按钮在会话卡片的标题栏里", unfold, unfold);
		await click(app, '[data-dock-pane="conversation"] button[aria-label^="展开右侧面板"]');
		await until(app, `[...document.querySelectorAll('[data-dock-pane="terminal"] .ly-dock-card')].some((c) => !c.closest('[inert]') && c.getBoundingClientRect().width > 100)`);
		await pause(900);
		// Too narrow for the two side by side, the panel goes under the conversation: no gap on top,
		// and still 4px between the two cards.
		await app.send("Emulation.setDeviceMetricsOverride", { width: 770, height: 576, deviceScaleFactor: 0, mobile: false });
		await pause(900);
		await nativeShot("05b_窄窗口面板在下");
		const stacked = await app.evaluate<{ top: number; between: number } | null>(`(() => {
			const card = (kind) => [...document.querySelectorAll('[data-dock-pane="' + kind + '"] .ly-dock-card')].find((c) => c.checkVisibility({ opacityProperty: true }) && !c.closest('[inert]'))?.getBoundingClientRect();
			const c = card('conversation'), t = card('terminal');
			if (!c || !t || t.top < c.bottom - 1) return null;
			return { top: Math.round(c.top), between: Math.round((t.top - c.bottom) * 10) / 10 };
		})()`);
		// Back the way `desktop-compatibility` does it: clearing the override alone left the dock stacked.
		await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 0, mobile: false });
		await app.send("Emulation.clearDeviceMetricsOverride", {});
		await until(app, `(() => { const c = document.querySelector('[data-dock-pane="conversation"]')?.getBoundingClientRect(), t = document.querySelector('[data-dock-pane="terminal"]')?.getBoundingClientRect(); return c && t && t.left >= c.right - 1; })()`);
		await pause(900);
		if (MODE === "after") check("窄窗口里面板落到会话下面：会话离窗口顶 4px，两张卡片之间仍隔 4px", stacked !== null && stacked.top === 4 && stacked.between === 4, stacked);
		// Both seams: a 3×30 grip that follows the pointer along the seam, not a line down the window.
		for (const [name, seam] of [["会话列表和会话之间", '[role="separator"][aria-label="调整侧边栏宽度"]'], ["会话和面板之间", "[data-ly-pane-dock] .ly-splitter"]] as const) {
			await hover(app, seam);
			const seen: { pointer: number; grip: { width: number; height: number; centre: number; left: number; right: number } | null }[] = [];
			for (const [step, dy] of [0, 140].entries()) {
				const at = await app.evaluate<{ x: number; y: number }>(`(() => { const r = [...document.querySelectorAll(${JSON.stringify(seam)})].find((s) => s.checkVisibility()).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 + ${dy} }; })()`);
				await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
				await pause(500);
				await nativeShot(`07_${name}的把手_${step + 1}`);
				const grip = await app.evaluate<{ width: number; height: number; centre: number; left: number; right: number } | null>(`(() => {
					const mark = [...document.querySelectorAll(${JSON.stringify(seam)})].find((s) => s.checkVisibility())?.querySelector('span');
					if (!mark) return null;
					const r = mark.getBoundingClientRect();
					return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, centre: Math.round((r.top + r.height / 2) * 10) / 10, left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 };
				})()`);
				seen.push({ pointer: Math.round(at.y * 10) / 10, grip });
			}
			note(`${name}的把手`, seen);
			if (MODE === "after") check(`${name}：悬停出现 3×30 的把手，跟着指针上下走`, seen.every((s) => s.grip !== null && s.grip.width === 3 && s.grip.height === 30 && Math.abs(s.grip.centre - s.pointer) <= 1) && seen[1].grip!.centre - seen[0].grip!.centre >= 100, seen);
		}
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W / 2, y: H / 2 });

		const conversationLayout = await layout();
		note("开着会话时", conversationLayout);
		if (MODE === "after") check("会话卡片离侧栏 4px", conversationLayout.gap === 4, conversationLayout.gap);

		// The three places back in the sidebar, each drawing its own list in its own card.
		for (const [index, place] of ["拉取请求", "定时任务", "插件"].entries()) {
			await click(app, "aside button", place, "starts");
			await pause(1200);
			await nativeShot(`06_${index + 1}_${place}`);
			const page = await layout();
			note(place, { gap: page.gap, panel: page.panel });
			if (MODE === "after") check(`${place}：页面是一张卡片，离窗口顶 4px，离侧栏 4px`, page.gap === 4 && page.panel?.top === 4 && page.panel?.right === 4, { gap: page.gap, panel: page.panel });
		}
		await click(app, "aside button", "alpha 会话 1", "starts");
		await pause(800);
		// 后退回到刚才的「插件」，前进再回到会话。
		const solo = () => app.evaluate<boolean>(`[...document.querySelectorAll('[data-ly-solo-screen]')].some((s) => s.checkVisibility({ visibilityProperty: true }))`);
		await click(app, 'button[aria-label="后退 ⌘["]');
		await pause(900);
		await nativeShot("06_4_后退到插件");
		const backed = await solo();
		await click(app, 'button[aria-label="前进 ⌘]"]');
		await pause(900);
		const forwarded = !(await solo());
		if (MODE === "after") check("按后退回到上一页（插件），按前进回到会话", backed && forwarded, { backed, forwarded });

		// The sidebar sliding shut and open, then settings in the same frame.
		const recorded: Frame[] = [];
		const stop = await startRecording(PORT, recorded);
		await pause(1000);
		await click(app, 'button[aria-label^="隐藏侧边栏"]');
		await pause(1200);
		const closed = await layout();
		await nativeShot("03_侧栏收起");
		await click(app, 'button[aria-label^="显示侧边栏"]');
		await pause(1200);
		await openSettings(app, "外观");
		await settleFrames(app, 30);
		await pause(1000);
		await stop();
		await nativeShot("04_设置页");
		const settings = await layout();
		note("收起时", closed.panel);
		note("设置页", settings);
		if (MODE === "after") {
			check("收起侧栏后卡片离窗口左边 4px", closed.panel?.left === 4, closed.panel);
			check("设置页也是透明侧栏加一张卡片，离窗口顶 4px", settings.sidebarFill.every(clear) && settings.gap === 4 && settings.panel?.top === 4, { fill: settings.sidebarFill, gap: settings.gap, panel: settings.panel });
		}
		const back = await app.evaluate<number>(`(() => {
			const button = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === '返回工作区' && b.checkVisibility());
			const card = [...document.querySelectorAll('.ly-card-page')].find((c) => c.checkVisibility());
			return Math.round((button.getBoundingClientRect().top - card.getBoundingClientRect().top) * 10) / 10;
		})()`);
		if (MODE === "after") check("设置页的「返回工作区」在红绿灯那一行（44px）下面，和改版前一样", back === 44, back);

		/*
		 * Two conversations one above the other. The lower screen's cards are the top row of their own
		 * dock, and still have a screen above them: they keep the gap, only the upper ones lose it.
		 */
		await app.evaluate(`(() => {
			const key = Object.keys(localStorage).find((k) => k.startsWith('ly:split:'));
			localStorage.setItem(key, JSON.stringify({ version: 1, focused: 'alpha-0', tree: { type: 'split', dir: 'col', children: [{ type: 'leaf', sessionId: 'alpha-0' }, { type: 'leaf', sessionId: 'alpha-1' }], sizes: [0.5, 0.5] } }));
			location.reload();
		})()`).catch(() => undefined);
		await until(app, `document.querySelectorAll('[data-ly-split-pane]').length === 2 && document.querySelectorAll('[data-dock-pane="conversation"] .ly-dock-card').length >= 2`);
		await pause(1200);
		await nativeShot("08_上下分屏");
		const screens = await app.evaluate<{ top: number; between: number } | null>(`(() => {
			const cards = [...document.querySelectorAll('[data-ly-split-pane] [data-dock-pane="conversation"] .ly-dock-card')].filter((c) => c.checkVisibility()).map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top);
			if (cards.length < 2) return null;
			return { top: Math.round(cards[0].top), between: Math.round((cards[1].top - cards[0].bottom) * 10) / 10 };
		})()`);
		if (MODE === "after") check("上下分屏：上面那屏离窗口顶 4px，两屏之间仍隔 4px", screens !== null && screens.top === 4 && screens.between === 4, screens);
		const passed = checks.filter((c) => c.ok).length;
		await encode(recorded, join(OUT, `${STAMP}_${MODE}_${THEME}_侧栏开合与设置页_${passed}of${checks.length}.mp4`));
		console.log(`\n${passed}/${checks.length} passed · ${OUT}`);
		if (passed !== checks.length) process.exitCode = 1;
	} finally {
		await app.stop();
	}
}

await main();
