import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { frames, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";

let app: RunningApp;
const pane = '[data-dock-pane="review"]';
// 单屏时这一栏的按钮在窗口顶栏里，见 `ToolbarPanelBar`。
const button = '[data-ly-toolbar-panel] button[aria-label*="全屏"]';
before(async () => {
	app = await startApp({ port: 9653, seed: seedInteractions });
	await until(app, `document.querySelector('[data-ly-row="qa-short"] > button')`);
	await app.evaluate(`document.querySelector('[data-ly-row="qa-short"] > button').click()`);
});
after(async () => { await app?.stop(); });

interface ButtonFrame {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface Evidence {
	frames: (ButtonFrame | null)[];
	clicks: (string | null)[];
	retained: boolean;
	finalLabel: string | null;
}

test("rapid fullscreen clicks keep the button sized and anchored, and never close the panel", async (t) => {
	const failures: string[] = [];
	for (const theme of ["light", "dark"]) for (const width of [1200, 1100]) {
		await app.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
		await app.evaluate(`(async()=>{const s=await window.plume.settings.get();await window.plume.settings.save({...s,appearance:{...s.appearance,theme:${JSON.stringify(theme)},reduceMotion:'off'}})})()`);
		await until(app, `document.documentElement.classList.contains(${JSON.stringify(theme)})`);
		if (!await app.evaluate(`Boolean(document.querySelector('${pane}'))`)) {
			await until(app, `document.querySelector('button[aria-label^="Git "]')`);
			await app.evaluate(`document.querySelector('button[aria-label^="Git "]').click()`);
		}
		await until(app, `document.querySelector('${button}')`);
		await until(app, `document.querySelector('${pane} [data-view="changes"]')`);
		await frames(app, 30);
		const point = await app.evaluate<{ x: number; y: number }>(`(()=>{const e=document.querySelector('${button}'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
		await app.evaluate(`(()=>{
			const pane=document.querySelector('${pane}'),original=pane.querySelector('[data-view="changes"]');
			const trace=window.__headerTrace={active:true,frames:[],clicks:[],pane,original};
			function tick(){const r=document.querySelector('${button}')?.getBoundingClientRect();trace.frames.push(r?{x:r.x,y:r.y,width:r.width,height:r.height}:null);if(trace.active)requestAnimationFrame(tick)}requestAnimationFrame(tick);
			trace.listener=e=>trace.clicks.push(e.target.closest('button')?.getAttribute('aria-label')??null);
			document.addEventListener('click',trace.listener,true);
		})()`);
		// Deliberately reuse the initial position while animations are still running, as a person does.
		for (let i = 0; i < 8; i++) {
			await app.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
			await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
			await frames(app, 2);
		}
		await frames(app, 30);
		const evidence = await app.evaluate<Evidence>(`(()=>{const trace=window.__headerTrace;trace.active=false;document.removeEventListener('click',trace.listener,true);return {frames:trace.frames,clicks:trace.clicks,retained:trace.pane===document.querySelector('${pane}')&&trace.original?.isConnected,finalLabel:document.querySelector('${button}')?.getAttribute('aria-label')??null}})()`);
		const visible = evidence.frames.filter((frame) => frame !== null);
		const xRange = visible.length ? Math.max(...visible.map((frame) => frame.x)) - Math.min(...visible.map((frame) => frame.x)) : Infinity;
		t.diagnostic(JSON.stringify({ theme, width, clicks: evidence.clicks, frames: visible.length, xRange }));
		if (evidence.frames.some((frame) => frame === null)) failures.push(`${theme}/${width}: the fullscreen button went away mid-sequence`);
		if (!evidence.retained || evidence.finalLabel !== "全屏：Git") failures.push(`${theme}/${width}: content or final state was lost`);
		if (evidence.clicks.length !== 8 || evidence.clicks.some((label, i) => label !== (i % 2 ? "退出全屏：Git" : "全屏：Git"))) failures.push(`${theme}/${width}: a native click missed its fullscreen control`);
		if (xRange > 0.5 || visible.some((frame) => Math.abs(frame.width - visible[0]!.width) > 0.5 || Math.abs(frame.height - visible[0]!.height) > 0.5)) failures.push(`${theme}/${width}: the button moved or changed size while it was being clicked`);
		if (process.env.PLUME_E2E_ARTIFACTS) {
			await mkdir(process.env.PLUME_E2E_ARTIFACTS, { recursive: true });
			await writeFile(join(process.env.PLUME_E2E_ARTIFACTS, `native-header-${theme}-${width}.json`), JSON.stringify(evidence, null, 2));
			const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(process.env.PLUME_E2E_ARTIFACTS, `native-header-${theme}-${width}.png`), Buffer.from(shot.data, "base64"));
		}
	}
	assert.deepEqual(failures, [], failures.join("\n"));
});

test("a window resize finishes the visual flight before taking over pane geometry", async (t) => {
	const size = await app.evaluate<{ width: number; height: number }>(`(()=>{const r=document.querySelector('${button}').getBoundingClientRect();return {width:r.width,height:r.height}})()`);
	const started = await app.evaluate<boolean>(`(async()=>{
		const pane=document.querySelector('${pane}'),surface=pane.querySelector('[data-dock-motion]');
		document.querySelector('${button}').click();
		await new Promise(requestAnimationFrame);
		return surface.getAnimations().some(a=>a.id==='ly-dock-geometry'&&a.playState==='running');
	})()`);
	assert.equal(started, true, "the resize interrupts an actual in-flight animation");
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1160, height: 820, deviceScaleFactor: 1, mobile: false });
	await frames(app, 2);
	const state = await app.evaluate<{ active: number; width: number; height: number; retained: boolean }>(`(()=>{
		const pane=document.querySelector('${pane}'),r=document.querySelector('${button}').getBoundingClientRect();
		return {active:pane.getAnimations({subtree:true}).filter(a=>a.id==='ly-dock-geometry'&&a.playState==='running').length,width:r.width,height:r.height,retained:!!pane.querySelector('[data-view="changes"]')};
	})()`);
	t.diagnostic(JSON.stringify(state));
	assert.deepEqual(state, { active: 0, ...size, retained: true });
});
