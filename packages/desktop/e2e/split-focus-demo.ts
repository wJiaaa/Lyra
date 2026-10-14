/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 分屏时看得出焦点在哪一屏：非焦点屏的内容淡一档，焦点屏原样，单屏不受影响。
 *
 * 分屏走真的右键菜单「打开方式 → 分屏」，焦点靠真鼠标点另一屏切过去，量的是 `getComputedStyle`
 * 读出来的 opacity 和标题颜色——看得见的东西，不读 store。
 *
 * `before` 在页面里压一条覆盖样式，把淡化关掉，拍的就是改之前的样子。
 *
 * 用法（在 packages/desktop 下）：node --experimental-strip-types e2e/split-focus-demo.ts [before|after]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, contextClick, frames, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = join(homedir(), "Desktop", "Plume分屏焦点测试");
const PORT = 9871;
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
	await writeFile(join(OUT, `${STAMP}_${MODE}_${name}.png`), Buffer.from(image.data, "base64"));
}

interface Look { content: number; composer: number | null; terminal: number | null; title: string | null; focused: boolean }

/** 每一屏量出来的样子：对话内容、输入框、终端内容的实际不透明度（乘上祖先的），标题颜色。 */
function looks(): Promise<Record<string, Look>> {
	return app.evaluate(`(() => {
		const chain = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return Math.round(o * 100) / 100; };
		const out = {};
		for (const pane of document.querySelectorAll('[data-ly-split-pane]')) {
			const content = pane.querySelector('[data-dock-content="conversation"]');
			const composer = pane.querySelector('[data-dock-content="conversation"] .ly-composer-dock');
			const terminal = [...pane.querySelectorAll('[data-dock-content^="terminal"]')].find((el) => el.checkVisibility());
			const title = pane.querySelector('[data-ly-screen-title]');
			out[pane.dataset.lySplitPane] = {
				content: content ? chain(content) : 0,
				composer: composer ? chain(composer) : null,
				terminal: terminal ? chain(terminal) : null,
				title: title ? getComputedStyle(title).color : null,
				focused: pane.hasAttribute('data-ly-split-focused'),
			};
		}
		return out;
	})()`);
}

/** 在指定那一屏的「面板」菜单里开终端。 */
async function openTerminal(pane: string): Promise<void> {
	await click(app, `[data-ly-split-pane="${pane}"] button[aria-label="面板"]`);
	await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim().startsWith('终端'))`);
	await click(app, '[role="menuitem"]', "终端", "starts");
	await until(app, `[...document.querySelectorAll('[data-ly-split-pane="${pane}"] [data-dock-content^="terminal"]')].some((el) => el.checkVisibility())`, 8000);
}

async function main(): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const renderer = await startDevRenderer();
	app = await startApp({ port: PORT, seed: (home) => seedInteractions(home), rendererUrl: renderer.url });
	const recorded: Frame[] = [];
	let stop: (() => Promise<void>) | null = null;
	try {
		await app.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 0, mobile: false });
		if (MODE === "before") {
			await app.evaluate(`(() => { const s = document.createElement('style'); s.textContent = '[data-ly-split-root] [data-dock-content], [data-ly-split-root] .ly-composer-dock { opacity: 1 !important } [data-ly-split-root] [data-ly-screen-title] { color: var(--color-ink) !important }'; document.head.append(s); })()`);
		}
		await openSession(app, LEFT);
		stop = await startRecording(PORT, recorded);
		await pause(800);

		// 右键侧栏里的另一个会话 → 打开方式 → 分屏
		await contextClick(app, `[data-ly-row="${RIGHT}"] > button`);
		await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === '打开方式')`);
		await click(app, '[role="menuitem"]', "打开方式");
		await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === '分屏')`);
		await click(app, '[role="menuitem"]', "分屏");
		await until(app, `document.querySelectorAll('[data-ly-split-pane]').length === 2`, 8000);
		await pause(1000);

		await openTerminal(LEFT);
		await pause(600);
		await openTerminal(RIGHT);
		await pause(1000);

		// 焦点放回左屏：点左屏的对话正文
		await click(app, `[data-ly-split-pane="${LEFT}"] textarea`);
		await frames(app, 30);
		await pause(1000);
		await screenshot("01_焦点在左屏");
		const left = await looks();
		console.log("左屏焦点：", JSON.stringify(left));

		await click(app, `[data-ly-split-pane="${RIGHT}"] textarea`);
		await frames(app, 30);
		await pause(1000);
		await screenshot("02_焦点在右屏");
		const right = await looks();
		console.log("右屏焦点：", JSON.stringify(right));

		if (MODE === "after") {
			const lit = (l: Look) => l.content === 1 && l.composer === 1 && l.terminal === 1;
			const dim = (l: Look) => l.content === 0.62 && l.composer === 0.45 && l.terminal === 0.62;
			check("左屏有焦点：左屏内容、输入框、终端都是 1", left[LEFT]?.focused === true && lit(left[LEFT]!), left[LEFT]);
			check("左屏有焦点：右屏内容 0.62、输入框 0.45、终端 0.62", left[RIGHT]?.focused === false && dim(left[RIGHT]!), left[RIGHT]);
			check("左屏有焦点：两屏标题颜色不同", left[LEFT]?.title !== left[RIGHT]?.title, [left[LEFT]?.title, left[RIGHT]?.title]);
			check("点右屏后：右屏全亮", right[RIGHT]?.focused === true && lit(right[RIGHT]!), right[RIGHT]);
			check("点右屏后：左屏淡下去", right[LEFT]?.focused === false && dim(right[LEFT]!), right[LEFT]);
			check("标题颜色跟着焦点换过来", right[RIGHT]?.title === left[LEFT]?.title && right[LEFT]?.title === left[RIGHT]?.title, [right[LEFT]?.title, right[RIGHT]?.title]);
		}

		// 关掉右屏，回到单屏：剩下那一屏不能还淡着
		await click(app, `[data-ly-split-pane="${RIGHT}"] [data-ly-split-close="${RIGHT}"]`);
		await until(app, `document.querySelectorAll('[data-ly-split-pane]').length === 1`, 8000);
		await frames(app, 30);
		await pause(1000);
		await screenshot("03_回到单屏");
		const single = await looks();
		console.log("单屏：", JSON.stringify(single));
		if (MODE === "after") {
			const only = Object.values(single)[0];
			check("回到单屏：内容和输入框都是 1", only?.content === 1 && only.composer === 1, only);
		}
	} finally {
		if (stop) await stop();
		await app.stop();
		await renderer.close();
	}
	const passed = checks.filter((c) => c.ok).length;
	if (recorded.length) await encode(recorded, join(OUT, `${STAMP}_${MODE}_分屏焦点_${passed}of${checks.length}.mp4`), 30, 1200);
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exit(1);
});
