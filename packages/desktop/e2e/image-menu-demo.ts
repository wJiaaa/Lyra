/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 会话里生成图的右键菜单——边验边录。顺带守住「运行中的工具行，鼠标移入时文字消失」。
 *
 * 假服务照搬 generate-image-demo：对话模型按剧本调 `image_generate`，出图端点回一张 PNG。
 * 出图那几秒里展开过程、把鼠标移到那一行上，拍下前后两张；画完重启，让图走 `ly-media://m/`，
 * 再对它右键把菜单每一项点一遍。剪贴板从 macOS 那一侧读回来量尺寸，会覆盖本机剪贴板；
 * 「下载副本」拦下 `<a>` 的点击只量它要下载什么，不弹保存框；「在访达中显示」只验它在菜单里。
 *
 * 用法：node --experimental-strip-types e2e/image-menu-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, contextClick, frames, hover, openSession, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume生成图右键菜单测试");
const PORT = 9442;
const MODEL_PORT = 9542;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SIZE = 512;
const PROMPT = "一只站在雪地里的红狐狸，水彩风格，远处是覆着薄雪的松林和低低的冬日太阳，前景有几串狐狸的脚印一路延伸到画面外，整体色调偏暖，留白多一些";

/** 一张带噪点的对角渐变 PNG，当作「画出来的图」；噪点让它超过内联上限，重启后走 `ly-media://m/`。 */
function gradientPng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < SIZE; y++) {
		rows.push(0);
		for (let x = 0; x < SIZE; x++) rows.push(...[180 + (x / SIZE) * 50, 80 + (y / SIZE) * 120, 50 + ((x + y) / (2 * SIZE)) * 160].map((v) => Math.round(v + Math.random() * 25)));
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
	ihdr.writeUInt32BE(SIZE, 0);
	ihdr.writeUInt32BE(SIZE, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [
	[{ text: "好，我来画。" }, { tool: "image_generate", args: { prompt: PROMPT, aspect_ratio: "1:1" } }],
	[{ text: "画好了，图在上面。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const imageRequests: Record<string, unknown>[] = [];
const modelBodies: string[] = [];

function startModel(): Server {
	let request = 0;
	const png = gradientPng().toString("base64");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			if (req.url?.endsWith("/images/generations")) {
				imageRequests.push({ ...JSON.parse(body), authorization: req.headers.authorization });
				// 够长才拍得到、量得到生成中的那块画布。
				await pause(9000);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ b64_json: png }] }));
				return;
			}
			// 起标题的请求不带工具；拿剧本回答它会吃掉一步。
			const titling = !body.includes('"tools"');
			const blocks: Block[] = titling ? [{ text: "画狐狸" }] : SCRIPT[Math.min(request, SCRIPT.length - 1)];
			if (!titling) {
				request++;
				modelBodies.push(body);
			}
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
		...(LABEL === "before" ? {} : { imageModelId: "img/gpt-image-1" }),
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

const IMAGE = "main [data-ly-canvas] img";
const MENU_ITEM = '[role="menuitem"]';
const ITEMS = ["在新标签页中打开图片", "添加到聊天", "复制图片", "在访达中显示", "下载副本"];

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

async function openMenu(app: RunningApp) {
	await contextClick(app, IMAGE);
	await until(app, `document.querySelector('${MENU_ITEM}')`);
	await pause(700);
}

async function choose(app: RunningApp, name: string) {
	await click(app, MENU_ITEM, name);
	await until(app, `!document.querySelector('${MENU_ITEM}')`);
}

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-image-menu-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await d.until(`document.querySelector("main textarea")`, 60000);

	// —— 一、运行中的工具行，鼠标移入 ——
	let stop = await startRecording(PORT, frames_);
	await pause(600);
	await d.type("画一只雪地里的红狐狸");
	await d.submit();
	await until(app, `document.querySelector('main [data-ly-canvas="pending"]')`, 900);
	const ROW = 'main [data-ly-tool="running"] button';
	await until(app, `document.querySelector('${ROW}')`, 400);
	await pause(1500);
	const SUMMARY = 'main [data-ly-tool="running"] .ly-flow-summary';
	const state = () => app!.evaluate<{ hovered: boolean; marquee: string | null; glide: string | null }>(`(() => {
		const s = document.querySelector('${SUMMARY}');
		const track = s?.querySelector(".ly-marquee-track");
		const glide = s?.querySelector(".ly-glide:not([data-ly-scroll-dup])");
		return { hovered: Boolean(document.querySelector('${ROW}:hover')), marquee: track ? getComputedStyle(track).animationName : null, glide: glide ? getComputedStyle(glide).animationName : null };
	})()`);
	/** 只拍摘要那一块，返回像素的哈希；顺手存一张整行的图给人看。 */
	const summaryHash = async () => {
		const clip = await app!.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('${SUMMARY}').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
		return createHash("sha1").update(data).digest("hex");
	};
	const captureRow = async (name: string) => {
		const clip = await app!.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('${ROW}').getBoundingClientRect(); return { x: r.x, y: r.y - 4, width: r.width, height: r.height + 8 }; })()`);
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await captureRow("运行中_未悬停_工具行");
	await hover(app, ROW);
	await pause(1500);
	const hovered = await state();
	const shown = await summaryHash();
	await app.evaluate(`document.querySelector('${SUMMARY}').style.visibility = "hidden"`);
	const blank = await summaryHash();
	await app.evaluate(`document.querySelector('${SUMMARY}').style.visibility = ""`);
	await captureRow("运行中_悬停_工具行");
	check("运行中、摘要装不下的工具行，悬停滚动时字还在（摘要区域和把它藏起来时的像素不同）", hovered.hovered && hovered.marquee === "ly-marquee" && shown !== blank, { hovered, same: shown === blank });
	check("悬停滚动时，扫光仍挂在字上并在动", hovered.glide === "ly-glide", hovered);
	// 对照：页面上把扫光挂回外层（修复前的写法），同样悬停着再量一次——这一次两张应当一样，断言才算抓得住它。
	await app.evaluate(`(() => { const s = document.querySelector('${SUMMARY}'); s.querySelectorAll(".ly-glide").forEach((e) => e.classList.remove("ly-glide")); s.classList.add("ly-glide"); })()`);
	await frames(app, 10);
	const oldShown = await summaryHash();
	await app.evaluate(`document.querySelector('${SUMMARY}').style.visibility = "hidden"`);
	const oldBlank = await summaryHash();
	await app.evaluate(`document.querySelector('${SUMMARY}').style.visibility = ""`);
	await captureRow("对照_扫光挂回外层_悬停_工具行");
	check("对照：扫光挂回外层时，同样悬停，摘要区域和藏起来时一模一样（这就是那个 bug）", oldShown === oldBlank, { same: oldShown === oldBlank });
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 400 });
	await d.settled(60000);
	await pause(800);
	await stop();

	// —— 二、重启，图走 ly-media，右键菜单 ——
	const sessionId = await app.evaluate<string>(`document.querySelector("[data-ly-row] > button[aria-current]")?.closest("[data-ly-row]")?.getAttribute("data-ly-row") ?? ""`);
	await app.stop();
	app = await startApp({ port: PORT, reuseHome: home });
	await driver(app).until(`document.querySelector("main textarea")`, 60000);
	stop = await startRecording(PORT, frames_);
	if (sessionId && !(await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row="${sessionId}"] > button[aria-current]'))`))) await openSession(app, sessionId);
	await until(app, `document.querySelector('${IMAGE}')?.complete`, 400);
	await frames(app, 30);
	const src = await app.evaluate<string>(`document.querySelector('${IMAGE}').src.slice(0, 20)`);
	console.log("重启后图的地址：", src);

	await openMenu(app);
	const items = await app.evaluate<string[]>(`[...document.querySelectorAll('${MENU_ITEM}')].map((e) => e.innerText.trim())`);
	await capture("右键菜单");
	check(`右键弹出五项：${ITEMS.join(" / ")}`, JSON.stringify(items) === JSON.stringify(ITEMS), items);

	execFileSync("osascript", ["-e", 'set the clipboard to "plume-before"']);
	await choose(app, "复制图片");
	await until(app, `document.body.innerText.includes("已复制到剪贴板") || document.body.innerText.includes("剪贴板不可用")`, 300).catch(() => {});
	const copied = await app.evaluate<boolean>(`document.body.innerText.includes("已复制到剪贴板")`);
	await capture("复制图片后");
	const png = clipboardPng();
	check(`复制图片（${src}…）：提示已复制，系统剪贴板里是 ${SIZE}×${SIZE} 的 PNG`, copied && png?.width === SIZE && png.height === SIZE, { copied, png });
	await pause(1500);

	await app.evaluate(`(() => { window.__download = null; HTMLAnchorElement.prototype.click = function () { window.__download = { href: this.href.slice(0, 22), name: this.download }; }; })()`);
	await openMenu(app);
	await choose(app, "下载副本");
	await until(app, `window.__download`, 300);
	const download = await app.evaluate<{ href: string; name: string } | null>(`window.__download`);
	check(`下载副本：交给下载的是 PNG 的 data URL，文件名带存的日期时间（${download?.name}），窗口没被导航走`, download?.href === "data:image/png;base64," && /^plume-image-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/.test(download.name) && (await app.evaluate<boolean>(`location.protocol === "file:"`)), download);

	await openMenu(app);
	await choose(app, "添加到聊天");
	await until(app, `document.querySelector("main [data-ly-attachment] img")?.complete`, 300).catch(() => {});
	const attached = await app.evaluate<{ count: number; natural: number }>(`(() => { const tiles = document.querySelectorAll("main [data-ly-attachment]"); const img = document.querySelector("main [data-ly-attachment] img"); return { count: tiles.length, natural: img?.naturalWidth ?? 0 }; })()`);
	await pause(800);
	await capture("添加到聊天后");
	check("添加到聊天：输入框上多了一张附件，缩略图有像素", attached.count === 1 && attached.natural > 0, attached);

	await openMenu(app);
	await choose(app, "在新标签页中打开图片");
	const PANE_IMG = `[...document.querySelectorAll("img")].find((img) => img.src.startsWith("ly-media://f/") && img.naturalWidth === ${SIZE})`;
	const opened = await until(app, PANE_IMG, 600).then(() => true, () => false);
	await pause(1200);
	const unreadable = await app.evaluate<boolean>(`document.body.innerText.includes("读不到这个文件")`);
	await capture("在新标签页中打开图片后");
	check(`在新标签页中打开图片：右侧面板画出了那张 ${SIZE}px 的图，没有「读不到这个文件」`, opened && !unreadable, { opened, unreadable });
	await pause(1000);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_生成图右键菜单_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
