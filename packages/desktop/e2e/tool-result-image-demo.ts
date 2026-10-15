/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 工具读回来一张图，卡片里看得见那张图——边验边录。
 *
 * 模型是本地按剧本吐 SSE 的假服务：读一张项目里的 PNG，然后收尾。图特意做得比
 * `INLINE_IMAGE_CHARS` 大，于是两条路都走得到：正在跑的会话里像素是 `data:`；重启再打开时，
 * 显示用的转写把它停到 `session-media`，卡片拿到的只有 `media` 名字。
 *
 * 用法：node --experimental-strip-types e2e/tool-result-image-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, press, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume工具结果图片测试");
const PORT = 9493;
const MODEL_PORT = 9593;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const WIDTH = 240;
const HEIGHT = 160;

/** 一张横向渐变的 PNG，不压缩，好让它比内联上限大。 */
function gradientPng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < HEIGHT; y++) {
		rows.push(0);
		for (let x = 0; x < WIDTH; x++) rows.push(Math.round((x / WIDTH) * 255), Math.round((y / HEIGHT) * 255), 180);
	}
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(WIDTH, 0);
	ihdr.writeUInt32BE(HEIGHT, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(Buffer.from(rows), { level: 0 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [
	[{ text: "看一下这张截图。" }, { tool: "read", args: { path: "shot.png" } }],
	[{ text: "看到了，是一张渐变图。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			// The session-title request carries no tools; answering it from the script would eat a step.
			const titling = !body.includes('"tools"');
			const blocks: Block[] = titling ? [{ text: "读图演示" }] : SCRIPT[Math.min(request, SCRIPT.length - 1)];
			if (!titling) request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(600);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } });
				}
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "shot.png"), gradientPng());
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

const READ_ROW = `[...document.querySelectorAll("main [data-ly-tool]")].find((row) => row.innerText.includes("shot.png"))`;

/** 那张卡片此刻画出来的是什么：结果区的文字、每张图的地址和真实像素尺寸。 */
const card = (app: RunningApp) => app.evaluate<{ text: string; images: { src: string; natural: number; height: number }[] }>(`(() => {
	const row = ${READ_ROW};
	return {
		text: row?.innerText ?? "",
		images: [...(row?.querySelectorAll("img") ?? [])].map((img) => ({ src: img.src.slice(0, 40), natural: img.naturalWidth, height: Math.round(img.getBoundingClientRect().height) })),
	};
})()`);

/** 收着就点开读图那一行。 */
async function expand(app: RunningApp) {
	await until(app, `document.querySelector("main [data-ly-turn-process]")`);
	await until(app, READ_ROW);
	await app.evaluate(`(() => { ${READ_ROW}.querySelector("button[aria-expanded]")?.setAttribute("data-demo-read", ""); })()`);
	if (await app.evaluate<boolean>(`document.querySelector("[data-demo-read]")?.getAttribute("aria-expanded") !== "true"`)) await click(app, "[data-demo-read]");
	await until(app, `${READ_ROW}?.querySelector("img")?.complete || ${READ_ROW}?.innerText.includes("[图片")`);
	await frames(app, 40);
}

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	// 自己建 profile：默认的一次性目录在 `stop()` 时就删了，重启那一半就没得量。
	home = await mkdtemp(join(tmpdir(), "plume-tool-image-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};

	await d.until(`document.querySelector("main textarea")`, 60000);
	let stop = await startRecording(PORT, frames_);
	await pause(800);
	await d.type("读一下 shot.png");
	await pause(400);
	await d.submit();
	await d.settled(60000);
	await pause(1000);

	await expand(app);
	await pause(1000);
	const live = await card(app);
	console.log("正在跑的会话：", live);
	await capture("会话里_读图结果");
	check("结果区不再只写一行「[图片 image/png]」", !live.text.includes("[图片"), live.text);
	check("结果区画出了那张图，像素宽度就是原图的 240", live.images.length === 1 && live.images[0]?.natural === WIDTH, live.images);
	check("缩略图按 160px 高显示", live.images[0]?.height === HEIGHT, live.images);

	if (live.images.length > 0) {
		await click(app, `main [data-ly-tool] img`);
		await until(app, `document.querySelector('[role="dialog"][aria-label="图片预览"]')`);
		await pause(1200);
		await capture("点开大图");
		check("点缩略图打开图片预览", true, null);
		await press(app, "Escape", 27);
		await until(app, `!document.querySelector('[role="dialog"][aria-label="图片预览"]')`);
		await pause(800);
	}
	await stop();

	// 重启：同一份 profile，显示转写把大图停进 session-media，卡片拿到的是 `media`。
	const sessionId = await app.evaluate<string>(`document.querySelector("[data-ly-row] > button[aria-current]")?.closest("[data-ly-row]")?.getAttribute("data-ly-row") ?? ""`);
	await app.stop();
	app = await startApp({ port: PORT, reuseHome: home });
	await driver(app).until(`document.querySelector("main textarea")`, 60000);
	stop = await startRecording(PORT, frames_);
	await pause(600);
	if (sessionId && !(await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row="${sessionId}"] > button[aria-current]'))`))) await openSession(app, sessionId);
	await expand(app);
	await pause(1000);
	const cold = await card(app);
	console.log("重启后再打开：", cold);
	await capture("重启后_读图结果");
	check("重启后从 session-media 取缩略图", cold.images.length === 1 && cold.images[0]?.src.startsWith("ly-media://m/") === true, cold.images);
	check("重启后缩略图有像素", (cold.images[0]?.natural ?? 0) > 0, cold.images);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_工具结果图片_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
