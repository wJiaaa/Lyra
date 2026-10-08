/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 派活的那段回复还在写时插一句话：子代理派出去之后，主会话不再干等它，几秒内回应那句话。边验边录。
 *
 * 从前「人一开口就放手」只在开口那一刻放一次：话说出口时子代理还没派，放了 0 个；那段回复写完才派
 * 出子代理，接下来的等待把这句话一直压到子代理全部跑完（真实会话里 45 秒，直到人又说了一句「停下啊」）。
 *
 * 假模型是本地的 Anthropic 流式接口：主会话第一段回复先写一句话，停住，等探针放行才吐出 `task` 调用；
 * 子代理的请求一直不答——它在跑，跑多久都不该挡住主会话。
 *
 * 用法：node --experimental-strip-types e2e/steer-before-dispatch-demo.ts [标签，如「修复前」] [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "修复后";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume插话放开等待测试");
const PORT = 9743;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const FIRST = "帮我梳理这个项目的整体架构";
const STEER = "算了 不用了";
const ANSWER = "好的，不梳理了，子代理我留在后台。";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------------------------
// 假模型
// ---------------------------------------------------------------------------------------------

const held: ServerResponse[] = [];
const main: string[] = [];
let subRequests = 0;
let releaseFirst: () => void = () => {};
const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });

function sse(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function end(res: ServerResponse, reason: "end_turn" | "tool_use"): void {
	sse(res, "message_delta", { delta: { stop_reason: reason }, usage: { output_tokens: 30 } });
	sse(res, "message_stop", {});
	res.end();
}

function startModel(): Server {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", async () => {
			const body = JSON.parse(raw) as { tools?: { name: string }[] };
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, "message_start", { message: { id: `demo-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			// 子代理手里没有 `task`：它的请求一直挂着，像一个跑得很久的子代理。
			if (!body.tools?.some((tool) => tool.name === "task")) {
				subRequests += 1;
				held.push(res);
				return;
			}
			const turn = main.push(raw);
			sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			if (turn === 1) {
				sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "我先派一个子代理去看看目录结构。" } });
				// 回复写到一半停住：人就是在这时开口的。
				await firstReleased;
				sse(res, "content_block_stop", { index: 0 });
				sse(res, "content_block_start", { index: 1, content_block: { type: "tool_use", id: "task-1", name: "task", input: {} } });
				sse(res, "content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ description: "梳理目录结构", prompt: "列出目录结构", subagent_type: "general" }) } });
				sse(res, "content_block_stop", { index: 1 });
				end(res, "tool_use");
				return;
			}
			sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: ANSWER } });
			sse(res, "content_block_stop", { index: 0 });
			end(res, "end_turn");
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

const paneText = () => app.evaluate<string>(`document.querySelector('[data-dock-pane="conversation"]')?.innerText ?? ""`);

async function send(text: string): Promise<void> {
	await click(app, '[data-dock-pane="conversation"] textarea');
	await app.send("Input.insertText", { text });
	await pause(500);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
}

async function main_(): Promise<void> {
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

		console.log(`【${LABEL}】一、开一轮，模型写了一句「先派一个子代理」之后停住`);
		await click(app, '[data-ly-row="qa-short"]');
		await pause(1000);
		await send(FIRST);
		await until(app, `document.querySelector('[data-dock-pane="conversation"]')?.innerText.includes("派一个子代理")`, 1200);
		await pause(1000);

		console.log("二、这时插一句「算了 不用了」，点「现在就发」——子代理还没派出去");
		await send(STEER);
		await until(app, `document.querySelector('[data-queue-row]')`, 600);
		await click(app, "[data-queue-row] [data-queue-steer]");
		await pause(1200);
		await screenshot("回复写到一半时插话");
		check("插话时子代理还没派出去", subRequests === 0, `${subRequests} 个子代理请求`);

		console.log("三、那段回复写完，派出子代理；子代理一直不交差");
		const releasedAt = Date.now();
		releaseFirst();
		let answeredAfter = -1;
		for (let i = 0; i < 150; i++) {
			if ((await paneText()).includes(ANSWER)) { answeredAfter = Date.now() - releasedAt; break; }
			await pause(100);
		}
		await pause(1200);
		await screenshot("主会话回应了插话");
		check("子代理派出去了，而且还在跑（它的请求一直没答）", subRequests >= 1 && held.length >= 1, `${subRequests} 个子代理请求，挂着 ${held.length} 个`);
		check("子代理没交差，主会话几秒内就回应了那句话", answeredAfter >= 0 && answeredAfter < 5000, answeredAfter < 0 ? "15 秒内没回应" : `${answeredAfter}ms`);
		check("主会话的第 2 个请求里带着那句话", main[1]?.includes(STEER) ?? false, main[1] ? "没带" : "没有第 2 个请求");
		check("第 2 个请求里，那个子代理的结果是「转到后台继续跑」", main[1]?.includes("转到后台继续跑") ?? false, main[1]?.slice(0, 200) ?? "没有第 2 个请求");
		console.log(`   回应耗时：${answeredAfter}ms`);
		await pause(1000);
		await stop();
	} finally {
		releaseFirst();
		for (const res of held.splice(0)) res.destroy();
		await app?.stop().catch(() => {});
		await closeListeningServer(model);
	}
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_回复写到一半时插话_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过，录像与截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main_();
