/* oxlint-disable no-console -- 输出真实窗口的动画测量结果 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { click, focus, frames, hover, press, shot, until } from "./drive.ts";
import { encode, frameGrabber, startRecording, type Frame } from "./record.ts";

const PLACES = ["chat", "pull-requests", "scheduled", "plugins", "settings"];
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(/[: ]/g, "-").slice(0, 16);
const button = (place: string) => `[data-ly-rail-item="${place}"]`;
// svg 自身也算：设置图标的旋转加在 svg 上，其余图标加在子元素上。
const parts = (place: string) => `(s=>[s,...s.querySelectorAll('*')])(document.querySelector('${button(place)} svg'))`;
const state = (place: string) => `JSON.stringify(${parts(place)}.map(e=>{
	const s=getComputedStyle(e);return [s.transform,s.opacity,s.strokeDasharray,s.strokeDashoffset];
}))`;
const normal = (place: string) => `${parts(place)}.every(e=>{
	const s=getComputedStyle(e),m=new DOMMatrix(s.transform==='none'?undefined:s.transform);
	return m.isIdentity
		&&Number(s.opacity)===1&&parseFloat(s.strokeDashoffset)===0;
})`;
interface Sample { state: string; box: number[]; elapsed: number }

async function sample(app: RunningApp, place: string, duration = 1600): Promise<Sample[]> {
	return app.evaluate(`new Promise(resolve=>{
		const samples=[],start=performance.now();
		const measure=()=>{
			const boxes=[...document.querySelectorAll('[data-ly-app-rail] button')].flatMap(e=>[e.getBoundingClientRect(),e.querySelector('svg').parentElement.getBoundingClientRect()]);
			samples.push({state:${state(place)},box:boxes.flatMap(r=>[r.x,r.y,r.width,r.height]),elapsed:performance.now()-start});
			if(performance.now()-start>=${duration})resolve(samples);else requestAnimationFrame(measure);
		};requestAnimationFrame(measure);
	})`);
}

test("左侧五个官方动画图标保留布局、导航、键盘与减少动态效果", async () => {
	const app = await startApp({ port: 9898, seed: async (home) => {
		await writeFile(join(home, "settings.json"), JSON.stringify({ providers: [], appearance: { theme: "light" },
			projects: [{ id: "icons", name: "侧边图标测试", path: home, lastOpenedAt: 1 }] }));
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 760 }));
	} });
	const recorded: Frame[] = [];
	const cdp = await frameGrabber(9898);
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	let stopRecording: (() => Promise<void>) | undefined;
	let passed = 0;
	const resting: Record<string, string> = {};
	function check(label: string, ok: boolean, detail: unknown) {
		console.log(`${ok ? "✅" : "❌"} ${label}：${JSON.stringify(detail)}`);
		assert.ok(ok, label);
		passed++;
	}
	try {
		if (directory) stopRecording = await startRecording(9898, recorded);
		await hover(app, "main");
		await frames(app, 60);
		await shot(app, `${STAMP}_01_静止`);
		check("五个入口保留17px图标、1.8描边和32px按钮", await app.evaluate(`${JSON.stringify(PLACES)}.every(place=>{
			const b=document.querySelector('[data-ly-rail-item="'+place+'"]'),s=b.querySelector('svg'),r=s.getBoundingClientRect();
			return r.width===17&&r.height===17&&s.getAttribute('stroke-width')==='1.8'&&b.getBoundingClientRect().width===32;
		})`), "5个入口");
		for (const place of PLACES) {
			const before = (await sample(app, place, 100))[0]!;
			await hover(app, button(place));
			const moving = await sample(app, place);
			check(`${place}官方动画有连续帧变化`, new Set(moving.map((s) => s.state)).size > 1,
				{ frames: moving.length, positions: new Set(moving.map((s) => s.state)).size });
			check(`${place}动画不移动任何按钮与图标容器`, moving.every((s) => s.box.join() === before.box.join()), before.box);
			const held = moving.at(-1)!.state;
			check(`${place}停留时动画结束且不循环`, new Set(moving.slice(-12).map((s) => s.state)).size === 1
				&& (await sample(app, place, 350)).every((s) => s.state === held), held);
			await shot(app, `${STAMP}_悬停_${place}`);
			await hover(app, "main");
			await until(app, normal(place));
			check(`${place}移出恢复原始姿态`, await app.evaluate(normal(place)), "变换归零、描画完整");
			resting[place] = await app.evaluate(state(place));
			await hover(app, button(place));
			check(`${place}再次进入会重播`, new Set((await sample(app, place)).map((s) => s.state)).size > 1, "第二次进入");
			await hover(app, "main");
			await until(app, normal(place));
		}
		for (const setting of ["on", "system"]) {
			await cdp.send("Emulation.setEmulatedMedia", { features: setting === "system" ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [] });
			await app.evaluate(`document.documentElement.dataset.reduceMotion='${setting}'`);
			const changed: Record<string, unknown> = {};
			for (const place of PLACES) {
				await hover(app, button(place));
				const seen = await sample(app, place, 350);
				if (!seen.every((s) => s.state === resting[place])) changed[place] = { expected: resting[place], actual: seen.at(-1)!.state };
				await hover(app, "main");
			}
			check(`${setting}减少动画时五个图标都静止`, Object.keys(changed).length === 0, { checked: PLACES.length, changed });
		}
		await cdp.send("Emulation.setEmulatedMedia", { features: [] });
		await app.evaluate(`document.documentElement.dataset.reduceMotion='off'`);
		let keyboard = true;
		for (const place of PLACES) {
			await focus(app, button(place));
			await press(app, "Tab", 9, 8);
			await press(app, "Tab", 9);
			keyboard &&= await app.evaluate(`document.querySelector('${button(place)}').matches(':focus-visible')`)
				&& (await sample(app, place, 350)).every((s) => s.state === resting[place]);
		}
		check("五个入口键盘聚焦不触发动画", keyboard, "5/5");
		await app.evaluate(`document.activeElement.blur();document.documentElement.classList.add('dark')`);
		let dark = true;
		for (const place of PLACES) {
			await hover(app, button(place));
			dark &&= new Set((await sample(app, place)).map((s) => s.state)).size > 1;
			await hover(app, "main");
			await until(app, normal(place));
		}
		check("深色主题五个动画也正常", dark, "5/5");
		await shot(app, `${STAMP}_02_深色主题`);
		await app.evaluate(`document.documentElement.classList.remove('dark')`);
		for (const place of ["pull-requests", "scheduled", "plugins", "chat"]) {
			await click(app, button(place));
			await until(app, place === "chat" ? "document.querySelector('.ly-new-chat-icon')?.checkVisibility()"
				: `document.querySelector('[data-ly-nav-slot="${place}"]')?.checkVisibility()`);
			check(`${place}点击仍能切换到对应页面`, await app.evaluate(`document.querySelector('${button(place)}').getAttribute('aria-current')==='page'`), "对应侧栏已显示");
			await frames(app, 60);
			await shot(app, `${STAMP}_页面_${place}`);
		}
		for (const [width, height] of [[1200, 440], [380, 760], [380, 440]]) {
			await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await frames(app, 60);
			if (width === 380) {
				if (await app.evaluate(`Boolean(document.querySelector('button[aria-label^="显示侧边栏"]'))`)) await click(app, 'button[aria-label^="显示侧边栏"]');
				await frames(app, 60);
				const layout = await app.evaluate<{ rail: boolean; labels: string[] }>(`({rail:!!document.querySelector('[data-ly-app-rail]')?.checkVisibility(),
					labels:[...document.querySelectorAll('.ly-sidebar-fill button')].filter(b=>b.checkVisibility()).map(b=>b.textContent.trim())})`);
				check(`${width}×${height}仍使用原有抽屉导航`, !layout.rail
					&& ["拉取请求", "定时任务", "插件"].every(label => layout.labels.some(text => text.includes(label))), layout);
			} else {
				check(`${width}×${height}五个按钮仍完整可见`, await app.evaluate(`${JSON.stringify(PLACES)}.every(place=>{
					const b=document.querySelector('[data-ly-rail-item="'+place+'"]'),r=b.getBoundingClientRect();return b.checkVisibility()&&r.top>=0&&r.bottom<=innerHeight;
				})`), "5/5");
			}
			await frames(app, 60);
			await shot(app, `${STAMP}_窗口${width}x${height}`);
		}
	} finally {
		await stopRecording?.();
		cdp.close();
		await app.stop();
		if (directory && recorded.length > 1) await encode(recorded, join(directory, `${STAMP}_侧边图标_${passed}of37.mp4`), 30);
	}
});
