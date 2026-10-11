/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 侧边聊天是一个会话：在真窗口里从头走一遍，边验边录。
 *
 * 单测各自钉住了一段（core 的 `side-session.test.ts`、主进程的 `side-session-hub.test.ts`、窗口的
 * `side-session-cache.test.ts`），这里补的是它们连起来之后人看得到的那几件事：
 *
 *   - 侧边聊天问主会话在做什么，请求里带着主会话的记录，回答画在侧边，主列不动；
 *   - 侧边聊天自己写文件：审批卡片出现在侧边面板里，点了允许，文件真的写进项目；
 *   - 主会话下一轮被告知侧边聊天改了哪些文件；
 *   - 标签写着第一句提问；侧边聊天会话不进侧栏；关掉标签，会话连同记录一起删，重开是空的。
 *
 * 模型是本地一个假的 Anthropic 端点，按请求里带没带侧聊的工具决定怎么答，不碰真实配置。
 *
 * 用法：node --experimental-strip-types e2e/side-session-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeTab, frames, openPane, openSession, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume侧聊会话测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SIDE = '[data-dock-pane="chat"]';
const QUESTION = "主会话现在在做什么？";

const requests: { side: boolean; raw: string }[] = [];
function anthropic(res: ServerResponse, text: string, tool?: { name: string; input: Record<string, unknown> }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "qa", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${requests.length}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
	emit("message_stop", {});
	res.end();
}
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		const body = JSON.parse(raw) as { tools?: { name: string }[]; messages?: { content: unknown }[] };
		const side = body.tools?.some((tool) => tool.name === "read_main_chat") ?? false;
		requests.push({ side, raw });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const last = JSON.stringify(body.messages?.at(-1)?.content ?? "");
		// 标题、摘要这类一次性请求不带工具，照常答一句就行。
		if (!side) return anthropic(res, raw.includes("<side-chat-changes>") ? "知道了，侧边聊天改过 notes.md，我先重读。MAIN_SAW_CHANGES" : "主会话回答。");
		if (last.includes("tool_result")) return anthropic(res, "notes.md 已经写好了。SIDE_WROTE");
		// 主会话的进展附在问题后面，所以问题本身是倒数第二条。
		if (JSON.stringify(body.messages?.slice(-2) ?? "").includes("WRITE_NOTES")) return anthropic(res, "", { name: "write", input: { path: "notes.md", content: "侧边聊天写的笔记\n" } });
		return anthropic(res, "主会话在检查会话导航、缓存与滚动位置。SIDE_ANSWER");
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

let home = "";
async function seed(dir: string) {
	home = dir;
	await seedInteractions(dir, address && typeof address !== "string" ? address.port : 0);
}

await mkdir(OUT_DIR, { recursive: true });
const app: RunningApp = await startApp({ port: PORT, seed });
const recorded: Frame[] = [];
const stopRecording = await startRecording(PORT, recorded);
let step = 0;
async function snap(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${String(++step).padStart(2, "0")}_${name}.png`), Buffer.from(image.data, "base64"));
}
async function waitFor(expression: string, ms = 30_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`)) return;
		await pause(200);
	}
	throw new Error(`等不到：${expression}`);
}
async function ask(text: string, scope: string) {
	await click(app, `${scope} textarea`);
	await app.send("Input.insertText", { text });
	await frames(app, 2);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
}
const sideText = () => app.evaluate<string>(`document.querySelector('${SIDE}')?.innerText ?? ''`);
const mainText = () => app.evaluate<string>(`document.querySelector('[data-ly-chat-surface="conversation"]')?.innerText ?? ''`);

try {
	console.log("1. 打开 qa-short，开侧边聊天");
	await openSession(app, "qa-short");
	await openPane(app, "侧边聊天");
	await until(app, `document.querySelector('${SIDE} textarea')`, 900);
	await pause(800);
	await snap("空的侧边聊天");
	const rowsBefore = await app.evaluate<number>(`document.querySelectorAll('[data-ly-row]').length`);

	console.log("2. 问主会话在做什么");
	await ask(QUESTION, SIDE);
	await waitFor(`document.querySelector('${SIDE}')?.innerText.includes('SIDE_ANSWER')`);
	await pause(1000);
	const first = requests.find((one) => one.side);
	check("侧边聊天的请求里带着主会话的记录", Boolean(first?.raw.includes("<main-session>") && first.raw.includes("qa-short 第 1 个问题")), first?.raw.slice(0, 200));
	check("侧边聊天的转录是主会话那一套（side-chat 表面里有用户气泡）", await app.evaluate<boolean>(`Boolean(document.querySelector('${SIDE} [data-ly-chat-surface="side-chat"] .ly-user-bubble'))`));
	check("主列里没有侧边聊天的回答", !(await mainText()).includes("SIDE_ANSWER"));
	const tab = await app.evaluate<string>(`document.querySelector('[data-panel-tab="chat"]')?.innerText.trim() ?? ''`);
	check("标签写着第一句提问", tab === QUESTION, tab);
	check("侧栏里没有多出一行", (await app.evaluate<number>(`document.querySelectorAll('[data-ly-row]').length`)) === rowsBefore);
	await snap("侧边聊天答了主会话的进度");

	console.log("3. 让侧边聊天自己写文件");
	await ask("WRITE_NOTES 帮我写一个 notes.md", SIDE);
	await waitFor(`document.querySelector('${SIDE} [data-approval-card]')`);
	await pause(1000);
	check("审批卡片在侧边面板里", true);
	check("主列没有审批卡片", !(await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-chat-surface="conversation"] [data-approval-card]'))`)));
	await snap("写文件的审批出现在侧边");
	const buttons = await app.evaluate<string[]>(`[...document.querySelectorAll('${SIDE} [data-approval-card] button')].map(b=>b.innerText.trim()).filter(Boolean)`);
	const allow = buttons.find((label) => label.startsWith("允许"));
	if (!allow) throw new Error(`没有「允许」：${JSON.stringify(buttons)}`);
	await click(app, `${SIDE} [data-approval-card] button`, allow);
	await waitFor(`document.querySelector('${SIDE}')?.innerText.includes('SIDE_WROTE')`);
	await pause(1000);
	const written = await readFile(join(home, "project", "notes.md"), "utf8").catch(() => "");
	check("文件真的写进了项目", written === "侧边聊天写的笔记\n", written);
	await snap("侧边聊天写完了文件");

	console.log("4. 主会话下一轮被告知");
	await ask("继续", '[data-ly-chat-surface="conversation"]');
	await waitFor(`document.querySelector('[data-ly-chat-surface="conversation"]')?.innerText.includes('MAIN_SAW_CHANGES')`);
	await pause(1000);
	const told = requests.filter((one) => !one.side && one.raw.includes("<side-chat-changes>"));
	check("主会话的请求里有 <side-chat-changes> 和 notes.md", told.length > 0 && told[0]!.raw.includes("notes.md"));
	await snap("主会话知道侧边聊天改了文件");

	console.log("5. 关掉标签，再开");
	const listed = await app.evaluate<number>(`window.plume.sideChat.list('qa-short').then(l=>l.length)`);
	check("关之前这个会话旁边有一个侧边聊天会话", listed === 1, listed);
	await closeTab(app, "chat");
	await pause(600);
	const after = await app.evaluate<number>(`window.plume.sideChat.list('qa-short').then(l=>l.length)`);
	check("关掉标签，侧边聊天会话删掉了", after === 0, after);
	await openPane(app, "侧边聊天");
	await until(app, `document.querySelector('${SIDE} textarea')`, 900);
	await pause(800);
	check("重开是空的", !(await sideText()).includes("SIDE_ANSWER"));
	await snap("重开是空的");
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
const out = join(OUT_DIR, `${STAMP}_侧边聊天是一个会话_${passed}of${checks.length}.mp4`);
await encode(recorded, out, 30, 1200);
console.log(`\n${passed}/${checks.length} 通过。视频：${out}`);
process.exit(passed === checks.length ? 0 : 1);
