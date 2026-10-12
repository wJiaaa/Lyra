/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * `preview` 的检查截长页面的下半截，在真应用里跑一遍。
 *
 * 截图一张最多 2160px。从前长页面的下半截看不到，模型只好把页面按段切成新文件再一段段检查；现在结果
 * 给出下一段的 `from`，带上它再检查就截那一段。这里用一个脚本化的模型连查三段再发布，量的是模型真正
 * 收到的东西：结果文字，以及每张截图最上面那一行落在页面的哪一段（每 500px 一种颜色）。
 *
 * Usage: node --experimental-strip-types e2e/preview-check-from-demo.ts
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = join(homedir(), "Desktop", "Plume预览分段检查测试");
const PORT = 9491;
const MODEL_PORT = 9591;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** Ten bands of 500px, each its own colour, so the first row of a screenshot says where it was taken. */
const BANDS: [number, number, number][] = [
	[230, 57, 70], [244, 162, 97], [233, 196, 106], [42, 157, 143], [38, 70, 83],
	[106, 76, 147], [25, 130, 196], [138, 201, 38], [255, 89, 94], [60, 60, 60],
];
const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0}.band{height:500px;display:flex;align-items:center;justify-content:center;color:#fff;font:600 28px/1 system-ui}
</style></head><body>${BANDS.map((c, i) => `<div class="band" style="background:${hex(c)}">第 ${i + 1} 段 · ${i * 500}–${i * 500 + 500}px</div>`).join("")}</body></html>`;

interface Seen { text: string; image?: Buffer }
/** What each request carried back from the tool calls before it — what the model was shown. */
const seen: Seen[] = [];

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
function script(request: number): Block[] {
	if (request === 0) return [{ tool: "preview", args: { title: "十段长页", html: PAGE, check: true } }];
	if (request === 1) return [{ tool: "preview", args: { title: "十段长页", html: PAGE, check: true, from: 2160 } }];
	if (request === 2) return [{ tool: "preview", args: { title: "十段长页", html: PAGE, check: true, from: 4320 } }];
	if (request === 3) return [{ tool: "preview", args: { id: /id: ([0-9a-f]{8})/.exec(seen.at(-1)?.text ?? "")?.[1] ?? "missing" } }];
	return [{ text: "三段都看过了，页面已发布在上面。" }];
}

/** The tool results at the end of a request, as text and the first image. */
function lastResults(body: string): Seen {
	const request = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
	const last = request.messages.at(-1);
	const blocks = Array.isArray(last?.content) ? (last.content as Record<string, unknown>[]) : [];
	let text = "";
	let image: Buffer | undefined;
	for (const block of blocks.filter((b) => b.type === "tool_result")) {
		for (const part of (Array.isArray(block.content) ? block.content : [{ type: "text", text: String(block.content ?? "") }]) as Record<string, unknown>[]) {
			if (part.type === "text") text += String(part.text);
			const source = part.source as { data?: string } | undefined;
			if (part.type === "image" && source?.data && !image) image = Buffer.from(source.data, "base64");
		}
	}
	return { text, image };
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			if (request > 0) seen.push(lastResults(Buffer.concat(chunks).toString("utf8")));
			const blocks = script(request);
			request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(500);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } });
				}
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } });
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
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		autoSummarizeTitle: false,
		permissionMode: "full",
		thinking: "off",
		appearance: { theme: "light" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

/** Width, height and the top-left pixel of a PNG — that pixel has no neighbour to be filtered against. */
function readPng(png: Buffer): { width: number; height: number; topLeft: [number, number, number] } {
	const chunks: Buffer[] = [];
	for (let at = 8; at < png.length; ) {
		const length = png.readUInt32BE(at);
		if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(chunks));
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), topLeft: [raw[1], raw[2], raw[3]] };
}

/** The band whose colour this is, by nearest colour. */
function bandOf(pixel: [number, number, number]): number {
	let best = -1;
	let distance = Number.POSITIVE_INFINITY;
	BANDS.forEach((c, i) => {
		const d = Math.hypot(c[0] - pixel[0], c[1] - pixel[1], c[2] - pixel[2]);
		if (d < distance) [best, distance] = [i, d];
	});
	return distance < 30 ? best : -1;
}

let app: RunningApp;
let model: Server;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  （${saw}）`);
}

async function shoot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(data, "base64"));
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(800);
		await d.type("画一个很长的页面，检查完整再发布");
		await d.submit();
		await d.settled(120000);
		await pause(1500);
		await shoot("01_三段检查后发布");
	} finally {
		await stop();
	}

	const [first, second, third, published] = seen;
	console.log("\n一、不带 from 的检查");
	check("结果写明按对话宽度检查", /按对话的宽度 720px 检查/.test(first?.text ?? ""), first?.text.split("\n").slice(1, 2).join("") ?? "");
	check("结果给出下一段的 from", /下面还有，要看就加 from: 2160/.test(first?.text ?? ""), (/截图是[^\n]*/.exec(first?.text ?? "") ?? [""])[0]);
	console.log("\n二、from: 2160");
	check("结果说截的是 2160–4320px", /截图是 2160–4320px 这一段（整页 500\dpx）；下面还有，要看就加 from: 4320/.test(second?.text ?? ""), (/截图是[^\n]*/.exec(second?.text ?? "") ?? [""])[0]);
	console.log("\n三、from: 4320");
	check("最后一段：截到页面底，不再说下面还有", /截图是 43\d\d–500\dpx 这一段（整页 500\dpx）：/.test(third?.text ?? "") && !/下面还有/.test(third?.text ?? ""), (/截图是[^\n]*/.exec(third?.text ?? "") ?? [""])[0]);

	console.log("\n四、截图本身（模型收到的那几张）");
	const expectTop = [0, 4, 8];
	for (const [i, result] of [first, second, third].entries()) {
		if (!result?.image) {
			check(`第 ${i + 1} 张截图`, false, "没有收到图片");
			continue;
		}
		await writeFile(join(OUT_DIR, `${STAMP}_0${i + 2}_模型收到的第${i + 1}张截图.png`), result.image);
		const png = readPng(result.image);
		const band = bandOf(png.topLeft);
		check(`第 ${i + 1} 张最上面一行落在第 ${expectTop[i]! + 1} 段`, band === expectTop[i], `左上角 rgb(${png.topLeft.join(",")}) → 第 ${band + 1} 段，${png.width}×${png.height}`);
	}
	check("前两张是满高的一屏（2160:720 = 3）", [first, second].every((r) => r?.image && Math.abs(readPng(r.image).height / readPng(r.image).width - 3) < 0.01), "");
	console.log("\n五、发布");
	check("按 id 发布成功", /已在对话中展示/.test(published?.text ?? ""), published?.text.slice(0, 40) ?? "");
	const card = await app.evaluate<boolean>('Boolean(document.querySelector("main [data-ly-preview]"))').catch(() => false);
	check("对话里出现了预览卡片", card, String(card));

	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_预览分段检查_${passed}of${checks.length}.mp4`);
	await app.stop();
	await closeListeningServer(model);
	if (frames.length > 0) await encode(frames, out, 60, 1200);
	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	if (model) await closeListeningServer(model).catch(() => {});
	process.exitCode = 1;
});
