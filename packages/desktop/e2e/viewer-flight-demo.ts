/* oxlint-disable no-console -- demo CLI that prints what the real window did */
/**
 * 看图的飞入飞出、标注工具条的气泡、标注完按「完成」——逐帧量，边验边录。
 *
 * 假服务照搬 image-menu-demo：对话模型调一次 `image_generate`（16:9），出图端点回一张 640×360 的 PNG。
 * 每一帧记下查看器里那张图在屏幕上的框（带着正在跑的变换）、它所在那层的不透明度、遮罩的不透明度、
 * 缩略图是否藏着、工具条上方气泡的中心——「先放大再缩小」「起步发虚」「气泡跳一下」都变成数。
 *
 * 用法：node --experimental-strip-types e2e/viewer-flight-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, dragSelect, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume看图动画测试");
const PORT = 9446;
const MODEL_PORT = 9546;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const W = 640;
const H = 360;

/** 一张 16:9 的对角渐变 PNG，当作「画出来的图」。 */
function widePng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < H; y++) {
		rows.push(0);
		for (let x = 0; x < W; x++) rows.push(Math.round(60 + (x / W) * 160), Math.round(90 + (y / H) * 120), Math.round(200 - (x / W) * 120));
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
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(H, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [
	[{ text: "好，我来画。" }, { tool: "image_generate", args: { prompt: "海边的灯塔，黄昏", aspect_ratio: "16:9" } }],
	[{ text: "画好了。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const png = widePng().toString("base64");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			if (req.url?.endsWith("/images/generations")) {
				await pause(1200);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ b64_json: png }] }));
				return;
			}
			const titling = !body.includes('"tools"');
			const blocks: Block[] = titling ? [{ text: "灯塔" }] : SCRIPT[Math.min(request, SCRIPT.length - 1)];
			if (!titling) request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(300);
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
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	const base = `http://127.0.0.1:${MODEL_PORT}`;
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{
				id: "local", name: "Local", baseUrl: base, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
				models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
			},
			{
				id: "img", name: "Image Relay", baseUrl: `${base}/v1`, api: "openai-chat-completions", apiKey: "image-key", enabled: true,
				models: [{ id: "img/gpt-image-1", providerId: "img", modelId: "gpt-image-1", name: "GPT Image 1", contextWindow: 0, maxOutputTokens: 0, supportsThinking: false, supportsImages: true, supportsTools: false }],
			},
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		imageModelId: "img/gpt-image-1",
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

const THUMB = 'main [data-ly-canvas="done"]';
type Sample = { w?: number; h?: number; x?: number; y?: number; op?: number; back?: number; thumb: string; bubble?: number };

/** 每一帧量一次，直到 `stop()`。图那一层的不透明度取到对话框为止一路相乘——哪一层淡都算。 */
const SAMPLER = `(() => {
	const S = window.__flight = { f: [], stop: false };
	const tick = () => {
		if (S.stop) return;
		const img = document.querySelector('[role="dialog"] img:not([aria-hidden])');
		const thumb = document.querySelector('${THUMB}');
		const back = document.querySelector('[role="dialog"] > button');
		const bubble = document.querySelector('[data-toolbar-bubble]');
		const row = { thumb: thumb ? getComputedStyle(thumb).visibility : "gone" };
		if (img) {
			const r = img.getBoundingClientRect();
			let op = 1;
			for (let el = img; el && el.getAttribute("role") !== "dialog"; el = el.parentElement) op *= Number(getComputedStyle(el).opacity);
			Object.assign(row, { w: r.width, h: r.height, x: r.x + r.width / 2, y: r.y + r.height / 2, op });
		}
		if (back) row.back = Number(getComputedStyle(back).opacity);
		if (bubble) { const b = bubble.getBoundingClientRect(); row.bubble = b.x + b.width / 2; }
		S.f.push(row);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return true;
})()`;

const f1 = (n: number | undefined) => (n ?? 0).toFixed(1);

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-viewer-flight-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	const sample = async (act: () => Promise<void>, settle = 900) => {
		await app!.evaluate(SAMPLER);
		await act();
		await pause(settle);
		return app!.evaluate<Sample[]>(`(() => { window.__flight.stop = true; return window.__flight.f; })()`);
	};
	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames_);
	await pause(600);
	await d.type("画一座海边的灯塔");
	await d.submit();
	await until(app, `document.querySelector('${THUMB} img')?.complete && document.querySelector('${THUMB} img').naturalWidth > 0`, 900);
	await pause(1500);
	const thumb = await app.evaluate<{ w: number; h: number; x: number; y: number }>(`(() => { const r = document.querySelector('${THUMB}').getBoundingClientRect(); return { w: r.width, h: r.height, x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await capture("对话里的图");

	// —— 一、飞出去 ——
	const out = (await sample(() => click(app!, THUMB))).filter((row) => row.w !== undefined);
	await capture("查看器_打开");
	const first = out[0];
	const last = out[out.length - 1];
	const peak = Math.max(...out.map((row) => row.w!));
	console.log(`   飞出 ${out.length} 帧：第一帧 ${f1(first?.w)}×${f1(first?.h)} 不透明度 ${first?.op?.toFixed(2)} 遮罩 ${first?.back?.toFixed(2)}；缩略图 ${f1(thumb.w)}×${f1(thumb.h)}；终点 ${f1(last?.w)}`);
	check("第一帧从缩略图的大小起步", Boolean(first) && first.w! <= thumb.w * 1.08, { first: first?.w, thumb: thumb.w });
	check("第一帧在缩略图的位置", Boolean(first) && Math.hypot(first.x! - thumb.x, first.y! - thumb.y) < Math.max(24, thumb.w * 0.1), { first, thumb });
	check("一路只变大，不会先放大再缩小", peak <= last.w! + 0.5, { peak, last: last?.w });
	check("起步不发虚：飞出的每一帧都是实的", out.every((row) => row.op! >= 0.99), out.map((row) => row.op?.toFixed(2)));
	check("遮罩是淡入的，不是一下子全黑", (first?.back ?? 1) < 0.6, first?.back);
	await pause(800);

	// —— 二、飞回来 ——
	const back = await sample(() => click(app!, '[role="dialog"] button', "关闭 Esc"));
	const open = back.filter((row) => row.w !== undefined);
	const lastOpen = open[open.length - 1];
	const gone = back.findIndex((row) => row.w === undefined);
	console.log(`   飞回 ${open.length} 帧：最后一帧 ${f1(lastOpen?.w)}×${f1(lastOpen?.h)} 不透明度 ${lastOpen?.op?.toFixed(2)}`);
	check("落地时和缩略图一样大", Boolean(lastOpen) && Math.abs(lastOpen.w! - thumb.w) <= 3 && Math.abs(lastOpen.h! - thumb.h) <= 3, { lastOpen, thumb });
	check("飞回的每一帧都是实的，不会发白停在缩略图上", open.every((row) => row.op! >= 0.99), open.map((row) => row.op?.toFixed(2)));
	check("缩略图在查看器消失的那一帧回来", gone > 0 && back[gone].thumb === "visible", back[gone]);
	await pause(800);

	// —— 三、标注：气泡进场不跳；「完成」进输入框 ——
	await click(app, THUMB);
	await until(app, `document.querySelector('[role="dialog"] img')`);
	await pause(900);
	const entering = await sample(() => click(app!, '[role="dialog"] button', "标注"), 700);
	const bubbles = entering.map((row) => row.bubble).filter((x): x is number => x !== undefined);
	await capture("标注_工具条和气泡");
	console.log(`   气泡 ${bubbles.length} 帧，中心 ${f1(Math.min(...bubbles))}–${f1(Math.max(...bubbles))}`);
	check("工具条上方的气泡进场时不左右跳", bubbles.length > 2 && Math.max(...bubbles) - Math.min(...bubbles) < 1, bubbles.map((x) => x.toFixed(1)));
	const done = await app.evaluate<{ tip: string | null } | null>(`(() => { const b = [...document.querySelectorAll('[role="dialog"] button[aria-label]')].find((x) => x.getAttribute("aria-label") === "完成"); return b ? { tip: b.getAttribute("data-ly-tip") } : null; })()`);
	check(`对话里的图，确认键是「完成」（提示：${done?.tip ?? "无"}）`, done !== null, done);

	const canvas = await app.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('[role="dialog"] canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
	await dragSelect(app, { x: canvas.x + canvas.width * 0.3, y: canvas.y + canvas.height * 0.35 }, { x: canvas.x + canvas.width * 0.65, y: canvas.y + canvas.height * 0.65 }, 14);
	await pause(800);
	await capture("标注_画了一笔");
	await click(app, '[role="dialog"] button', "完成");
	await until(app, `!document.querySelector('[role="dialog"] img')`, 300);
	await until(app, `document.querySelector('main [data-ly-attachment][data-ly-shape="image"]')`, 300);
	await pause(1200);
	const handed = await app.evaluate<{ count: number; focused: boolean; draft: string }>(`(() => ({
		count: document.querySelectorAll('main [data-ly-attachment][data-ly-shape="image"]').length,
		focused: document.activeElement === document.querySelector("main textarea"),
		draft: document.querySelector("main textarea").value,
	}))()`);
	await capture("完成之后_输入框里的标注图");
	check("按「完成」后，带标注的图进了这个对话的输入框", handed.count === 1, handed);
	check(`光标落在输入框里，句子里有它的标记（${JSON.stringify(handed.draft)}）`, handed.focused && /【[^】]+】/.test(handed.draft), handed);
	await pause(1000);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_看图飞行与标注完成_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
