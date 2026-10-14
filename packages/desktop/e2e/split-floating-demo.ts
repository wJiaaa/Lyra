/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 分屏时一屏是一张卡，对话铺在上面，标签栏整体是浮在里面的一块卡；单屏照旧每格一张卡。
 *
 * 分屏走真的右键菜单，面板从每屏自己的「面板」菜单开。量的是卡片画在哪、圆角、外边距——看得见的
 * 东西，不读 store。
 *
 * 用法（在 packages/desktop 下）：node --experimental-strip-types e2e/split-floating-demo.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, contextClick, frames, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT = join(homedir(), "Desktop", "Plume分屏浮卡测试");
const PORT = 9872;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const LEFT = "qa-long";
const RIGHT = "qa-short";

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

let app: RunningApp;

async function screenshot(name: string): Promise<void> {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

interface Card { kind: string; tile: string | null; left: number; top: number; right: number; bottom: number; radius: string; margin: string }

/** 某个范围里看得见的每一格卡片画在哪、长什么样，从左到右排。 */
function cards(scope: string): Promise<Card[]> {
	return app.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(`${scope} [data-dock-pane]`)})]
		.filter((el) => el.checkVisibility({ opacityProperty: true }))
		.map((el) => {
			const card = el.querySelector('.ly-dock-card');
			const r = card.getBoundingClientRect();
			const s = getComputedStyle(card);
			return { kind: el.dataset.dockPane, tile: card.dataset.tile ?? null, left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), radius: s.borderTopLeftRadius, margin: s.margin };
		})
		.sort((a, b) => a.left - b.left || a.top - b.top))()`);
}

/** 屏卡：这一屏的 dock 自己的圆角和描边。 */
function screenCard(pane: string): Promise<{ radius: string; border: string; left: number; right: number }> {
	return app.evaluate(`(() => { const d = document.querySelector('[data-ly-split-pane="${pane}"] > .ly-dock'); const s = getComputedStyle(d); const r = d.getBoundingClientRect(); return { radius: s.borderTopLeftRadius, border: s.borderTopWidth + ' ' + s.borderTopStyle, left: Math.round(r.left), right: Math.round(r.right) }; })()`);
}

/** 在指定那一屏的「面板」菜单里开一个面板，等它的卡片出现。 */
async function openIn(pane: string, label: string, kind: string): Promise<void> {
	await click(app, `[data-ly-split-pane="${pane}"] button[aria-label="面板"]`);
	await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`);
	await click(app, '[role="menuitem"]', label, "starts");
	await until(app, `[...document.querySelectorAll('[data-ly-split-pane="${pane}"] [data-dock-pane^="${kind}"]')].some((el) => el.checkVisibility({ opacityProperty: true }))`, 8000);
}

async function main(): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const renderer = await startDevRenderer();
	app = await startApp({ port: PORT, seed: (home) => seedInteractions(home), rendererUrl: renderer.url });
	const recorded: Frame[] = [];
	let stop: (() => Promise<void>) | null = null;
	try {
		await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 0, mobile: false });
		await openSession(app, LEFT);
		stop = await startRecording(PORT, recorded);
		await pause(800);

		await contextClick(app, `[data-ly-row="${RIGHT}"] > button`);
		await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === '打开方式')`);
		await click(app, '[role="menuitem"]', "打开方式");
		await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === '分屏')`);
		await click(app, '[role="menuitem"]', "分屏");
		await until(app, `document.querySelectorAll('[data-ly-split-pane]').length === 2`, 8000);
		await pause(1000);

		await openIn(LEFT, "终端", "terminal");
		await pause(700);
		await openIn(LEFT, "文件", "files");
		await pause(700);
		await openIn(RIGHT, "终端", "terminal");
		await click(app, `[data-ly-split-pane="${LEFT}"] textarea`);
		await frames(app, 40);
		await pause(1200);
		await screenshot("01_分屏_标签栏一块浮卡");

		const left = await cards(`[data-ly-split-pane="${LEFT}"]`);
		const right = await cards(`[data-ly-split-pane="${RIGHT}"]`);
		console.log("左屏：", JSON.stringify(left));
		console.log("右屏：", JSON.stringify(right));
		const [chat, panel] = left;
		const screen = await screenCard(LEFT);
		check("屏卡：这一屏自己有圆角和描边", screen.radius !== "0px" && screen.border === "1px solid", screen);
		check("左屏开了两个面板，看得见的只有对话和一块浮卡", left.length === 2 && chat?.kind === "conversation" && panel?.tile === "float", left.map((c) => [c.kind, c.tile]));
		check("对话铺在屏卡上，自己不是一张卡", chat?.tile === "base" && chat.radius === "0px" && chat.margin === "0px", chat);
		// 一屏 660px 宽放不下对话 420 + 面板 300 并排，`fitTree` 把面板排到对话下面——挨着对话的是上边。
		check("这一宽度下浮卡在对话下面", !!panel && !!chat && panel.top > chat.bottom, panel && chat && [chat.bottom, panel.top]);
		check("浮卡有圆角，挨对话的上边 3px，其余三边离屏卡 6px", panel?.radius === "8px" && panel.margin === "3px 6px 6px", panel && [panel.radius, panel.margin]);
		check("浮卡左右离屏卡内沿各 6px", !!panel && panel.left - (screen.left + 1) === 6 && screen.right - 1 - panel.right === 6, panel ? [panel.left - (screen.left + 1), screen.right - 1 - panel.right] : null);
		const tabs = await app.evaluate<number>(`[...document.querySelectorAll('[data-ly-split-pane="${LEFT}"] [data-panel-tab]')].filter((t) => t.checkVisibility({ opacityProperty: true })).length`);
		check("两个面板是同一块浮卡上的两个标签", tabs === 2, tabs);
		check("右屏同样：对话铺底、终端一块浮卡", right.length === 2 && right[0]?.tile === "base" && right[1]?.tile === "float", right.map((c) => [c.kind, c.tile]));

		// 切标签：换的是浮卡里的内容，卡片还是那一块
		await click(app, `[data-ly-split-pane="${LEFT}"] [data-dock-pane]:not([inert]) [data-panel-tab^="terminal"] [role="tab"]`);
		await frames(app, 30);
		await pause(900);
		const switched = await cards(`[data-ly-split-pane="${LEFT}"]`);
		check("切到终端标签，浮卡位置不变", switched[1]?.kind.startsWith("terminal") === true && switched[1].left === panel?.left && switched[1].right === panel.right, switched[1]);

		// 全屏：浮卡铺满屏卡，四边都留 6px
		await click(app, `[data-ly-split-pane="${LEFT}"] [data-dock-pane^="terminal"] button[aria-label^="全屏"]`);
		await frames(app, 40);
		await pause(1000);
		await screenshot("02_分屏_面板全屏");
		const full = await cards(`[data-ly-split-pane="${LEFT}"]`);
		check("全屏时浮卡四边都离屏卡 6px", full.length === 1 && full[0]?.margin === "6px", full.map((c) => [c.kind, c.margin]));
		await click(app, `[data-ly-split-pane="${LEFT}"] [data-dock-pane^="terminal"] button[aria-label^="退出全屏"]`);
		await frames(app, 40);
		await pause(800);

		// 回到单屏：每格又各是一张卡，没有浮卡
		await click(app, `[data-ly-split-pane="${RIGHT}"] [data-ly-split-close="${RIGHT}"]`);
		await until(app, `document.querySelectorAll('[data-ly-split-pane]').length === 1`, 8000);
		await frames(app, 40);
		await pause(1200);
		await screenshot("03_回到单屏");
		const single = await cards("[data-ly-split-pane]");
		check("单屏：每格都是 2px 外边距的卡，没有 data-tile", single.length === 2 && single.every((c) => c.tile === null && c.margin === "2px" && c.radius !== "0px"), single.map((c) => [c.kind, c.tile, c.margin, c.radius]));
	} finally {
		if (stop) await stop();
		await app.stop();
		await renderer.close();
	}
	const passed = checks.filter((c) => c.ok).length;
	if (recorded.length) await encode(recorded, join(OUT, `${STAMP}_分屏标签栏浮卡_${passed}of${checks.length}.mp4`), 30, 1200);
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exit(1);
});
