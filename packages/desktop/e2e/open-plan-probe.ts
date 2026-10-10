/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 正文收尾时清单还挂着没勾的项，循环问它一次；它只补勾清单，这一轮就到此为止。
 *
 * 起因是 2026-10-10 的 `2333f4e9`：五步全做完，最后一条回复里却没有勾清单的那次调用，清单停在 1/5，
 * 任务卡说「停在 · 第 2 步」。假模型照那次的样子演：列清单、做完、只写正文收尾、被问到之后只调一次
 * `todo_write`。量的是人看得见的：任务卡写的是什么、提示那句话出没出现在转录里、输入框回没回到发送态、
 * 以及之后有没有多要一段正文（请求数）。
 *
 * 用法：node --experimental-strip-types e2e/open-plan-probe.ts [改动前|改动后]
 * 截图和视频写到 ~/Desktop/Plume清单收尾测试/。
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { frames, openSession, press, shot, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9711;
const MODEL_PORT = 9712;
const LABEL = process.argv[2] ?? "改动后";
const OUT_DIR = join(homedir(), "Desktop", "Plume清单收尾测试");
const STAMP = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace(/[T:]/g, "-");
process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;

const OPEN = [
	{ content: "读需求", status: "completed" },
	{ content: "写页面", status: "in_progress", activeForm: "正在写页面" },
	{ content: "三档宽度检查", status: "pending" },
];
const DONE = OPEN.map((todo) => ({ content: todo.content, status: "completed" }));
const ANSWER = "页面写好了，三档宽度都检查过。";
const NOTE = "（自动提示）任务清单";

let app: RunningApp;
let model: Server;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— ${saw}`}`);
}

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 带工具定义的请求才是这一轮里的回复；拟标题那次不带。 */
const turns: string[] = [];

function reply(res: ServerResponse, text: string, todos?: unknown[]): void {
	sse(res, { type: "message_start", message: { id: `msg_${turns.length}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
	sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	sse(res, { type: "content_block_stop", index: 0 });
	if (todos) {
		sse(res, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_${turns.length}`, name: "todo_write", input: {} } });
		sse(res, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ todos }) } });
		sse(res, { type: "content_block_stop", index: 1 });
	}
	sse(res, { type: "message_delta", delta: { stop_reason: todos ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
	sse(res, { type: "message_stop" });
	res.end();
}

function startModel(): Server {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			if (!body.includes("todo_write")) return reply(res, "清单收尾");
			turns.push(body);
			// 每一步之间留出能看清的停顿，视频里才分得出先后。
			setTimeout(() => {
				if (turns.length === 1) reply(res, "先列个清单。", OPEN);
				else if (turns.length === 2) reply(res, ANSWER);
				else if (turns.length === 3 && body.includes(NOTE)) reply(res, "", DONE);
				else reply(res, "（不该有这一句）");
			}, 900);
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

const RUNNING = `[...document.querySelectorAll('main button[aria-label]')].some((b) => /停止|Stop/.test(b.getAttribute('aria-label') || ''))`;

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	app = await startApp({ port: PORT, seed: (home) => seedInteractions(home, MODEL_PORT), scaleFactor: 2 });
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await until(app, `document.querySelector('[data-ly-row="qa-short"] > button')`, 1800);
		await openSession(app, "qa-short");
		await pause(1000);

		console.log(`【${LABEL}】发一句，让假模型列清单、做完、只写正文收尾`);
		await type(app, "main textarea", "做个宣传页");
		await press(app, "Enter", 13);
		await until(app, RUNNING, 1800);
		await until(app, `document.body.innerText.includes(${JSON.stringify(ANSWER)})`, 1800);
		await until(app, `!(${RUNNING})`, 1800);
		// 被问到之后那一次（如果有）也落完。
		await pause(2500);
		await frames(app, 60);

		const seen = await app.evaluate<{ text: string; running: boolean }>(`({ text: document.querySelector('main')?.innerText ?? '', running: ${RUNNING} })`);
		await shot(app, `${STAMP}_${LABEL}_一轮结束`);
		await pause(1200);

		check("只写正文收尾之后被问了一次清单", turns.length >= 3 && turns[2].includes(NOTE), `一共 ${turns.length} 次请求`);
		check("补勾清单之后没有再要一段正文", turns.length === 3, `一共 ${turns.length} 次请求`);
		// 清单全勾完时任务卡整个收起（`TaskList` 里 `done === todos.length`），所以量的是「停在 ·」那行没了。
		check("任务卡不再说「停在 · 某一步」", !/停在 · /.test(seen.text), seen.text.match(/停在 · [^\n]*/)?.[0] ?? "");
		check("回答下面没有「被中断」或「计划还有 N 项」那一行", !/上次执行被中断|计划还有 \d+ 项未完成/.test(seen.text), seen.text.match(/上次执行被中断|计划还有 \d+ 项未完成/)?.[0] ?? "");
		check("那句自动提示不出现在转录里", !seen.text.includes(NOTE), "转录里能看见提示原文");
		check("回答还在转录里", seen.text.includes(ANSWER), "回答不见了");
		check("输入框回到发送态", !seen.running, "还是停止按钮");
	} finally {
		await stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	await app.stop();
	await new Promise<void>((resolve) => model.close(() => resolve()));
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_清单收尾_${passed}of${checks.length}.mp4`);
	if (recorded.length > 0) await encode(recorded, out, 60, 1200);
	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频与截图：${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	model?.close();
	process.exitCode = 1;
});
