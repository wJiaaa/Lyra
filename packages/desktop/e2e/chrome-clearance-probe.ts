/* oxlint-disable no-console -- 探针的输出就是它的全部产物 */
/**
 * 三处「东西没长在该在的位置」的量法。
 *
 *   1. 面板全屏之后，它的标题/标签有没有跑到 macOS 交通灯底下；
 *   2. 菜单出滚动条时，行的右边缘和滚动条之间空了多少；
 *   3. 最窄宽度下，转录区是不是真的居中。
 *
 * 只跑不断言：改之前跑一遍当基线，改之后再跑一遍对照。
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";

const OUT = process.env.PLUME_E2E_ARTIFACTS ?? join(process.cwd(), "test-results", "chrome-clearance");

let app: RunningApp;

async function main() {
	app = await startApp({
		port: 9673,
		seed: async (home) => {
			await seedInteractions(home);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			// 够多的模型，菜单才会真的出滚动条——右侧那条让位只有出了滚动条才画。
			const models = Array.from({ length: 24 }, (_, i) => ({ id: `bulk/model-${i}`, providerId: "bulk", modelId: `model-${i}`, name: `模型 ${i} · 名字长一点好看出右边界`, contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }));
			await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off", defaultModelId: "bulk/model-0",
				providers: [...(settings.providers ?? []), { id: "bulk", name: "很多模型", api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "test", enabled: true, models }] }));
		},
	});
	await mkdir(OUT, { recursive: true });
	await click('[data-ly-row="qa-short"] > button');
	await until(`document.querySelector('.ly-transcript')`);

	console.log("=== 1. 面板全屏后，标题有没有压在交通灯下 ===");
	console.log("侧边栏开着（这时角落归侧边栏管）：");
	for (const pane of ["终端", "文件"]) {
		await openPane(pane);
	}
	await frames();
	// 关掉侧边栏，角落才轮到面板自己让位。
	await app.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/侧边栏|边栏/.test(e.getAttribute('aria-label')||''));if(!b)throw Error('找不到侧边栏开关：'+[...document.querySelectorAll('button[aria-label]')].map(e=>e.getAttribute('aria-label')).slice(0,12).join(' | '));b.click()})()`);
	await frames(30);
	console.log("侧边栏关掉后：", JSON.stringify(await clearance(), null, 1));

	for (const kind of ["terminal", "files", "conversation"]) {
		const toggled = await app.evaluate<string>(
			`(()=>{const p=document.querySelector('[data-dock-pane="${kind}"]');if(!p)return '（没有这个面板）';const b=p.querySelector('button[aria-label^="全屏"]');if(!b)return '（没有全屏按钮）';b.click();return '已全屏'})()`,
		);
		if (toggled !== "已全屏") { console.log(`${kind}：${toggled}`); continue; }
		await frames(30);
		console.log(`\n${kind} 全屏后：`, JSON.stringify(await clearance(), null, 1));
		await shot(`fullscreen-${kind}`);
		await app.evaluate(`(()=>{const b=document.querySelector('[data-dock-pane="${kind}"] button[aria-label^="退出全屏"]');if(b)b.click()})()`);
		await frames(30);
	}

	console.log("\n=== 2. 菜单的滚动条与行的右边缘 ===");
	// 压矮窗口，菜单才会真的出滚动条——20px 的让位只有那时才画出来。
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 460, deviceScaleFactor: 1, mobile: false });
	await frames(20);
	await app.evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>/模型/.test(e.getAttribute('data-ly-tip')||e.getAttribute('aria-label')||''));if(!b)throw Error('找不到模型按钮');b.click()})()`);
	await until(`document.querySelector('[data-ly-popover] .ly-scroll-view')`);
	await frames(20);
	console.log(JSON.stringify(await menuGutter(), null, 1));
	await shot("model-menu");
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
	await frames(20);

	// 900 不是窄窗口，但这时终端和文件面板还开着，对话列本身是窄的——量的是列，不是窗口。
	console.log("\n=== 3. 转录区居不居中（量的是这一列的宽度）===");
	for (const width of [380, 460, 900, 1400]) {
		await app.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
		await frames(30);
		console.log(`${width}px：`, JSON.stringify(await centred()));
		await shot(`narrow-${width}`);
	}
	await app.send("Emulation.clearDeviceMetricsOverride");

	console.log("\n产物：", OUT);
}

/** 每个可见面板的标题离窗口左边缘多远，够不够躲开系统按钮。 */
async function clearance() {
	return app.evaluate(
		`(()=>{const toggle=[...document.querySelectorAll('button')].find(e=>/侧边栏|边栏/.test(e.getAttribute('aria-label')||''));
		const bar=toggle?toggle.getBoundingClientRect():null;const reserved=bar?Math.round(bar.right+10):null;
		const out={系统按钮到:reserved};
		for(const header of document.querySelectorAll('[data-dock-header]')){const pane=header.dataset.dockHeader;const box=header.getBoundingClientRect();
			if(box.top>60||box.width<40)continue;
			const first=[...header.querySelectorAll('[data-dock-heading] *')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0).sort((a,b)=>a.left-b.left)[0];
			out[pane]={左padding:Math.round(parseFloat(getComputedStyle(header).paddingLeft)),标题从:first?Math.round(first.left):null,
			 结论:!reserved?'（没有系统按钮）':!first?'（标题为空）':first.left+0.5>=reserved?'躲开了':'压在系统按钮下 '+Math.round(reserved-first.left)+'px'}}
		return out})()`,
	);
}

/** 行的右边缘、滚动条、菜单右边缘三者的距离。 */
async function menuGutter() {
	return app.evaluate(
		`(()=>{const pop=document.querySelector('[data-ly-popover]'),p=pop.getBoundingClientRect();
		const thumb=pop.querySelector('.ly-thumb'),t=thumb?thumb.getBoundingClientRect():null;
		const item=[...pop.querySelectorAll('.ly-item')].map(e=>e.getBoundingClientRect()).sort((a,b)=>b.width-a.width)[0];
		const text=[...pop.querySelectorAll('.ly-item *')].map(e=>e.getBoundingClientRect()).filter(r=>r.width>0).sort((a,b)=>b.right-a.right)[0];
		return {菜单宽:Math.round(p.width),有滚动条:Boolean(thumb),
		 行左边距:item?Math.round(item.left-p.left):null,行右边距:item?Math.round(p.right-item.right):null,
		 内容右边缘距菜单右:text?Math.round(p.right-text.right):null,
		 滚动条:t?{距菜单右:Math.round(p.right-t.right),宽:Math.round(t.width),内容到它的间隙:text?Math.round(t.left-text.right):null}:null}})()`,
	);
}

/** 转录区左右留白差多少。 */
async function centred() {
	return app.evaluate(
		`(()=>{const view=document.querySelector('.ly-transcript')?.closest('.ly-scroll-view');if(!view)return '（没有转录区）';
		const v=view.getBoundingClientRect(),c=document.querySelector('.ly-transcript').getBoundingClientRect();
		const cs=getComputedStyle(view);const rail=document.querySelector('.ly-question-nav');
		return {视口宽:Math.round(v.width),左:Math.round(c.left-v.left),右:Math.round(v.right-c.right),
		 偏移:Math.round((c.left-v.left)-(v.right-c.right)),padding:cs.paddingLeft+' / '+cs.paddingRight,
		 导航条:rail?Math.round(rail.getBoundingClientRect().left-v.left)+'..'+Math.round(rail.getBoundingClientRect().right-v.left):'（没有）'}})()`,
	);
}

async function openPane(label: string) {
	await app.evaluate(`document.querySelector('button[aria-label="面板"]').click()`);
	await until(`document.querySelector('[role="menuitem"]')`);
	await app.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`);
	await frames(20);
}
async function until(expression: string) {
	await app.evaluate(
		`new Promise((resolve,reject)=>{const end=performance.now()+15000;function tick(){if(${expression})resolve();else if(performance.now()<end)requestAnimationFrame(tick);else reject(Error(${JSON.stringify(expression)}))}tick()})`,
	);
}
async function frames(n = 20) {
	await app.evaluate(`new Promise(r=>{let n=${n};function tick(){if(--n)requestAnimationFrame(tick);else r()}requestAnimationFrame(tick)})`);
}
async function click(selector: string) {
	await until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`);
	await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
	await frames();
}
async function shot(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, name + ".png"), Buffer.from(image.data, "base64"));
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await app?.stop();
	});

assert.ok(true);
