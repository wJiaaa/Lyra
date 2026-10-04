/* oxlint-disable no-console -- probe CLI that prints what the real windows did */
/**
 * 移动端按上游恢复之后，在真窗口里走一遍：桌面端开同步、出二维码，手机连上来，两边互发消息。
 *
 * `mobile-sync.test.ts` 已经把同步的每条路逐项断言过；这里补的是给人看的那一份——两个窗口各录一段，
 * 关键状态各拍一张。手机是 `mobile-app.ts` 起的那个真 WebView 外壳（同一份 bridge 脚本、同一份
 * 渲染产物），不是把桌面窗口缩窄。
 *
 * 用法：node --experimental-strip-types e2e/mobile-restore-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { startMobile } from "./mobile-app.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume移动端恢复测试");
const SYNC_PORT = 4651;
const BACK = "返回工作区";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** A model that starts a reply at once and finishes it when told, so both screens can be seen mid-stream. */
let reply: ServerResponse | undefined;
let turn = 0;
const model = createServer((request, response) => {
	request.resume();
	request.on("end", () => {
		reply = response;
		response.writeHead(200, { "content-type": "text/event-stream" });
		sse({ type: "message_start", message: { id: `demo-${++turn}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
		sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `收到第 ${turn} 条，正在回复` } });
	});
});
function sse(event: { type: string; [key: string]: unknown }) {
	reply?.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function finish(text: string) {
	sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	sse({ type: "content_block_stop", index: 0 });
	sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } });
	sse({ type: "message_stop" });
	reply?.end();
	reply = undefined;
}

type Page = Pick<RunningApp, "evaluate" | "send">;

async function until(page: Page, expression: string, label: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await page.evaluate<boolean>(`Boolean(${expression})`)) return true;
		await pause(100);
	}
	check(label, false, await page.evaluate<string>("document.body.innerText.slice(-400)"));
	return false;
}

/** A real pointer at the element's centre, after checking it is the element there. */
async function click(page: Page, selector: string) {
	const point = await page.evaluate<{ x: number; y: number }>(
		`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.checkVisibility({visibilityProperty:true}));if(!el)throw new Error(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
	);
	for (const type of ["mousePressed", "mouseReleased"]) {
		await page.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...point });
	}
}

/** Click the element whose own text is exactly this. */
async function clickText(page: Page, selector: string, text: string) {
	const marked = await page.evaluate<boolean>(
		`(()=>{document.querySelector('[data-demo-target]')?.removeAttribute('data-demo-target');const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&e.checkVisibility());if(!el)return false;el.setAttribute('data-demo-target','');return true;})()`,
	);
	if (!marked) throw new Error(`找不到「${text}」`);
	await click(page, "[data-demo-target]");
}

async function shot(page: Page, name: string) {
	const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(data, "base64"));
}

/** Frames by `Page.captureScreenshot`, so a window covered by others still records. */
async function recorder(port: number) {
	const grabber = await frameGrabber(port);
	const frames: Frame[] = [];
	const state = { running: true };
	const loop = (async () => {
		while (state.running) {
			frames.push({ at: Date.now(), data: await grabber.shot() });
			await pause(80);
		}
	})();
	return {
		frames,
		stop: async () => {
			state.running = false;
			await loop;
			grabber.close();
		},
	};
}

async function settingsNav(page: Page): Promise<string[]> {
	return page.evaluate<string[]>("[...document.querySelectorAll('[data-ly-settings] nav button')].map(e=>e.textContent.trim()).filter(Boolean)");
}

await mkdir(OUT_DIR, { recursive: true });
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");

let desktop: RunningApp | undefined;
let phone: Awaited<ReturnType<typeof startMobile>> | undefined;
try {
	desktop = await startApp({
		port: 9772,
		seed: async (home) => {
			await seedInteractions(home, address.port);
			const file = join(home, "settings.json");
			const settings = JSON.parse(await readFile(file, "utf8"));
			Object.assign(settings, { uiLocale: "zh-CN", appearance: { theme: "light" }, sync: { enabled: false, port: SYNC_PORT, token: null } });
			await writeFile(file, JSON.stringify(settings));
		},
	});
	const desk = await recorder(9772);

	console.log("\n—— 桌面端：设置 → 移动端同步 ——");
	await pause(1000);
	await click(desktop, ".ly-sidebar-foot button");
	await until(desktop, "document.querySelector('[data-ly-settings]')", "设置页打开了");
	const nav = await settingsNav(desktop);
	check("设置导航里有「移动端同步」，没有「Web 访问」", nav.includes("移动端同步") && !nav.includes("Web 访问"), nav.join("、"));
	await clickText(desktop, "[data-ly-settings] nav button", "移动端同步");
	if (await until(desktop, "[...document.querySelectorAll('[data-ly-settings] h1')].some(e=>e.textContent.trim()==='移动端同步')", "移动端同步页打开了")) check("移动端同步页打开了", true);
	await pause(1000);
	await shot(desktop, "01_桌面端_移动端同步页_未启用");
	await click(desktop, "main button[role='switch']");
	const qr = await until(desktop, "document.querySelector('main svg path') && document.body.innerText.includes('运行中')", "启用后出现二维码并显示运行中");
	if (qr) check("启用后出现二维码并显示运行中", true);
	await pause(1200);
	await shot(desktop, "02_桌面端_启用后的配对二维码");
	const token = await desktop.evaluate<string | null>("window.plume.settings.get().then(s=>s.sync.token)");
	check("启用时生成了配对令牌", typeof token === "string" && token.length >= 16, String(token));

	console.log("\n—— 手机：连上桌面端 ——");
	phone = await startMobile(desktop.home, { host: "127.0.0.1", port: SYNC_PORT, token: token ?? "", platform: "darwin" }, 9773);
	await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await phone.send("Emulation.setTouchEmulationEnabled", { enabled: true });
	await until(phone, "document.querySelector('.ly-shell') && document.querySelector('main textarea')", "手机加载出桌面端的界面");
	check("手机端宿主是 mobile", (await phone.evaluate<string>("document.documentElement.dataset.plumeHost ?? ''")) === "mobile");
	const cam = await recorder(9773);
	const seen = await until(desktop, "document.body.innerText.includes('1 个设备正在同步中')", "桌面端看到一台设备连上");
	if (seen) check("桌面端看到一台设备连上", true);
	await pause(1000);
	await shot(phone, "03_手机_首页");
	await shot(desktop, "04_桌面端_手机连上之后");

	await click(phone, "button[aria-label^='显示侧边栏']");
	await until(phone, "document.querySelector('[data-ly-row=\"qa-long\"]')?.getBoundingClientRect().left >= 0", "手机抽屉拉开");
	await pause(1000);
	await shot(phone, "05_手机_会话抽屉");
	await click(phone, "[data-ly-row='qa-long'] > button");
	await until(phone, "document.querySelector('main')?.innerText.includes('第 120 个问题')", "手机打开了长会话");
	await clickText(desktop, "[data-ly-settings] button", BACK);
	if (await until(desktop, "document.querySelector('[data-ly-row=\"qa-long\"]')?.checkVisibility()", "桌面端回到工作区")) check("桌面端回到工作区", true);
	await click(desktop, "[data-ly-row='qa-long'] > button");
	await pause(1000);

	console.log("\n—— 手机发、桌面看；桌面发、手机看 ——");
	await click(phone, "main textarea");
	await phone.send("Input.insertText", { text: "从手机发的一句：帮我看看这个会话" });
	await pause(800);
	await click(phone, "main button[aria-label='发送']");
	const fromPhone = await until(desktop, "document.querySelector('main')?.innerText.includes('从手机发的一句')", "桌面端出现了手机发的消息");
	if (fromPhone) check("桌面端出现了手机发的消息", true);
	const streaming = await until(desktop, "document.querySelector('main')?.innerText.includes('收到第 1 条，正在回复')", "回复在桌面端流式出现");
	if (streaming) check("回复同时在桌面端流式出现", true);
	await pause(1000);
	await shot(phone, "06_手机_发出后回复流式出现");
	await shot(desktop, "07_桌面端_同步看到手机的这一轮");
	finish("。这一轮在两边都画完了。");
	await until(phone, "document.querySelector('main')?.innerText.includes('这一轮在两边都画完了')", "手机看到回复收尾");
	await until(phone, "!document.querySelector('button[aria-label=\"停止\"]')", "手机上这一轮结束");
	await pause(1000);

	await click(desktop, "main textarea");
	await desktop.send("Input.insertText", { text: "从电脑发的一句：手机那边看得到吗" });
	await pause(600);
	await click(desktop, "main button[aria-label='发送']");
	const toPhone = await until(phone, "document.querySelector('main')?.innerText.includes('从电脑发的一句')", "手机出现了电脑发的消息");
	if (toPhone) check("手机出现了电脑发的消息", true);
	await until(phone, "document.querySelector('main')?.innerText.includes('收到第 2 条')", "回复在手机上流式出现");
	await pause(800);
	finish("。看得到。");
	await until(phone, "document.querySelector('main')?.innerText.includes('看得到。')", "手机看到第二轮收尾");
	await pause(1200);
	await shot(phone, "08_手机_看到电脑发的这一轮");

	console.log("\n—— 手机上的设置只剩手机能改的 ——");
	await click(phone, "button[aria-label^='显示侧边栏']");
	await pause(800);
	await click(phone, "button[aria-label='设置']");
	await until(phone, "document.querySelector('[data-ly-settings]')", "手机打开了设置");
	await pause(1000);
	const phoneNav = await phone.evaluate<string>("document.querySelector('[data-ly-settings]')?.innerText ?? ''");
	check("手机设置里没有钩子、MCP、定时任务这些桌面端才执行的配置", !/钩子|MCP|定时任务/.test(phoneNav), phoneNav.slice(0, 200));
	await shot(phone, "09_手机_设置页");

	await cam.stop();
	await desk.stop();
	const passed = checks.filter((c) => c.ok).length;
	await encode(cam.frames, join(OUT_DIR, `${STAMP}_手机端全程_${passed}of${checks.length}.mp4`), 30, 1500);
	await encode(desk.frames, join(OUT_DIR, `${STAMP}_桌面端全程_${passed}of${checks.length}.mp4`), 30, 1500);
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await phone?.stop().catch(() => {});
	await desktop?.stop().catch(() => {});
	await closeListeningServer(model).catch(() => {});
}
