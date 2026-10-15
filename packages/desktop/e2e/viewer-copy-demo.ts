/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 图片预览里的「复制图片」——边验边录。
 *
 * 借 tool-result-image-demo 的剧本：模型读一张项目里的 JPEG。正在跑的会话里预览拿到的是
 * `data:image/jpeg`，验「非 PNG 也能复制成 PNG」；重启后拿到的是 `ly-media://m/…`，验跨协议的图。
 * 剪贴板从 macOS 那一侧读回来量尺寸，不信页面自己的说法。会覆盖本机剪贴板。
 *
 * 第一句话本身也带着这张图：重启后它被停进 session-media，在空输入框里按 ↑ 翻回那句话时，附件得带着
 * 像素回来（`withParkedPixels` 经主进程读字节——窗口自己 fetch `ly-media://` 会被 CORS 拒掉）。
 *
 * 用法：node --experimental-strip-types e2e/viewer-copy-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, press, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume图片预览复制测试");
const PORT = 9443;
const MODEL_PORT = 9543;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const WIDTH = 240;
const HEIGHT = 160;

/** 一张带噪点的渐变 PNG，转成 JPEG 后仍比内联上限大。 */
function gradientPng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < HEIGHT; y++) {
		rows.push(0);
		for (let x = 0; x < WIDTH; x++) rows.push(...[(x / WIDTH) * 215, (y / HEIGHT) * 215, 150].map((v) => Math.round(v + Math.random() * 40)));
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
	[{ text: "看一下这张截图。" }, { tool: "read", args: { path: "shot.jpg" } }],
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
			const blocks: Block[] = titling ? [{ text: "复制演示" }] : SCRIPT[Math.min(request, SCRIPT.length - 1)];
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
	await writeFile(join(home, "shot.png"), gradientPng());
	// 带噪点的 JPEG 压不小，超过内联上限，重启后才会停进 session-media、变成 `ly-media://m/`。
	execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", join(home, "shot.png"), "--out", join(project, "shot.jpg")], { stdio: "ignore" });
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

const READ_ROW = `[...document.querySelectorAll("main [data-ly-tool]")].find((row) => row.innerText.includes("shot.jpg"))`;
const VIEWER = '[role="dialog"][aria-label="图片预览"]';
const COPY = `${VIEWER} button[aria-label="复制图片"]`;

async function expand(app: RunningApp) {
	await until(app, `document.querySelector("main [data-ly-turn-process]")`);
	await until(app, READ_ROW);
	await app.evaluate(`(() => { ${READ_ROW}.querySelector("button[aria-expanded]")?.setAttribute("data-demo-read", ""); })()`);
	if (await app.evaluate<boolean>(`document.querySelector("[data-demo-read]")?.getAttribute("aria-expanded") !== "true"`)) await click(app, "[data-demo-read]");
	await until(app, `${READ_ROW}?.querySelector("img")?.complete`);
	await frames(app, 40);
}

/** 剪贴板里那张 PNG 的尺寸，从系统那一侧读；不是 PNG 就是 null。 */
function clipboardPng(): { width: number; height: number } | null {
	const file = join(tmpdir(), `plume-clip-${process.pid}.png`);
	try {
		execFileSync("osascript", ["-e", `set png to the clipboard as «class PNGf»
set f to open for access POSIX file "${file}" with write permission
set eof f to 0
write png to f
close access f`], { stdio: "ignore" });
		const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
		return { width: Number(/pixelWidth: (\d+)/.exec(out)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(out)?.[1]) };
	} catch {
		return null;
	} finally {
		execFileSync("rm", ["-f", file]);
	}
}

/** 点开大图、按复制，量剪贴板和提示。 */
async function copyFromViewer(app: RunningApp, capture: (name: string) => Promise<void>, where: string) {
	execFileSync("osascript", ["-e", 'set the clipboard to "plume-before"']);
	const src = await app.evaluate<string>(`${READ_ROW}.querySelector("img").src.slice(0, 24)`);
	await click(app, `main [data-ly-tool] img`);
	await until(app, `document.querySelector('${VIEWER}')`);
	await pause(1200);
	check(`${where}：预览顶栏有「复制图片」`, await app.evaluate<boolean>(`Boolean(document.querySelector('${COPY}'))`), null);
	await capture(`${where}_预览顶栏`);
	const before = await app.evaluate<string>("location.href");
	await click(app, COPY);
	await until(app, `document.body.innerText.includes("已复制到剪贴板") || document.body.innerText.includes("剪贴板不可用")`, 5000).catch(() => {});
	await pause(600);
	const toast = await app.evaluate<string>(`document.body.innerText.includes("已复制到剪贴板") ? "copied" : document.body.innerText.includes("剪贴板不可用") ? "fallback" : "none"`);
	await capture(`${where}_点了复制`);
	const after = await app.evaluate<string>("location.href");
	check(`${where}：窗口没有被导航走（不会变成只剩一张图）`, after === before, after);
	check(`${where}（${src}…）：提示「已复制到剪贴板」，没有退回下载`, toast === "copied", toast);
	const png = clipboardPng();
	check(`${where}：系统剪贴板里是 ${WIDTH}×${HEIGHT} 的 PNG`, png?.width === WIDTH && png?.height === HEIGHT, png);
	await pause(800);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await until(app, `!document.querySelector('${VIEWER}')`);
	await pause(600);
}

/** 把文件塞进输入框的 `<input type="file">`，走人选完文件之后的同一条路（照 attachments-demo）。 */
async function attach(app: RunningApp, path: string, name: string, mime: string): Promise<void> {
	const base64 = (await readFile(path)).toString("base64");
	await app.evaluate(`(() => {
		const bin = atob(${JSON.stringify(base64)});
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const input = document.querySelector('input[type="file"]');
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
}

const TILE_IMG = "main [data-ly-attachment] img";
/** 输入框上的那张，不是对话记录里用户气泡的那张：离 textarea 最近、又不包着对话记录的那一层里找。 */
const COMPOSER_IMG = `[...document.querySelectorAll("${TILE_IMG}")].find((img) => { let n = img; while (n && !n.querySelector?.("textarea")) n = n.parentElement; return n && !n.querySelector("[data-ly-tool]"); })`;

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-viewer-copy-"));
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
	// 先打字再附加：附件进来时在光标处插一枚标记、和它绑在一起，先附加再整段改写文字会把标记连同附件抹掉。
	await d.type("读一下 shot.jpg");
	await attach(app, join(home, "project", "shot.jpg"), "shot.jpg", "image/jpeg");
	await until(app, `document.querySelector('${TILE_IMG}')?.complete`, 300);
	await pause(400);
	await d.submit();
	await d.settled(60000);
	await pause(1000);
	await expand(app);
	await copyFromViewer(app, capture, "会话里_jpeg");
	await stop();

	const sessionId = await app.evaluate<string>(`document.querySelector("[data-ly-row] > button[aria-current]")?.closest("[data-ly-row]")?.getAttribute("data-ly-row") ?? ""`);
	await app.stop();
	app = await startApp({ port: PORT, reuseHome: home });
	await driver(app).until(`document.querySelector("main textarea")`, 60000);
	stop = await startRecording(PORT, frames_);
	await pause(600);
	if (sessionId && !(await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row="${sessionId}"] > button[aria-current]'))`))) await openSession(app, sessionId);
	await expand(app);
	await copyFromViewer(app, capture, "重启后_ly-media");

	// 方向键翻回第一句话：那张附件在转录里只剩 session-media 的文件名，装回输入框前要把像素读回来。
	await click(app, "main textarea");
	await press(app, "ArrowUp", 38);
	await until(app, `${COMPOSER_IMG}?.complete`, 300).catch(() => {});
	await pause(800);
	const tile = await app.evaluate<{ text: string; natural: number; src: string }>(`(() => { const img = ${COMPOSER_IMG}; return { text: document.querySelector("main textarea").value, natural: img?.naturalWidth ?? 0, src: img?.src.slice(0, 22) ?? "" }; })()`);
	await capture("重启后_方向键翻回带图的那句");
	check(`重启后按 ↑ 翻回那句话，附件带着像素回来（缩略图宽 ${WIDTH}）`, tile.text.startsWith("读一下 shot.jpg") && tile.natural === WIDTH && tile.src.startsWith("data:image/"), tile);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_图片预览复制_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
