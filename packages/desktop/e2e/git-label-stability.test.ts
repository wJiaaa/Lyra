import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";

let app: RunningApp;
before(async () => {
	app = await startApp({ port: 9641, seed: async (home) => {
		await seedInteractions(home);
		await promisify(execFile)("git", ["worktree", "add", "-qb", "codex/fix-cdp-promise-lifetime", join(home, "plume-cdp-promise-lifetime")], { cwd: join(home, "project") });
	} });
});
after(async () => { await app?.stop(); });
async function until(expression: string) {
	await app.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+10000;function tick(){if(${expression})resolve();else if(performance.now()<end)requestAnimationFrame(tick);else reject(new Error(${JSON.stringify(expression)}));}tick();})`);
}

test("checkout label and branch widths settle without a resize feedback loop", async (t) => {
	await until(`document.querySelector('[data-ly-row="qa-long"]')`);
	await app.evaluate(`document.querySelector('[data-ly-row="qa-long"] > button').click()`);
	await until(`document.querySelector('main textarea')`);
	await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'r',code:'KeyR',metaKey:true,shiftKey:true,bubbles:true}))`);
	await until(`document.querySelector('[data-dock-pane="review"] [aria-label="分支"]')`);
	await app.evaluate(`document.querySelector('[data-dock-pane="review"] [aria-label="分支"]').click()`);
	await until(`[...document.querySelectorAll('[data-dock-pane="review"] button')].some(e=>e.dataset.lyTip?.endsWith('plume-cdp-promise-lifetime'))`);
	const samples = await app.evaluate<number[][]>(`new Promise(resolve=>{const row=[...document.querySelectorAll('[data-dock-pane="review"] button')].find(e=>e.dataset.lyTip?.endsWith('plume-cdp-promise-lifetime'));const result=[];const end=performance.now()+1500;function tick(){result.push([...row.children].map(e=>e.getBoundingClientRect().width));if(performance.now()<end)requestAnimationFrame(tick);else resolve(result);}requestAnimationFrame(tick);})`);
	const stable = samples.slice(10);
	assert.ok(stable.length > 10);
	const ranges = stable[0].map((_, i) => Math.max(...stable.map(s => s[i])) - Math.min(...stable.map(s => s[i])));
	t.diagnostic(JSON.stringify({ frames: stable.length, ranges }));
	assert.ok(ranges.every(range => range < 1), `column widths oscillate: ${ranges}`);
});

test("Git tabs own their toolbar actions without duplicate refresh or extra action rows", async (t) => {
	for (const name of ["流水线", "分支", "历史", "改动", "流水线"]) {
		const label = name;
		await app.evaluate(`(()=>{const button=[...document.querySelectorAll('[data-dock-pane="review"] button')].find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)throw Error('Missing tab: '+${JSON.stringify(label)});button.click()})()`);
		await until(`document.querySelector('[data-dock-pane="review"] [data-git-tab-actions]')?.dataset.gitTabActions === ${JSON.stringify(name === "流水线" ? "pipelines" : name === "分支" ? "branches" : name === "历史" ? "history" : "changes")}`);
		const labels = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-dock-pane="review"] button')].filter(e=>e.checkVisibility()&&e.getAttribute('aria-label')?.includes('刷新')).map(e=>e.getAttribute('aria-label'))`);
		t.diagnostic(JSON.stringify({ tab: label, refresh: labels }));
		assert.equal(labels.length, 1);
		if (name === "流水线") assert.equal(labels[0], "刷新流水线");
	}
});

test("question excerpts use bounded ellipsis without a text mask or separator", async (t) => {
	await app.evaluate(`document.querySelector('[data-dock-pane="review"] [aria-label="关闭Git"]').click()`);
	await until(`document.querySelector('.ly-question-mark')`);
	const point = await app.evaluate<{ x: number; y: number }>(`(()=>{const e=document.querySelector('.ly-question-mark'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	await until(`document.querySelector('.ly-question-preview[data-open="true"] .ly-question-excerpt')`);
	const metrics = await app.evaluate<{ mask: string; clamp: string; height: number; lineHeight: number; separators: number }>(`(()=>{const e=document.querySelector('.ly-question-excerpt'),s=getComputedStyle(e);return {mask:s.maskImage,clamp:s.webkitLineClamp,height:e.getBoundingClientRect().height,lineHeight:parseFloat(s.lineHeight),separators:document.querySelectorAll('.ly-question-preview hr').length}})()`);
	t.diagnostic(JSON.stringify(metrics)); assert.equal(metrics.mask, "none"); assert.equal(metrics.clamp, "3"); assert.equal(metrics.separators, 0); assert.ok(metrics.height <= metrics.lineHeight * 3 + 1);
});
