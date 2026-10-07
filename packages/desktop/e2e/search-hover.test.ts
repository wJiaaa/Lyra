/* oxlint-disable no-console -- 输出真实窗口的测量结果 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, press, shot, type as typeText, until } from "./drive.ts";
import { encode, frameGrabber, startRecording, type Frame } from "./record.ts";
import { fixtureStore } from "./session-fixture.ts";

const BUTTON = 'button[aria-label="搜索会话"]';
const INPUT = 'input[placeholder="搜索会话…"]';
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);

interface Sample {
	transform: string;
	elapsed: number;
	icon: number[];
	box: number[];
	hovered: boolean;
}

// 量屏幕上的图标、按钮和相邻标题，不读取组件状态。
async function sample(app: RunningApp): Promise<Sample[]> {
	return app.evaluate(`new Promise(resolve=>{
		const samples=[],start=performance.now();
		const measure=()=>{
			const button=document.querySelector('${BUTTON}'),icon=button.querySelector('svg');
			const head=button.closest('.ly-sidebar-head');
			const boxes=[button,head.querySelector('span'),head.querySelector('[data-ly-notifications-button]')].map(e=>e.getBoundingClientRect());
			const r=icon.getBoundingClientRect();
			samples.push({transform:getComputedStyle(icon).transform,elapsed:performance.now()-start,icon:[r.x,r.y,r.width,r.height],
				box:boxes.flatMap(r=>[r.x,r.y,r.width,r.height]),hovered:button.matches(':hover')});
			if(performance.now()-start>=1200)resolve(samples);else requestAnimationFrame(measure);
		};requestAnimationFrame(measure);
	})`);
}

test("lucide-animated 搜索悬停只播放一次，搜索功能、布局与减少动画保持正确", async () => {
	const app = await startApp({
		port: 9897,
		seed: async (home) => {
			const store = fixtureStore(home);
			let projectId: string;
			try {
				const first = await store.create(home, "fake/model", "搜索动画目标");
				projectId = first.projectId;
				const second = await store.create(home, "fake/model", "另一个会话");
				for (const meta of [first, second]) {
					await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "会话测试内容" }], timestamp: Date.now() } });
				}
			} finally { store.close(); }
			await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [],
				projects: [{ id: projectId, name: "搜索图标测试", path: home, lastOpenedAt: 1 }], appearance: { theme: "light" } }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760 }));
		},
	});
	const recording: Frame[] = [];
	const cdp = await frameGrabber(9897);
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	let stopRecording: (() => Promise<void>) | undefined;
	let passed = 0;
	function check(label: string, ok: boolean, detail: unknown) {
		console.log(`${ok ? "✅" : "❌"} ${label}：${JSON.stringify(detail)}`);
		assert.ok(ok, label);
		passed++;
	}
	try {
		if (directory) stopRecording = await startRecording(9897, recording);
		await hover(app, "main");
		await frames(app, 60);
		await shot(app, `${STAMP}_01_静止`);
		const before = (await sample(app))[0]!;
		check("静止图标保留15px尺寸与1.9描边", before.transform === "none" && before.icon[2] === 15 && before.icon[3] === 15
			&& await app.evaluate(`document.querySelector('${BUTTON} svg').getAttribute('stroke-width')==='1.9'`), before);
		await hover(app, BUTTON);
		const moving = await sample(app);
		const lastMotion = moving.findLast((s) => s.transform !== "none")?.elapsed ?? 0;
		check("悬停按官方1秒时长移动", new Set(moving.map((s) => s.transform)).size > 1 && lastMotion > 850 && lastMotion < 1150,
			{ frames: moving.length, positions: new Set(moving.map((s) => s.transform)).size, lastMotion });
		check("按钮、标题与通知图标保持原位", moving.every((s) => s.box.join() === before.box.join()), before.box);
		check("一次动画结束回到原位", moving.slice(-10).every((s) => s.transform === "none" && s.icon.join() === before.icon.join()), moving.at(-1));
		check("持续悬停不会循环", (await sample(app)).every((s) => s.transform === "none" && s.hovered), "连续1200ms静止");
		await hover(app, "main");
		await frames(app, 60);
		await hover(app, BUTTON);
		check("再次进入会重播", new Set((await sample(app)).map((s) => s.transform)).size > 1, "第二次悬停");
		await shot(app, `${STAMP}_02_悬停`);
		await hover(app, "main");
		await frames(app, 60);
		await app.evaluate(`document.documentElement.dataset.reduceMotion='on'`);
		await hover(app, BUTTON);
		check("应用减少动画时静止", (await sample(app)).every((s) => s.transform === "none"), "on");
		await hover(app, "main");
		await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='system'`);
		await hover(app, BUTTON);
		check("跟随系统减少动画时静止", (await sample(app)).every((s) => s.transform === "none"), "system + reduce");
		await cdp.send("Emulation.setEmulatedMedia", { features: [] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='off'`);
		await hover(app, "main");
		await app.evaluate(`document.querySelector('${BUTTON}').focus()`);
		await press(app, "Tab", 9, 8);
		await press(app, "Tab", 9);
		check("键盘聚焦不播放动画", await app.evaluate(`document.querySelector('${BUTTON}').matches(':focus-visible')`)
			&& (await sample(app)).every((s) => s.transform === "none"), "Shift+Tab、Tab");
		await app.evaluate(`document.activeElement.blur();document.documentElement.classList.add('dark')`);
		await hover(app, BUTTON);
		check("深色主题也能播放", new Set((await sample(app)).map((s) => s.transform)).size > 1, "dark");
		await shot(app, `${STAMP}_03_深色主题`);
		await app.evaluate(`document.documentElement.classList.remove('dark')`);
		await click(app, BUTTON);
		await until(app, `document.querySelector('${INPUT}')===document.activeElement`);
		check("点击打开搜索并聚焦输入框", await app.evaluate(`document.querySelector('${BUTTON}').getAttribute('aria-pressed')==='true'`), "输入框已聚焦");
		await typeText(app, INPUT, "搜索动画目标");
		await until(app, `document.querySelectorAll('[data-ly-row]').length===1`);
		check("输入仍可筛选会话", await app.evaluate(`document.querySelector('[data-ly-row]').innerText.includes('搜索动画目标')`), "仅目标会话可见");
		await shot(app, `${STAMP}_04_搜索结果`);
		await press(app, "Escape", 27);
		await until(app, `document.querySelector('${INPUT}')?.value===''&&document.querySelectorAll('[data-ly-row]').length===2`);
		const cleared = await app.evaluate(`document.querySelector('${BUTTON}').getAttribute('aria-pressed')==='true'`);
		await press(app, "Escape", 27);
		await until(app, `!document.querySelector('${INPUT}')&&document.querySelectorAll('[data-ly-row]').length===2`);
		check("Escape先清空筛选，再关闭搜索", cleared && await app.evaluate(`document.querySelector('${BUTTON}').getAttribute('aria-pressed')==='false'`), "两条会话恢复");
		await click(app, BUTTON);
		await until(app, `document.querySelector('${INPUT}')===document.activeElement`);
		await click(app, BUTTON);
		check("再次点击可关闭搜索", await app.evaluate(`!document.querySelector('${INPUT}')`), "开关行为保持");
		for (const [width, height] of [[1200, 440], [380, 760], [380, 440]]) {
			await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await frames(app);
			if (await app.evaluate(`Boolean(document.querySelector('button[aria-label^="显示侧边栏"]'))`)) await click(app, 'button[aria-label^="显示侧边栏"]');
			await frames(app, 60);
			await hover(app, 'button:has(.ly-new-chat-icon)');
			const still = (await sample(app))[0]!;
			await hover(app, BUTTON);
			const compact = await sample(app);
			check(`${width}×${height}反馈正常且布局稳定`, new Set(compact.map((s) => s.transform)).size > 1
				&& compact.every((s) => s.box.join() === still.box.join()), still.box);
			await shot(app, `${STAMP}_窗口${width}x${height}`);
		}
	} finally {
		await stopRecording?.();
		cdp.close();
		await app.stop();
		if (directory && recording.length > 1) await encode(recording, join(directory, `${STAMP}_搜索悬停_${passed}of17.mp4`), 30);
	}
});
