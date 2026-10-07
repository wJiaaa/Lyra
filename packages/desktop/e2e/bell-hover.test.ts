/* oxlint-disable no-console -- 输出真实窗口的测量结果 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, focus, frames, hover, press, shot, until } from "./drive.ts";
import { encode, frameGrabber, startRecording, type Frame } from "./record.ts";

const BELL = "[data-ly-notifications-button]";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);

interface Sample {
	transform: string;
	elapsed: number;
	icon: number[];
	box: number[];
}

// 量屏幕上的图标、铃铛按钮、搜索按钮和标题，不读取组件状态。
async function sample(app: RunningApp, duration = 900): Promise<Sample[]> {
	return app.evaluate(`new Promise(resolve=>{
		const samples=[],start=performance.now();
		const measure=()=>{
			const button=document.querySelector('${BELL}'),icon=button.querySelector('svg'),head=button.closest('.ly-sidebar-head');
			const boxes=[button,head.querySelector('span'),head.querySelector('button[aria-label="搜索会话"]')].map(e=>e.getBoundingClientRect());
			const r=icon.getBoundingClientRect();
			samples.push({transform:getComputedStyle(icon).transform,elapsed:performance.now()-start,icon:[r.width,r.height],
				box:boxes.flatMap(r=>[r.x,r.y,r.width,r.height])});
			if(performance.now()-start>=${duration})resolve(samples);else requestAnimationFrame(measure);
		};requestAnimationFrame(measure);
	})`);
}

const still = (samples: Sample[], resting: string) => samples.every((s) => s.transform === resting);

test("lucide-animated 铃铛悬停摇一次，通知菜单、布局与减少动画保持正确", async () => {
	const app = await startApp({
		port: 9896,
		seed: async (home) => {
			await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [], appearance: { theme: "light" },
				projects: [{ id: "bell", name: "铃铛图标测试", path: home, lastOpenedAt: 1 }] }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760 }));
		},
	});
	const recording: Frame[] = [];
	const cdp = await frameGrabber(9896);
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	let stopRecording: (() => Promise<void>) | undefined;
	let passed = 0;
	function check(label: string, ok: boolean, detail: unknown) {
		console.log(`${ok ? "✅" : "❌"} ${label}：${JSON.stringify(detail)}`);
		assert.ok(ok, label);
		passed++;
	}
	try {
		if (directory) stopRecording = await startRecording(9896, recording);
		await hover(app, "main");
		await frames(app, 60);
		await shot(app, `${STAMP}_01_静止`);
		const before = (await sample(app, 100))[0]!;
		const resting = before.transform;
		check("静止图标保留15px尺寸与1.9描边", before.icon.join() === "15,15"
			&& await app.evaluate(`document.querySelector('${BELL} svg').getAttribute('stroke-width')==='1.9'`), before);
		await hover(app, BELL);
		const moving = await sample(app);
		const lastMotion = moving.findLast((s) => s.transform !== resting)?.elapsed ?? 0;
		check("悬停按官方0.5秒摇动", new Set(moving.map((s) => s.transform)).size > 2 && lastMotion > 350 && lastMotion < 650,
			{ frames: moving.length, positions: new Set(moving.map((s) => s.transform)).size, lastMotion });
		check("按钮、标题与搜索图标保持原位", moving.every((s) => s.box.join() === before.box.join()), before.box);
		check("持续悬停不会循环", still(await sample(app), resting), "连续900ms静止");
		await hover(app, "main");
		await frames(app, 30);
		await hover(app, BELL);
		check("再次进入会重播", new Set((await sample(app)).map((s) => s.transform)).size > 1, "第二次悬停");
		await shot(app, `${STAMP}_02_悬停`);
		await hover(app, "main");
		await app.evaluate(`document.documentElement.dataset.reduceMotion='on'`);
		await hover(app, BELL);
		check("应用减少动画时静止", still(await sample(app), resting), "on");
		await hover(app, "main");
		await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='system'`);
		await hover(app, BELL);
		check("跟随系统减少动画时静止", still(await sample(app), resting), "system + reduce");
		await cdp.send("Emulation.setEmulatedMedia", { features: [] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='off'`);
		await hover(app, "main");
		await focus(app, BELL);
		await press(app, "Tab", 9, 8);
		await press(app, "Tab", 9);
		check("键盘聚焦不播放动画", await app.evaluate(`document.querySelector('${BELL}').matches(':focus-visible')`)
			&& still(await sample(app), resting), "Shift+Tab、Tab");
		await app.evaluate(`document.activeElement.blur();document.documentElement.classList.add('dark')`);
		await hover(app, BELL);
		check("深色主题也能播放", new Set((await sample(app)).map((s) => s.transform)).size > 1, "dark");
		await shot(app, `${STAMP}_03_深色主题`);
		await app.evaluate(`document.documentElement.classList.remove('dark')`);
		await click(app, BELL);
		await until(app, `document.querySelector('${BELL}').getAttribute('aria-expanded')==='true'`);
		await frames(app, 30);
		check("点击仍能打开通知菜单", await app.evaluate(`!!document.querySelector('[role="menu"]')?.checkVisibility()`), "菜单可见");
		await shot(app, `${STAMP}_04_通知菜单`);
		await press(app, "Escape", 27);
		await until(app, `document.querySelector('${BELL}').getAttribute('aria-expanded')==='false'`);
		check("Escape 关闭通知菜单", await app.evaluate(`!document.querySelector('[role="menu"]')`), "菜单已关闭");
		// Escape 把焦点以 :focus-visible 还给铃铛，那时悬停本就不该播；后面量的是指针悬停。
		await app.evaluate(`document.activeElement.blur()`);
		for (const [width, height] of [[1200, 440], [380, 760]]) {
			await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await frames(app);
			if (await app.evaluate(`Boolean(document.querySelector('button[aria-label^="显示侧边栏"]'))`)) await click(app, 'button[aria-label^="显示侧边栏"]');
			await frames(app, 60);
			await hover(app, "button:has(.ly-new-chat-icon)");
			const rest = (await sample(app, 100))[0]!;
			await hover(app, BELL);
			const compact = await sample(app);
			check(`${width}×${height}反馈正常且布局稳定`, new Set(compact.map((s) => s.transform)).size > 1
				&& compact.every((s) => s.box.join() === rest.box.join()),
				{ positions: new Set(compact.map((s) => s.transform)).size, box: rest.box });
			await shot(app, `${STAMP}_窗口${width}x${height}`);
		}
	} finally {
		await stopRecording?.();
		cdp.close();
		await app.stop();
		if (directory && recording.length > 1) await encode(recording, join(directory, `${STAMP}_铃铛悬停_${passed}of13.mp4`), 30);
	}
});
