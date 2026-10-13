/* oxlint-disable no-console -- demo CLI that prints what the real window did */
/**
 * 生图卡片：画的时候说进行到哪一步、角上有估计的进度，重试时说在重试；图到了从模糊变清晰、框不动；
 * 上面一行是模型和尺寸；悬停有「编辑」和下载；额度用完时是一张说清原因和恢复时间的卡——边验边录。
 *
 * 假服务：第一次出图先回 503（工具重试一次），再等 6 秒回一张 640×360 的 PNG；第二轮出图回 429，
 * 正文里写着额度什么时候恢复。
 *
 * 用法：node --experimental-strip-types e2e/image-card-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, hover, press, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume生图卡片测试");
const PORT = 9447;
const MODEL_PORT = 9547;
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
	[{ tool: "image_generate", args: { prompt: "同一座灯塔，夜里", aspect_ratio: "16:9" } }],
	[{ text: "额度用完了，恢复后再画。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let drawCalls = 0;
function startModel(): Server {
	let request = 0;
	const png = widePng().toString("base64");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			if (req.url?.endsWith("/images/generations")) {
				drawCalls++;
				if (drawCalls === 1) {
					res.writeHead(503, { "retry-after": "0" });
					res.end("busy");
					return;
				}
				if (drawCalls === 3) {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "Your quota will reset after 1h52m45s." } }));
					return;
				}
				await pause(6000);
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

const CAPTION = "main [data-ly-image-card] figcaption";
const FRAME = 'main [data-ly-canvas="done"]';
const STAGES = ["正在理解需求", "勾勒初稿", "铺陈画面", "打磨细节", "最后润色"];
const caption = (app: RunningApp) => app.evaluate<string>(`document.querySelector('${CAPTION}')?.textContent.trim() ?? ""`);
const percent = (app: RunningApp) => app.evaluate<number>(`Number(document.querySelector("main [data-ly-image-progress]")?.textContent.replace("%", "") ?? -1)`);
const box = (app: RunningApp, selector: string) => app.evaluate<{ w: number; h: number } | null>(`(() => { const el = document.querySelector('${selector}'); if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })()`);

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-image-card-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames_);
	await pause(600);
	await d.type("画一座海边的灯塔");
	await d.submit();

	// —— 一、重试中 ——
	await until(app, `document.querySelector('${CAPTION}')?.textContent.includes("正在重试")`, 900);
	await pause(700);
	await capture("重试中");
	check("出图端点回 503、工具在等着重试时，图上那行说「连接不稳，正在重试」", (await caption(app)) === "连接不稳，正在重试", await caption(app));

	// —— 二、画的时候：阶段和估计的进度 ——
	await until(app, `${JSON.stringify(STAGES)}.includes(document.querySelector('${CAPTION}')?.textContent.trim())`, 900);
	const p1 = await percent(app);
	await pause(1600);
	const p2 = await percent(app);
	const stage = await caption(app);
	const badge = await app.evaluate<{ bg: string; count: number }>(`(() => { const all = document.querySelectorAll("main [data-ly-image-progress]"); return { bg: getComputedStyle(all[0]).backgroundColor, count: all.length }; })()`);
	const held = await box(app, 'main [data-ly-canvas="pending"]');
	await capture("画的时候_阶段和进度");
	check(`重试过去以后说进行到哪一步（${stage}）`, STAGES.includes(stage), stage);
	check(`角上的进度在走（${p1}% → ${p2}%），一张卡只有一个读数`, p1 >= 0 && p2 > p1 && p2 < 100 && badge.count === 1, { p1, p2, badge });
	check(`进度的底是不透明的（${badge.bg}），压在点阵上读得出`, badge.bg.startsWith("rgb("), badge.bg);

	// —— 三、落地：从模糊变清晰，框不动 ——
	await app.evaluate(`(() => { const S = window.__reveal = { blur: 0, sizes: new Set(), stop: false }; const tick = () => { if (S.stop) return; const frame = document.querySelector("main [data-ly-canvas]"); const img = frame?.querySelector("img"); if (frame) { const r = frame.getBoundingClientRect(); S.sizes.add(Math.round(r.width) + "x" + Math.round(r.height)); } if (img && getComputedStyle(img).filter.includes("blur")) S.blur++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
	await until(app, `document.querySelector('${FRAME}')`, 900);
	await pause(1200);
	const reveal = await app.evaluate<{ blur: number; sizes: string[] }>(`(() => { window.__reveal.stop = true; return { blur: window.__reveal.blur, sizes: [...window.__reveal.sizes] }; })()`);
	const landed = await box(app, FRAME);
	const done = await caption(app);
	await capture("落地之后_模型和尺寸");
	check(`图到了是从模糊变清晰（${reveal.blur} 帧带模糊）`, reveal.blur >= 5, reveal);
	check(`落地前后框一像素不变（${held?.w}×${held?.h} → ${landed?.w}×${landed?.h}）`, reveal.sizes.length === 1 && held?.w === landed?.w && held?.h === landed?.h, { held, landed, sizes: reveal.sizes });
	check(`画完那一行是模型和尺寸（${done}）`, done === "GPT Image 1 · 640×360", done);

	// —— 四、悬停：编辑、下载 ——
	const actions = `[...document.querySelectorAll('${FRAME} .ly-image-action')]`;
	const before = await app.evaluate<number>(`Number(getComputedStyle(${actions}[0].parentElement).opacity)`);
	await hover(app, `${FRAME} img`);
	await pause(700);
	const after = await app.evaluate<{ opacity: number; labels: string[] }>(`({ opacity: Number(getComputedStyle(${actions}[0].parentElement).opacity), labels: ${actions}.map((b) => b.getAttribute("aria-label")) })`);
	await capture("悬停_编辑和下载");
	check(`悬停时出现「编辑」和「下载」（不透明度 ${before} → ${after.opacity}）`, before === 0 && after.opacity === 1 && after.labels.join() === "编辑,下载", { before, after });

	await app.evaluate(`(() => { window.__download = null; HTMLAnchorElement.prototype.click = function () { window.__download = { href: this.href.slice(0, 22), name: this.download }; }; })()`);
	await click(app, `${FRAME} .ly-image-action`, "下载");
	await until(app, `window.__download`, 300);
	const download = await app.evaluate<{ href: string; name: string } | null>(`window.__download`);
	check(`「下载」存成带时间的文件名（${download?.name}）`, /^plume-image-\d{4}(-\d{2}){5}\.png$/.test(download?.name ?? ""), download);

	await hover(app, `${FRAME} img`);
	await app.evaluate(`(() => { const S = window.__edit = { w: [], stop: false }; const tick = () => { if (S.stop) return; const img = document.querySelector('[role="dialog"] img:not([aria-hidden])'); if (img) S.w.push(img.getBoundingClientRect().width); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
	await click(app, `${FRAME} .ly-image-action`, "编辑");
	await until(app, `[...document.querySelectorAll('[role="dialog"] button[aria-label]')].some((b) => b.getAttribute("aria-label") === "完成")`, 300);
	await pause(1000);
	const widths = await app.evaluate<number[]>(`(() => { window.__edit.stop = true; return window.__edit.w; })()`);
	await capture("编辑_直接进标注");
	const end = widths[widths.length - 1] ?? 0;
	check(`「编辑」直接进标注：从缩略图的大小起飞（${(widths[0] ?? 0).toFixed(1)} → ${end.toFixed(1)}），不先放大再缩回`, widths.length > 3 && widths[0]! <= (landed?.w ?? 0) * 1.08 && Math.max(...widths) <= end + 0.5, widths.map((w) => w.toFixed(0)));
	await press(app, "Escape", 27);
	await pause(400);
	await press(app, "Escape", 27);
	await until(app, `!document.querySelector('[role="dialog"] img')`, 300);
	await pause(800);

	// —— 五、额度用完 ——
	await until(app, `document.querySelector("main textarea") && !document.querySelector('main [data-ly-tool="running"]')`, 600);
	await d.type("再画一张夜景");
	await d.submit();
	await until(app, `document.querySelector('main [data-ly-image-card="error"]')`, 900);
	await pause(1500);
	const card = await app.evaluate<string>(`document.querySelector('main [data-ly-image-card="error"]').innerText.replace(/\\s+/g, " ").trim()`);
	await capture("额度用完_卡片");
	check(`额度用完是一张卡：说是哪个模型、多久恢复（${card}）`, card.includes("GPT Image 1 的额度用完了") && card.includes("约 1h 53m 后恢复"), card);
	check("第一张图还在，没有被失败的那次影响", (await app.evaluate<number>(`document.querySelectorAll('${FRAME}').length`)) === 1, null);
	await pause(1000);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_生图卡片_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
