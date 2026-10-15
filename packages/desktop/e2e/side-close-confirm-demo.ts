/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 关侧边聊天之前问一句：在真窗口里走一遍，边验边录。
 *
 * 单测钉住了「什么时候问、答了以后怎样」（`test/side-chat-close-guard.test.ts`），这里补人看得到的：
 *
 *   - 空的一格：点 ✕ 直接关，不问；
 *   - 框里打了字：点 ✕ 弹出确认框，取消后标签和字都还在；
 *   - 有对话：确认之后会话连同记录一起删；
 *   - 勾上「不再询问」关一次，之后有内容也直接关。
 *
 * 用法：node --experimental-strip-types e2e/side-close-confirm-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeTab, frames, openPane, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume侧边聊天关闭确认测试");
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SIDE = '[data-dock-pane="chat"]';
const TAB = `[data-dock-pane]:not([inert]) [data-panel-tab="chat"]`;
const DIALOG = '[role="dialog"]';

function anthropic(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "qa", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}
const server = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		anthropic(res, "主会话在检查会话导航。SIDE_ANSWER");
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no port");

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

await mkdir(OUT_DIR, { recursive: true });
const app: RunningApp = await startApp({ port: PORT, seed: (dir) => seedInteractions(dir, address.port) });
const recorded: Frame[] = [];
const stopRecording = await startRecording(PORT, recorded);
let step = 0;
async function snap(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${String(++step).padStart(2, "0")}_${name}.png`), Buffer.from(image.data, "base64"));
}
const has = (selector: string) => app.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const sideCount = () => app.evaluate<number>(`window.plume.sideChat.list('qa-short').then(l=>l.length)`);
async function openSide() {
	await openPane(app, "侧边聊天");
	await until(app, `document.querySelector('${SIDE} textarea')`, 900);
	await pause(800);
}
async function typeInSide(text: string) {
	await click(app, `${SIDE} textarea`);
	await app.send("Input.insertText", { text });
	await frames(app, 4);
	await pause(600);
}
async function clickClose() {
	await click(app, `${TAB} button:not([role="tab"])`);
	await pause(900);
}

try {
	await openSession(app, "qa-short");

	console.log("1. 空的侧边聊天：直接关");
	await openSide();
	await clickClose();
	check("空的一格点 ✕ 不弹确认框", !(await has(DIALOG)));
	check("空的一格点 ✕ 直接关掉", !(await has(TAB)));

	console.log("2. 框里打了字：问一句，取消就留着");
	await openSide();
	await typeInSide("还没发出去的一句话");
	await snap("框里有没发出去的字");
	await clickClose();
	const dialog = await app.evaluate<{ title: string; detail: string; buttons: string[]; label: string } | null>(`(() => {
		const d = document.querySelector('${DIALOG}');
		if (!d) return null;
		return {
			title: d.querySelector('[data-dialog-title]')?.innerText.trim() ?? '',
			detail: d.querySelector('[data-dialog-title]')?.parentElement?.querySelector('.text-ink-muted')?.innerText.trim() ?? '',
			buttons: [...d.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean),
			label: d.querySelector('label')?.innerText.trim() ?? '',
		};
	})()`);
	await snap("确认框");
	check("弹出确认框，标题是「关闭侧边聊天？」", dialog?.title === "关闭侧边聊天？", dialog);
	check("说明写着删除且无法恢复", dialog?.detail === "这个侧边聊天将被删除，且无法恢复。", dialog?.detail);
	check("有「不再询问」勾选框", dialog?.label === "不再询问", dialog?.label);
	check("两颗按钮：取消、关闭侧边聊天", JSON.stringify(dialog?.buttons) === JSON.stringify(["取消", "关闭侧边聊天"]), dialog?.buttons);
	await pause(800);
	await click(app, `${DIALOG} button`, "取消");
	await until(app, `!document.querySelector('${DIALOG}')`, 900);
	await pause(800);
	check("取消后标签还在", await has(TAB));
	const kept = await app.evaluate<string>(`document.querySelector('${SIDE} textarea')?.value ?? ''`);
	check("取消后框里的字还在", kept === "还没发出去的一句话", kept);
	await snap("取消后原样留着");

	console.log("3. 有对话：确认后连同会话删掉");
	await app.evaluate(`(() => { const el = document.querySelector('${SIDE} textarea'); el.focus(); el.select(); })()`);
	await app.send("Input.insertText", { text: "主会话现在在做什么？" });
	await frames(app, 2);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	await until(app, `document.querySelector('${SIDE}')?.innerText.includes('SIDE_ANSWER')`, 30_000);
	await pause(1000);
	check("关之前有一个侧边聊天会话", (await sideCount()) === 1);
	await clickClose();
	check("有对话时点 ✕ 弹确认框", await has(DIALOG));
	await snap("有对话时的确认框");
	await click(app, `${DIALOG} button`, "关闭侧边聊天");
	await until(app, `!document.querySelector(${JSON.stringify(TAB)})`, 2000);
	await pause(800);
	check("确认后标签关掉", !(await has(TAB)));
	check("确认后侧边聊天会话删掉了", (await sideCount()) === 0, await sideCount());

	console.log("4. 勾上「不再询问」关一次，之后不再问");
	await openSide();
	await typeInSide("第二句没发出去的话");
	await clickClose();
	await click(app, `${DIALOG} label`, "不再询问");
	await pause(600);
	const ticked = await app.evaluate<boolean>(`document.querySelector('${DIALOG} input[type=checkbox]')?.checked === true`);
	check("点「不再询问」勾上了", ticked);
	await snap("勾上不再询问");
	await click(app, `${DIALOG} button`, "关闭侧边聊天");
	await until(app, `!document.querySelector(${JSON.stringify(TAB)})`, 2000);
	await pause(800);
	await openSide();
	await typeInSide("第三句没发出去的话");
	await clickClose();
	check("勾过以后有内容也不再问", !(await has(DIALOG)));
	check("勾过以后点 ✕ 直接关", !(await has(TAB)));
	await snap("不再询问之后直接关");

	// 同一个 drive 操作的「确认」那条路，供别的脚本用。
	await app.evaluate(`localStorage.removeItem("plume.sideChat.closeWithoutAsking")`);
	await openSide();
	await typeInSide("drive.closeTab 的确认");
	await closeTab(app, "chat", "关闭侧边聊天");
	check("drive.closeTab 能答确认框并关掉", !(await has(TAB)));
} catch (error) {
	console.error(error);
	check("脚本跑完", false, String(error));
	await snap("失败时的样子").catch(() => {});
} finally {
	await stopRecording();
	await app.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((one) => one.ok).length;
const out = join(OUT_DIR, `${STAMP}_侧边聊天关闭确认_${passed}of${checks.length}.mp4`);
await encode(recorded, out, 30, 1200);
console.log(`\n${passed}/${checks.length} 通过。视频：${out}`);
process.exit(passed === checks.length ? 0 : 1);
