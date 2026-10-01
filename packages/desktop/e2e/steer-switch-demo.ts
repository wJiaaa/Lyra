/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 「现在就发」之后切走再切回来，那句话和正在写的回复都还在；模型接着回答它。边验边录。
 *
 * 从前切回来时窗口拿主进程的转录整份替换屏幕，而那份转录里只有已经落盘的消息：插进这一轮的话
 * 要等循环在下一个请求开头取走才落盘，正在流的回复要等收尾。两样一起从屏幕上消失，只剩一行
 * 「Thinking…」，看上去像模型再也不回了。
 *
 * 假模型是本地的 Anthropic 流式接口：第一轮吐几段之后停住不收尾——这正是最难看的那种时刻，
 * 回复不再增长，屏幕上也就没有任何东西能把它带回来——探针说结束才结束；第二轮正常答完。
 *
 * 用法：node --experimental-strip-types e2e/steer-switch-demo.ts [标签，如「修复前」] [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "修复后";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume插话切换测试");
const PORT = 9741;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const FIRST = "第一句：把迁移脚本跑一遍";
const STEERED = "第二句：先别动生产库，只跑测试库";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------------------------
// 假模型
// ---------------------------------------------------------------------------------------------

const held: ServerResponse[] = [];
const bodies: string[] = [];

function sse(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function finish(res: ServerResponse): void {
	sse(res, "content_block_stop", { index: 0 });
	sse(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } });
	sse(res, "message_stop", {});
	res.end();
}

function startModel(): Server {
	return createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const turn = bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, "message_start", { message: { id: `demo-${turn}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			const lines = turn === 1
				? ["第 1 轮：先看一下迁移脚本里有哪几步。", "\n\n脚本分三段：建表、回填、切换。"]
				: ["第 2 轮：好，只跑测试库。", "\n\n已经把连接串换成测试库，生产库没有碰。"];
			let n = 0;
			const timer = setInterval(() => {
				sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: lines[n] } });
				n += 1;
				if (n < lines.length) return;
				clearInterval(timer);
				// The first turn goes quiet without finishing; the second one ends on its own.
				if (turn === 1) held.push(res);
				else setTimeout(() => finish(res), 600);
			}, 500);
		});
	});
}

// ---------------------------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------------------------

let app: RunningApp;
let shot = 0;

async function screenshot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shot++;
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
}

/** 转录里看得见的用户消息。隐藏的那一层是切换用的预渲染，不算。 */
const steeredCount = () =>
	app.evaluate<number>(
		`[...document.querySelectorAll('[data-dock-pane="conversation"] [data-question-index]')].filter((e) => e.checkVisibility() && e.textContent.includes(${JSON.stringify(STEERED)})).length`,
	);
const paneText = () => app.evaluate<string>(`document.querySelector('[data-dock-pane="conversation"]')?.innerText ?? ""`);

async function click(selector: string): Promise<void> {
	await driver(app).until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`, 20000);
	const point = await app.evaluate<{ x: number; y: number }>(
		`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
	);
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
		await app.send("Input.dispatchMouseEvent", { type, ...point, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
}

async function send(text: string): Promise<void> {
	await click('[data-dock-pane="conversation"] textarea');
	await app.send("Input.insertText", { text });
	await pause(500);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const model = startModel();
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("假模型没起来");
	const frames: Frame[] = [];
	try {
		app = await startApp({
			port: PORT,
			seed: async (home) => {
				await seedInteractions(home, address.port);
				const path = join(home, "settings.json");
				const settings = JSON.parse(await readFile(path, "utf8"));
				await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off" }));
			},
		});
		const stop = await startRecording(PORT, frames);
		const d = driver(app);

		console.log(`【${LABEL}】一、开一轮，模型写了两段之后停住`);
		await click('[data-ly-row="qa-short"]');
		await pause(1000);
		await send(FIRST);
		await d.until(`document.querySelector('[data-dock-pane="conversation"]')?.innerText.includes("回填、切换")`, 20000);
		await pause(1000);

		console.log("二、正在跑的时候追加一句，它排在输入框上面");
		await send(STEERED);
		await d.until(`document.querySelector('[data-queue-row]')`, 10000);
		await pause(1000);
		await screenshot("追加的那句在排队条上");

		console.log("三、点「现在就发」");
		await click("[data-queue-row] [data-queue-steer]");
		await pause(1200);
		await screenshot("点了现在就发");
		check("点完之后那句进了转录", (await steeredCount()) === 1, `${await steeredCount()} 条`);

		console.log("四、切到另一个会话，再切回来");
		await click('[data-ly-row="qa-long"]');
		await pause(1500);
		await click('[data-ly-row="qa-short"]');
		await pause(1500);
		await screenshot("切回来之后");
		const back = await paneText();
		check("切回来之后，刚发出的那句还在", (await steeredCount()) === 1, `${await steeredCount()} 条`);
		check("切回来之后，模型正在写的回复还在", back.includes("回填、切换"), back.slice(-200).replace(/\s+/g, " "));
		check("这时模型还只收到 1 个请求（那句要等这一步写完才被取走）", bodies.length === 1, `${bodies.length} 个`);

		console.log("五、模型把这一步写完，循环取走那句，接着回答");
		for (const res of held.splice(0)) finish(res);
		await d.until(`document.querySelector('[data-dock-pane="conversation"]')?.innerText.includes("生产库没有碰")`, 20000);
		await d.until(`!document.querySelector('[data-composer-send="stop"]')`, 20000);
		await pause(1200);
		await screenshot("模型回答了那句");
		check("模型的第 2 个请求里带着那句", bodies[1]?.includes(STEERED) ?? false, bodies[1] ? "没带" : "没有第 2 个请求");
		check("那句在转录里只有一条，没有重复", (await steeredCount()) === 1, `${await steeredCount()} 条`);
		check("第 2 轮的回答画出来了", (await paneText()).includes("生产库没有碰"), "没看到");
		await pause(1000);
		await stop();
	} finally {
		for (const res of held.splice(0)) finish(res);
		await app?.stop().catch(() => {});
		await closeListeningServer(model);
	}
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_插话后切走再切回_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过，录像与截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
