/* oxlint-disable no-console -- 输出真实窗口的测量结果 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, openSession, press, shot, until } from "./drive.ts";
import { encode, frameGrabber, startRecording, type Frame } from "./record.ts";
import { fixtureStore } from "./session-fixture.ts";

const ICON = "svg.ly-new-chat-icon";
const BUTTON = `button:has(${ICON})`;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);

interface Sample {
	pen: string;
	frame: string;
	box: number[];
	hovered: boolean;
}

// 从画在窗口里的 SVG 和文字取数，不读取组件状态。
async function sample(app: RunningApp): Promise<Sample[]> {
	return app.evaluate(`new Promise(resolve=>{
		const samples=[],start=performance.now();
		const measure=()=>{
			const icon=document.querySelector('${ICON}'),button=icon.closest('button');
			const label=[...button.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());
			const range=document.createRange();range.selectNode(label);
			const boxes=[button.getBoundingClientRect(),icon.getBoundingClientRect(),range.getBoundingClientRect()];
			samples.push({pen:getComputedStyle(icon.lastElementChild).transform,frame:getComputedStyle(icon.firstElementChild).transform,hovered:button.matches(':hover'),
				box:boxes.flatMap(r=>[r.x,r.y,r.width,r.height])});
			if(performance.now()-start>=600)resolve(samples);else requestAnimationFrame(measure);
		};requestAnimationFrame(measure);
	})`);
}

test("lucide-animated 新对话悬停只动笔一次，布局、键盘、减少动画与点击行为保持正确", async () => {
	let sessionId = "";
	const app = await startApp({
		port: 9896,
		seed: async (home) => {
			const store = fixtureStore(home);
			let projectId: string;
			try {
				const meta = await store.create(home, "fake/model", "悬停验证旧对话");
				sessionId = meta.id;
				projectId = meta.projectId;
				await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "旧对话内容" }], timestamp: Date.now() } });
			} finally { store.close(); }
			await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [],
				projects: [{ id: projectId, name: "图标测试", path: home, lastOpenedAt: 1 }], appearance: { theme: "light" } }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760 }));
		},
	});
	const recording: Frame[] = [];
	// 媒体和窗口尺寸模拟属于 CDP 会话，连接关掉就失效。
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
		await shot(app, `${STAMP}_02_改动后静止`);
		const before = (await sample(app))[0]!;
		check("静止时笔和方框不动", before.pen === "none" && before.frame === "none", before);
		check("只标记截图中的一个入口", await app.evaluate(`document.querySelectorAll('${ICON}').length===1`), 1);

		await hover(app, BUTTON);
		const moving = await sample(app);
		check("悬停时笔确实运动", new Set(moving.map((s) => s.pen)).size > 1, { sampled: moving.length, positions: new Set(moving.map((s) => s.pen)).size });
		check("方框、文字与点击区域全程不移位", moving.every((s) => s.frame === "none" && s.box.join() === before.box.join()), before.box);
		const held = moving.at(-1)!.pen;
		check("停留时一次动画已经结束", new Set(moving.slice(-10).map((s) => s.pen)).size === 1, {
			last: moving.at(-1), positionsInLast10Frames: new Set(moving.slice(-10).map((s) => s.pen)).size,
		});
		await frames(app, 60);
		const resting = await sample(app);
		check("停留不会循环", resting.every((s) => s.pen === held), {
			held, transforms: [...new Set(resting.map((s) => s.pen))],
			hovered: await app.evaluate(`document.querySelector('${BUTTON}').matches(':hover')`),
		});
		await hover(app, "main");
		await frames(app, 60);
		const reset = await app.evaluate(`getComputedStyle(document.querySelector('${ICON}').lastElementChild).transform`);
		await hover(app, BUTTON);
		check("移出复位，再次进入会重播", reset === "none" && new Set((await sample(app)).map((s) => s.pen)).size > 1, { reset, replay: "第二次悬停" });
		await shot(app, `${STAMP}_03_改动后悬停`);
		await frames(app, 60);

		await hover(app, "main");
		await frames(app, 60);
		await app.evaluate(`document.documentElement.dataset.reduceMotion='on'`);
		await hover(app, BUTTON);
		check("减少动态效果时静止", (await sample(app)).every((s) => s.pen === "none"), "应用设置：on");
		await hover(app, "main");
		await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
		await frames(app, 2);
		await app.evaluate(`document.documentElement.dataset.reduceMotion='system'`);
		await hover(app, BUTTON);
		check("跟随系统减少动画时静止", (await sample(app)).every((s) => s.pen === "none"),
			await cdp.evaluate(`({setting:document.documentElement.dataset.reduceMotion,media:matchMedia('(prefers-reduced-motion:reduce)').matches,duration:getComputedStyle(document.querySelector('${ICON}').lastElementChild).animationDuration})`));
		await cdp.send("Emulation.setEmulatedMedia", { features: [] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='off'`);
		await hover(app, "main");
		await app.evaluate(`document.querySelector('${BUTTON}').focus()`);
		await press(app, "Tab", 9, 8);
		await press(app, "Tab", 9);
		check("键盘聚焦保留且不播放动画", await app.evaluate(`document.querySelector('${BUTTON}').matches(':focus-visible')`)
			&& (await sample(app)).every((s) => s.pen === "none"), "Shift+Tab、Tab");

		await app.evaluate(`document.activeElement.blur();document.documentElement.classList.add('dark')`);
		await hover(app, BUTTON);
		check("深色主题也能播放", new Set((await sample(app)).map((s) => s.pen)).size > 1, "dark");
		await frames(app, 60);
		await shot(app, `${STAMP}_04_深色主题`);
		await app.evaluate(`document.documentElement.classList.remove('dark')`);
		await openSession(app, sessionId);
		await until(app, "document.querySelector('main').innerText.includes('旧对话内容')");
		await click(app, BUTTON);
		await until(app, "!document.querySelector('main').innerText.includes('旧对话内容')");
		check("点击仍能开始新对话", await app.evaluate(`document.querySelector('.ly-composer-dock textarea').checkVisibility()`), "旧对话内容清空，新对话输入框可见");
		await frames(app, 60);

		for (const [width, height] of [[1200, 440], [380, 760], [380, 440]]) {
			await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await frames(app);
			if (await app.evaluate(`Boolean(document.querySelector('button[aria-label^="显示侧边栏"]'))`)) {
				await click(app, 'button[aria-label^="显示侧边栏"]');
			}
			await frames(app, 60);
			await hover(app, 'button[aria-label="搜索会话"]');
			const still = (await sample(app))[0]!;
			await hover(app, BUTTON);
			const compact = await sample(app);
			check(`${width}×${height}窗口仍有反馈且布局稳定`, new Set(compact.map((s) => s.pen)).size > 1
				&& compact.every((s) => s.frame === "none" && s.box.join() === still.box.join()), still.box);
			await shot(app, `${STAMP}_窗口${width}x${height}`);
		}
	} finally {
		await stopRecording?.();
		cdp.close();
		await app.stop();
		if (directory && recording.length > 1) await encode(recording, join(directory, `${STAMP}_新对话悬停_${passed}of15.mp4`), 30);
	}
});
