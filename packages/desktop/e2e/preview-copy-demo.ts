/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * Copying an agent's page as a picture takes the whole page, not the part the card shows.
 *
 * The model is scripted: it puts up a page of twenty numbered stripes, 100px each, far taller than the
 * card folds at. The reader presses the button at the top of the page, which whitens the last stripe —
 * below the fold, nowhere on screen — then copies. What lands on the clipboard is checked stripe by
 * stripe: every stripe in order, each boundary where the page has it (so the slices met without a gap
 * or an overlap), the last one white (the page as the reader left it, not reloaded), and the card's
 * own buttons nowhere on it. Afterwards the card, the page and the transcript are where they were.
 *
 * Usage: node --experimental-strip-types e2e/preview-copy-demo.ts [label]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, evaluateRenderer, startApp, type RunningApp } from "./app.ts";
import { clickInFrame } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "改动后";
const OUT_DIR = join(homedir(), "Desktop", "Plume复制整页测试");
const PORT = 9497;
const INSPECT_PORT = 9498;
const MODEL_PORT = 9599;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const STRIPES = 20;
const STRIPE = 100;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.s{height:${STRIPE}px;display:flex;align-items:center;padding-left:12px;box-sizing:border-box;color:#000;font:600 14px system-ui}
button{font:inherit}
</style></head><body>${Array.from({ length: STRIPES }, (_, i) => `<div class="s" id="s${i}" style="background:hsl(${i * 18} 80% 55%)">${i === 0 ? '<button id="b">把最底下一条刷白</button>' : `第 ${i + 1} 条`}</div>`).join("")}
<script>document.getElementById("b").addEventListener("click",function(){document.getElementById("s${STRIPES - 1}").style.background="#fff"})</script></body></html>`;

let app: RunningApp;
let model: Server;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", async () => {
			const first = request++ === 0;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			await pause(300);
			if (first) {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_1", name: "preview", input: {} } });
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ title: "色带", html: PAGE }) } });
			} else {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "二十条色带。" } });
			}
			sse(res, { type: "content_block_stop", index: 0 });
			sse(res, { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } });
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
		appearance: { theme: "dark" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

const CARD = "main [data-ly-preview]";
const FRAME = `${CARD} iframe`;
const button = (label: string) => `${CARD} button[aria-label="${label}"]`;

/** The page's own document, through its own DevTools target: the frame is another origin, often another process. */
async function inFrame<T>(expression: string): Promise<T> {
	const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const target = list.find((entry) => entry.type === "iframe" && entry.url.startsWith("ly-preview://"));
	if (!target) throw new Error("没有找到预览的 iframe target");
	return evaluateRenderer<T>(target.webSocketDebuggerUrl, expression);
}

/** The card, its frame and the transcript scroller it sits in: what a copy must leave as it found them. */
const LAYOUT = `(() => {
	const card = document.querySelector(${JSON.stringify(CARD)}), frame = card.querySelector("iframe");
	let scroller = card.parentElement; while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
	return { card: Math.round(card.getBoundingClientRect().height), frame: Math.round(frame.getBoundingClientRect().height), style: frame.style.height + frame.style.transform, scroll: Math.round(scroller.scrollTop), width: frame.getBoundingClientRect().width };
})()`;

/** One column of a PNG, every device row of it, as RGB. */
async function column(base64: string, x: number): Promise<{ w: number; h: number; rgb: number[][] }> {
	return app.evaluate(`(async () => {
		const image = new Image(); image.src = "data:image/png;base64,${base64}"; await image.decode();
		const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
		const data = ctx.getImageData(Math.round(image.naturalWidth * ${x}), 0, 1, image.naturalHeight).data, rgb = [];
		for (let y = 0; y < image.naturalHeight; y++) rgb.push([data[y * 4], data[y * 4 + 1], data[y * 4 + 2]]);
		return { w: image.naturalWidth, h: image.naturalHeight, rgb };
	})()`);
}

const parse = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number);
const distance = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const nearest = (rgb: number[], palette: number[][]) => palette.reduce((best, colour, index) => (distance(rgb, colour) < distance(rgb, palette[best]) ? index : best), 0);

async function shoot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from(data, "base64"));
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2, inspectPort: INSPECT_PORT });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		console.log(`【${LABEL}】一、让 agent 做一个比卡片高得多的页面`);
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(800);
		await d.type("做二十条色带");
		await pause(400);
		await d.submit();
		await d.settled(120000);
		await d.until(`document.querySelector(${JSON.stringify(FRAME)})?.style.opacity !== "0" && document.querySelector(${JSON.stringify(CARD)})?.getBoundingClientRect().height > 100`, 20000);
		await pause(1200);
		// The transcript stops at its end, with the page's top — its button, the card's own — above the view.
		await app.evaluate(`document.querySelector(${JSON.stringify(CARD)}).scrollIntoView({ block: "start" })`);
		await pause(800);
		const before = await app.evaluate<{ card: number; frame: number; style: string; scroll: number; width: number }>(LAYOUT);
		check(`卡片折在 720px，页面本身 ${STRIPES * STRIPE}px`, before.card <= 722, JSON.stringify(before));
		await shoot("01_页面折着");

		console.log(`【${LABEL}】二、在页面里点一下：折线以下的最后一条刷白`);
		await clickInFrame(app, FRAME, { x: 40, y: STRIPE / 2 });
		await pause(500);
		const last = await inFrame<string>(`getComputedStyle(document.getElementById("s${STRIPES - 1}")).backgroundColor`);
		check("页面里最后一条成了白色", last === "rgb(255, 255, 255)", last);

		console.log(`【${LABEL}】三、复制为图片`);
		await d.hover(FRAME);
		await pause(400);
		await d.click(button("复制为图片"));
		await d.until(`document.querySelector(${JSON.stringify(button("已复制为图片"))})`, 10000).catch(() => {});
		const tick = await app.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(button("已复制为图片"))}))`);
		check("按下后按钮换成对钩「已复制为图片」", tick, "没有变");
		await shoot("02_复制之后");
		const copied = await app.main<string>(`process._linkedBinding("electron_common_clipboard").readImage().toPNG().toString("base64")`);
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_03_剪贴板里的图.png`), Buffer.from(copied, "base64"));

		const palette = await inFrame<string[]>(`[...document.querySelectorAll(".s")].map((s) => getComputedStyle(s).backgroundColor)`).then((list) => list.map(parse));
		const middle = await column(copied, 0.5);
		const scale = middle.w / before.width;
		check(
			`图是整页：${STRIPES * STRIPE}px 高（2 倍像素约 ${STRIPES * STRIPE * 2}），不是折起来的 720`,
			middle.h >= STRIPES * STRIPE * scale && middle.h <= (STRIPES * STRIPE + 4) * scale,
			`${middle.w}×${middle.h}`,
		);
		const labels = middle.rgb.slice(0, Math.floor(STRIPES * STRIPE * scale)).map((rgb) => nearest(rgb, palette));
		const order = labels.filter((label, index) => index === 0 || label !== labels[index - 1]);
		check(`二十条从上到下按顺序都在，没有缺也没有重复`, order.join(",") === palette.map((_, index) => index).join(","), order.join(","));
		const edges = palette.slice(1).map((_, index) => labels.indexOf(index + 1) - (index + 1) * STRIPE * scale);
		const worst = Math.max(...edges.map(Math.abs));
		check("每条的分界都在页面上的位置（误差 ≤ 2 设备像素）：拼接处没有错位", worst <= 2, edges.join(","));
		const white = middle.rgb[Math.round((STRIPES - 0.5) * STRIPE * scale)];
		check("最后一条在图里是白的：截的是点过之后的页面", white.every((value) => value > 245), white.join(","));
		const corner = await column(copied, 0.97);
		const top = corner.rgb.slice(0, Math.round(STRIPE * scale * 0.6)).map((rgb) => distance(rgb, palette[0]));
		check("右上角就是第一条的颜色，卡片自己那排按钮不在图上", Math.max(...top) < 30, Math.max(...top).toFixed(1));

		const after = await app.evaluate<{ card: number; frame: number; style: string; scroll: number; width: number }>(LAYOUT);
		check("复制完卡片、页面框、对话的滚动位置都和原来一样", after.card === before.card && after.frame === before.frame && after.style === "" && after.scroll === before.scroll, JSON.stringify({ before, after }));
		const still = await inFrame<string>(`getComputedStyle(document.getElementById("s${STRIPES - 1}")).backgroundColor`);
		check("页面没有重新载入，最后一条还是白的", still === "rgb(255, 255, 255)", still);
		await pause(1200);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_复制整页_${passed}of${checks.length}.mp4`);
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
