/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 侧边聊天答完以后，通知里会不会多出一条点不掉的「新对话」。
 *
 * 在 `qa-long` 旁边开侧边聊天问一句，假模型直接答完；然后点铃铛，看列表里有没有它、铃铛上那颗点亮
 * 没亮。对照组是另一个会话 `qa-short` 在后台跑完——那一条照旧该出现。
 *
 * 用法（渲染进程从源码加载，改动前后各跑一遍就能对照）：
 *   pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/side-chat-notice-demo.ts <输出目录> <标签>
 */

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, frames, openNotifications, openPane, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume侧聊通知测试");
const LABEL = process.argv[3] ?? "改动后";
const PORT = 9633;

function reply(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	res.writeHead(200, { "content-type": "text/event-stream" });
	emit("message_start", { message: { id: "qa", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		// 「再跑一轮」晚一点答：要在它答完之前离开那个会话，结果才算没看到。
		const text = raw.includes("SIDE_ASK") ? "SIDE_REPLY 侧聊答完了。" : "BACKGROUND_REPLY 后台会话答完了。";
		setTimeout(() => reply(res, text), raw.includes("BACKGROUND_LATER") ? 2500 : 0);
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");

const home = await mkdtemp(join(tmpdir(), "plume-side-notice-"));
await seedInteractions(home, address.port);
const renderer = await startDevRenderer();
const app = await startApp({ port: PORT, reuseHome: home, rendererUrl: renderer.url });

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`${ok ? "✅" : "❌"} ${what} —— ${saw}`);
}
const notices = () => app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"][aria-label="通知"] [data-ly-notice]')].map(e=>e.getAttribute('data-ly-notice')+':'+e.textContent.trim())`);
const bellDot = () => app.evaluate<string | null>(`document.querySelector('[data-ly-notifications-button] [data-ly-notice-dot]')?.getAttribute('data-ly-notice-dot') ?? null`);
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
await mkdir(OUT_DIR, { recursive: true });
const snap = async (name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${stamp}_${LABEL}_${name}.png`), Buffer.from(image.data, "base64"));
};

const recorded: Frame[] = [];
const stop = await startRecording(PORT, recorded);
try {
	await openSession(app, "qa-long");
	await pause(800);

	// 侧边聊天：问一句，等它答完。
	await openPane(app, "侧边聊天");
	const field = '[data-dock-pane="chat"] textarea';
	await until(app, `document.querySelector('${field}')`, 900);
	await click(app, field);
	await app.send("Input.insertText", { text: "SIDE_ASK 帮我看一眼" });
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	await until(app, `document.querySelector('[data-dock-pane="chat"]')?.textContent.includes('SIDE_REPLY')`, 900);
	await until(app, `!document.querySelector('[data-dock-pane="chat"] [aria-label="停止"]')`, 900);
	await frames(app, 10);
	await pause(1000);

	check("侧聊答完后铃铛上没有点", (await bellDot()) === null, `dot=${await bellDot()}`);
	await openNotifications(app);
	await pause(1000);
	await snap("01_侧聊答完后的通知");
	const afterSide = await notices();
	check("通知里没有侧聊那一条", afterSide.length === 0, JSON.stringify(afterSide));
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
	await pause(600);

	// 对照：普通会话在后台跑完，照旧该提醒。
	await openSession(app, "qa-short");
	await click(app, "main textarea");
	await app.send("Input.insertText", { text: "BACKGROUND_ASK 跑一轮" });
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	await until(app, `document.querySelector('main')?.textContent.includes('BACKGROUND_REPLY')`, 900);
	await until(app, `!document.querySelector('main [aria-label="停止"]')`, 900);
	// 看着答完的不算未读，所以再问一轮、趁它还没答完就离开。
	await click(app, "main textarea");
	await app.send("Input.insertText", { text: "BACKGROUND_LATER 再跑一轮" });
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	await openSession(app, "qa-long");
	await until(app, `document.querySelector('[data-ly-notifications-button] [data-ly-notice-dot]')`, 900);
	await pause(800);
	await openNotifications(app);
	await pause(1000);
	await snap("02_后台会话答完后的通知");
	const afterBackground = await notices();
	check("后台会话答完照旧出现在通知里", afterBackground.length === 1 && afterBackground[0]!.startsWith("done:qa-short"), JSON.stringify(afterBackground));
	await pause(1000);
} finally {
	await stop();
	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${stamp}_${LABEL}_侧聊通知_${passed}of${checks.length}.mp4`));
	await app.stop();
	await renderer.close();
	await closeListeningServer(server);
	await rm(home, { recursive: true, force: true });
	console.log(`${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
}
