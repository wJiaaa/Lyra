/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 生成图标注后「保存副本」、递进输入框的图打字后还在、发送时托盘收起——边验边录。
 *
 * 一张 `generate_image` 画出来的图，记录里停进了 session-media，窗口里是 `ly-media://m/…`。那是另一个
 * 源：直接画进画布，画布被污染、`toDataURL` 抛错，标注完点「保存副本」什么也不发生。导出的那张从系统
 * 剪贴板读回来量尺寸、数红色像素，不信页面自己的说法。会覆盖本机剪贴板（文字内容跑完放回去）。
 *
 * 同一张图右键「添加到聊天」：正文是空的，附件没有标记的话，打第一个字就被当孤儿卸掉。发送时托盘的
 * 高度逐帧采样，一帧收没就是那一跳。
 *
 * 用法：node --experimental-strip-types e2e/attach-annotate-demo.ts [before|after] [输出目录]
 */

import { createServer, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, contextClick, dragSelect, openSession, press, typeAtEnd, until } from "./drive.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seedSessions, type FixtureRecord } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume附件与标注测试");
const PORT = 9671;
const SESSION = "attach-annotate";
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const WIDTH = 360;
const HEIGHT = 240;
const NAME = "雪地狐狸.png";

/** 一张蓝绿渐变加噪点的 PNG：没有一个像素是红的，数到红色就只能是标注画上去的。不压缩，保证停进 session-media。 */
function picturePng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < HEIGHT; y++) {
		rows.push(0);
		for (let x = 0; x < WIDTH; x++) rows.push(Math.round(20 + Math.random() * 30), Math.round(90 + (y / HEIGHT) * 100), Math.round(140 + (x / WIDTH) * 100));
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
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows), { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 只会说一句「收到。」的模型：这里量的是输入框和发出去的那条消息，不是回答。 */
const model = createServer((req, res) => {
	req.on("data", () => {});
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, { type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
		sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "收到。" } });
		sse(res, { type: "content_block_stop", index: 0 });
		sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
		sse(res, { type: "message_stop" });
		res.end();
	});
});

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const png = picturePng();
	await writeFile(join(cwd, NAME), png);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const base = Date.now() - 3600_000;
	let clock = base;
	const at = () => (clock += 60_000);
	const messages = [
		{ role: "user", content: [{ type: "text", text: "画一只站在雪地里的狐狸" }], timestamp: at() },
		{ role: "assistant", content: [{ type: "toolCall", id: "g1", name: "generate_image", arguments: { prompt: "a fox in the snow", size: "1536x1024" } }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "toolUse", timestamp: at() },
		{ role: "toolResult", toolCallId: "g1", toolName: "generate_image", content: [{ type: "text", text: "已生成 1 张图" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], isError: false, details: { paths: [join(cwd, NAME)] }, timestamp: at() },
		{ role: "assistant", content: [{ type: "text", text: "画好了。" }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: at() },
	];
	const meta = { id: SESSION, title: "雪地狐狸", cwd, projectId, projectName: "project", createdAt: base, updatedAt: clock, modelId: "qa/model", messageCount: messages.length, usage, seq: 0 };
	const records: FixtureRecord[] = [{ type: "meta", meta, seq: 0, ts: base } as FixtureRecord];
	for (const message of messages) records.push({ type: "message", message, ts: message.timestamp } as FixtureRecord);
	seedSessions(home, [{ meta: meta as never, records }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 60, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "QA", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true, models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		autoSummarizeTitle: false,
		retryAttempts: 0,
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "project", pinned: true, lastOpenedAt: 1 }],
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

/** 剪贴板里那张 PNG，从系统那一侧读出来；不是 PNG 就是 null。 */
function clipboardPng(): Buffer | null {
	const file = join(tmpdir(), `plume-attach-annotate-${process.pid}.png`);
	try {
		execFileSync("osascript", ["-e", `set png to the clipboard as «class PNGf»
set f to open for access POSIX file "${file}" with write permission
set eof f to 0
write png to f
close access f`], { stdio: "ignore" });
		return execFileSync("cat", [file]);
	} catch {
		return null;
	} finally {
		execFileSync("rm", ["-f", file]);
	}
}

const SHOT = 'main [data-ly-canvas="done"]';
const VIEWER = '[role="dialog"][aria-label="图片预览"]';
/** 托盘里还属于这个输入框的图，不算收起时陪着托盘走的那一排。 */
const TILES = `[...document.querySelectorAll("main [data-ly-composer-attachments] [data-ly-attachment]")].filter((tile) => !tile.closest("[data-ly-strip-leaving]")).length`;
const TOAST = (text: string) => `document.querySelector("[data-ly-toaster]")?.innerText.includes(${JSON.stringify(text)})`;

let app: RunningApp | undefined;
const film: Frame[] = [];
const camera = { rolling: true };
let filming: Promise<void> | undefined;
let grab: Awaited<ReturnType<typeof frameGrabber>> | undefined;
let shot = 0;
let clipboardText: string | null = null;

try {
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("model server has no port");
	try {
		clipboardText = execFileSync("pbpaste", { encoding: "utf8" });
	} catch {
		clipboardText = null;
	}
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	const page = app;
	await page.send("Page.bringToFront");
	await page.evaluate("document.fonts.ready");
	grab = await frameGrabber(PORT);
	const grabber = grab;
	// 逐帧拍而不是 screencast：别的窗口盖在前面时被盖住的窗口不合成，screencast 只给第一帧。
	filming = (async () => {
		while (camera.rolling) film.push({ at: Date.now(), data: await grabber.shot() });
	})();
	const capture = async (name: string) => {
		const { data } = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};

	await until(page, `document.querySelector("main textarea")`, 3600);
	await openSession(page, SESSION);
	await until(page, `document.querySelector('${SHOT} img')?.complete`, 1200);
	await pause(800);

	// ---- 一、标注生成的图，保存副本 ----
	const src = await page.evaluate<string>(`document.querySelector('${SHOT} img').src`);
	check("生成图在窗口里是 ly-media://m/ 地址（停进了 session-media）", src.startsWith("ly-media://m/"), src.slice(0, 40));
	const tainted = await page.evaluate<string>(`new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
			canvas.getContext("2d").drawImage(img, 0, 0);
			try { canvas.toDataURL(); resolve("readable"); } catch (error) { resolve(error.name); }
		};
		img.onerror = () => resolve("load failed");
		img.src = ${JSON.stringify(src.replace(/\?.*$/, ""))};
	})`);
	check("根因仍在：ly-media 地址直接画进画布，toDataURL 抛 SecurityError", tainted === "SecurityError", tainted);
	await capture("会话里的生成图");

	await click(page, SHOT);
	await until(page, `document.querySelector('${VIEWER}')`);
	await pause(900);
	await click(page, `${VIEWER} button`, "标注");
	await until(page, `document.querySelector('${VIEWER} canvas')?.width === ${WIDTH}`, 600);
	await pause(600);
	await click(page, "button", "矩形", "starts");
	const box = await page.evaluate<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector('${VIEWER} canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
	await dragSelect(page, { x: box.x + box.w * 0.25, y: box.y + box.h * 0.25 }, { x: box.x + box.w * 0.75, y: box.y + box.h * 0.75 }, 16);
	await pause(700);
	await capture("画了一个矩形");
	execFileSync("osascript", ["-e", 'set the clipboard to "plume-before"']);
	await click(page, "button", "保存副本");
	await until(page, `${TOAST("已复制到剪贴板")} || ${TOAST("没能导出")}`, 300).catch(() => {});
	await pause(900);
	await capture("点了保存副本");
	const copied = await page.evaluate<boolean>(`Boolean(${TOAST("已复制到剪贴板")})`);
	check("点「保存副本」有回应：提示已复制到剪贴板", copied, await page.evaluate<string>(`document.querySelector("[data-ly-toaster]")?.innerText ?? ""`));
	const png = clipboardPng();
	const exported = png
		? await page.evaluate<{ width: number; height: number; red: number }>(`new Promise((resolve) => {
			const img = new Image();
			img.onload = () => {
				const canvas = document.createElement("canvas");
				canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
				const context = canvas.getContext("2d");
				context.drawImage(img, 0, 0);
				const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
				let red = 0;
				for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 120 && data[i + 2] < 120) red++;
				resolve({ width: img.naturalWidth, height: img.naturalHeight, red });
			};
			img.onerror = () => resolve({ width: 0, height: 0, red: 0 });
			img.src = "data:image/png;base64,${png.toString("base64")}";
		})`)
		: null;
	check(`系统剪贴板里是 ${WIDTH}×${HEIGHT} 的 PNG`, exported?.width === WIDTH && exported?.height === HEIGHT, exported);
	check("导出的图里有标注：红色像素超过 300 个（原图一个红像素也没有）", (exported?.red ?? 0) > 300, exported?.red);
	// 保存没成功时查看器还停在标注里：Esc 先退出标注，再关查看器。
	for (let tries = 0; tries < 4 && (await page.evaluate<boolean>(`Boolean(document.querySelector('${VIEWER}'))`)); tries++) {
		await press(page, "Escape", 27);
		await pause(600);
	}
	await until(page, `!document.querySelector('${VIEWER}')`, 300);
	await pause(800);

	// ---- 二、右键「添加到聊天」，接着打字 ----
	await contextClick(page, SHOT);
	await pause(500);
	await click(page, '[role="menuitem"]', "添加到聊天");
	await until(page, `${TILES} === 1`, 600).catch(() => {});
	await pause(900);
	const handed = await page.evaluate<string>(`document.querySelector("main textarea").value`);
	check("递进来的图在句子里落了标记", handed.includes(`【${NAME}】`), handed);
	await capture("添加到聊天之后");
	await typeAtEnd(page, "main textarea", "照这个改成黄昏");
	await pause(900);
	const typed = await page.evaluate<{ text: string; tiles: number }>(`({ text: document.querySelector("main textarea").value, tiles: ${TILES} })`);
	check("打了字以后图还在托盘里", typed.tiles === 1, typed);
	check("正文是标记加上打的字", typed.text.includes(`【${NAME}】`) && typed.text.endsWith("照这个改成黄昏"), typed.text);
	await capture("打字之后图还在");

	// ---- 三、发送：消息带着图 ----
	await press(page, "Enter", 13);
	await pause(600);
	await until(page, `!document.querySelector('button[aria-label="停止"]')`, 1200).catch(() => {});
	await pause(1200);
	const sent = await page.evaluate<{ images: number; text: string; names: string[] }>(`(async () => {
		const snapshot = await window.plume.sessions.transcript(${JSON.stringify(SESSION)});
		const last = snapshot.messages.filter((m) => m.role === "user").at(-1);
		return {
			images: last.content.filter((part) => part.type === "image").length,
			text: last.displayText ?? "",
			names: (last.attachments ?? []).map((file) => file.name),
		};
	})()`);
	check("发出去的消息带着那张图", sent.images === 1 && sent.names.includes(NAME), sent);
	await capture("发送之后");
	await pause(800);

	// ---- 四、从「+」选进一张图再发送：托盘逐帧收起 ----
	// 走选文件那条路，和递进来的那条无关：量的只是托盘怎么收。
	await typeAtEnd(page, "main textarea", "再看一张");
	const bytes = picturePng().toString("base64");
	await page.evaluate(`(() => {
		const bin = atob(${JSON.stringify(bytes)});
		const data = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
		const input = document.querySelector('main input[type="file"]');
		const transfer = new DataTransfer();
		transfer.items.add(new File([data], "第二张.png", { type: "image/png" }));
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
	await until(page, `${TILES} === 1`, 600);
	await pause(1200);
	await page.evaluate(`(() => {
		const tray = document.querySelector("main [data-ly-composer-attachments]");
		const start = performance.now();
		window.__trayHeights = [tray.getBoundingClientRect().height];
		window.__trayTimes = [0];
		const sample = () => {
			window.__trayHeights.push(tray.getBoundingClientRect().height);
			window.__trayTimes.push(Math.round(performance.now() - start));
			if (performance.now() - start < 1200) requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	})()`);
	await press(page, "Enter", 13);
	await pause(1500);
	const heights = await page.evaluate<number[]>(`window.__trayHeights.map((h) => Math.round(h * 10) / 10)`);
	const times = await page.evaluate<number[]>(`window.__trayTimes`);
	const open = heights[0];
	let biggest = 0;
	for (let i = 1; i < heights.length; i++) biggest = Math.max(biggest, heights[i - 1] - heights[i]);
	biggest = Math.round(biggest * 10) / 10;
	const between = heights.filter((h) => h > 0.5 && h < open - 0.5).length;
	console.log(`   托盘高度逐帧（毫秒:像素）：${heights.slice(0, 30).map((h, i) => `${times[i]}:${h}`).join(" → ")}${heights.length > 30 ? " …" : ""}`);
	check(`发送时托盘不是一帧收没：${open}px 分 ${between} 帧收起，单帧最大落差 ${biggest}px`, open > 0 && between >= 4 && biggest < open / 2 && heights.at(-1)! < 0.5, { open, between, biggest, last: heights.at(-1) });
	await until(page, `!document.querySelector('button[aria-label="停止"]')`, 1200).catch(() => {});
	await pause(1200);
	await capture("第二次发送之后");
} finally {
	camera.rolling = false;
	await filming?.catch(() => {});
	grab?.close();
	await app?.stop();
	await closeListeningServer(model);
	if (clipboardText !== null) execFileSync("pbcopy", { input: clipboardText });
}

const passed = checks.filter((c) => c.ok).length;
if (film.length > 0) await encode(film, join(OUT_DIR, `${STAMP}_${LABEL}_附件与标注_${passed}of${checks.length}.mp4`), 30);
console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
if (passed !== checks.length) process.exitCode = 1;
