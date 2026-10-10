/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * What a reader can do with an agent's page once it is up, in a real window, recorded while it is checked.
 *
 * The model is scripted: it puts up a small player mock-up and answers. Then the reader
 * - copies the page as a picture, and what lands on the clipboard is compared with the card on screen —
 *   the page as it is now, without the card's own buttons on it;
 * - moves the page's volume and asks a question: the model gets the volume with it, the bubble only the
 *   question, and the page reopens at that volume;
 * - adjusts the design from the card's panel: the page follows each control, shows its original while
 *   asked to, and what is sent says exactly what changed.
 *
 * Usage: node --experimental-strip-types e2e/preview-page-tools-demo.ts [label]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, evaluateRenderer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "改动后";
const OUT_DIR = join(homedir(), "Desktop", "Plume页面工具测试");
const PORT = 9495;
const INSPECT_PORT = 9496;
const MODEL_PORT = 9597;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const ANSWER = "这是一版播放器卡片。";
const QUESTION = "现在音量是多少？";
const STATE_ANSWER = "音量调大了。";
const TWEAK_ANSWER = "好，照这组改。";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.wrap{display:grid;gap:14px;max-width:420px}
#player{--accent:#7c3aed;background:var(--card);border-radius:18px;padding:18px;display:grid;gap:12px}
#player h3{margin:0;font-size:15px}
#player .bar{height:6px;border-radius:3px;background:var(--muted)}
#player .fill{height:6px;border-radius:3px;background:var(--accent);width:40%}
#player button{font:inherit;color:#fff;background:var(--accent);border:0;border-radius:999px;padding:6px 16px;cursor:pointer;justify-self:start}
label{display:flex;gap:10px;align-items:center;color:var(--muted-foreground)}
</style></head><body><div class="wrap">
<div id="player"><h3>夜航</h3><div class="bar"><div class="fill" id="fill"></div></div><button id="play">播放</button></div>
<label>音量 <input id="volume" type="range" min="0" max="100" value="40"><output id="value">40</output></label>
</div><script>
var volume=document.getElementById("volume"),value=document.getElementById("value"),fill=document.getElementById("fill"),player=document.getElementById("player");
function show(v){volume.value=v;value.textContent=v;fill.style.width=v+"%"}
show(plume.state&&typeof plume.state.volume==="number"?plume.state.volume:40);
volume.addEventListener("input",function(){show(volume.value)});
volume.addEventListener("change",function(){plume.setState({volume:Number(volume.value)})});
var look={radius:18,accent:"#7c3aed",compact:false};
function render(){player.style.borderRadius=look.radius+"px";player.style.setProperty("--accent",look.accent);player.style.padding=look.compact?"10px":"18px"}
render();
plume.tweak({label:"播放器",onChange:render}).slider(look,"radius",{label:"圆角",min:0,max:40,unit:"px"}).color(look,"accent",{label:"主色"}).toggle(look,"compact",{label:"紧凑"});
</script></body></html>`;

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: ((body: string) => Block[])[] = [
	() => [{ tool: "preview", args: { title: "播放器", html: PAGE } }],
	() => [{ text: ANSWER }],
	() => [{ text: STATE_ANSWER }],
	() => [{ text: TWEAK_ANSWER }],
];

let app: RunningApp;
let model: Server;
const bodies: string[] = [];
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
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const body = Buffer.concat(chunks).toString("utf8");
			bodies.push(body);
			const blocks = SCRIPT[Math.min(request, SCRIPT.length - 1)](body);
			request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(400);
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
		appearance: { theme: "dark" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

const CARD = "main [data-ly-preview]";
const button = (label: string) => `${CARD} button[aria-label="${label}"]`;

interface Box { x: number; y: number; w: number; h: number }
const cardBox = () => app.evaluate<Box>(`(() => { const r = document.querySelector(${JSON.stringify(CARD)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

/** Size and pixels of a PNG, read in the renderer: width, height, and the RGB of every pixel at a stride. */
async function pixels(base64: string, crop?: Box, scale = 1): Promise<{ w: number; h: number; rgb: number[] }> {
	return app.evaluate(`(async () => {
		const image = new Image(); image.src = "data:image/png;base64,${base64}"; await image.decode();
		const c = ${crop ? JSON.stringify({ x: Math.round(crop.x * scale), y: Math.round(crop.y * scale), w: Math.round(crop.w * scale), h: Math.round(crop.h * scale) }) : "{ x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight }"};
		const canvas = document.createElement("canvas"); canvas.width = c.w; canvas.height = c.h;
		const ctx = canvas.getContext("2d"); ctx.drawImage(image, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
		const data = ctx.getImageData(0, 0, c.w, c.h).data, rgb = [];
		for (let y = 0; y < c.h; y += 4) for (let x = 0; x < c.w; x += 4) { const i = (y * c.w + x) * 4; rgb.push(data[i], data[i + 1], data[i + 2]); }
		return { w: c.w, h: c.h, rgb };
	})()`);
}

/** The page's own document, through its own DevTools target: the frame is another origin, often another process. */
async function inFrame<T>(expression: string): Promise<T> {
	const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const target = list.find((entry) => entry.type === "iframe" && entry.url.startsWith("ly-preview://"));
	if (!target) throw new Error("没有找到预览的 iframe target");
	return Promise.race([
		evaluateRenderer<T>(target.webSocketDebuggerUrl, expression),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("页面没有在 3 秒内回答")), 3000)),
	]);
}

/** A real click at a point, in window coordinates. */
async function clickAt(x: number, y: number) {
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
		await app.send("Input.dispatchMouseEvent", { type, x, y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
	}
}

/** Click a range input at `ratio` of its travel, the way a pointer would: on the track where that value sits. */
async function clickRange(rect: Box, ratio: number) {
	await clickAt(rect.x + 7 + ratio * (rect.w - 14), rect.y + rect.h / 2);
}

/** The last user message the model was sent, as text. */
function lastUserText(body: string): string {
	try {
		const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
		const last = messages.findLast((message) => message.role === "user");
		const content = last?.content;
		return typeof content === "string" ? content : Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : "";
	} catch {
		return "";
	}
}

const PLAYER = `(() => { const s = getComputedStyle(document.getElementById("player")); return { radius: s.borderTopLeftRadius, padding: s.paddingTop, accent: s.getPropertyValue("--accent").trim() }; })()`;

const meanDiff = (a: number[], b: number[]) => (a.length !== b.length ? 255 : a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length);

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
		console.log(`【${LABEL}】一、让 agent 做一个播放器卡片`);
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(800);
		await d.type("做一个播放器卡片");
		await pause(400);
		await d.submit();
		await d.settled(120000);
		await d.until(`document.querySelector(${JSON.stringify(`${CARD} iframe`)})?.style.opacity !== "0" && document.querySelector(${JSON.stringify(CARD)})?.getBoundingClientRect().height > 100`, 20000);
		await pause(1200);
		await shoot("01_页面出来了");

		console.log(`【${LABEL}】二、复制为图片`);
		await d.hover(`${CARD} iframe`);
		await pause(400);
		await d.click(button("复制为图片"));
		await d.until(`document.querySelector(${JSON.stringify(button("已复制为图片"))})`, 5000).catch(() => {});
		const tick = await app.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(button("已复制为图片"))}))`);
		check("按下后按钮换成对钩「已复制为图片」", tick, "没有变");
		await pause(600);
		const copied = await app.main<string>(`process._linkedBinding("electron_common_clipboard").readImage().toPNG().toString("base64")`);
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_02_剪贴板里的图.png`), Buffer.from(copied, "base64"));
		const box = await cardBox();
		// The buttons are faint but on screen; hide them for the reference shot, as the copy did.
		await app.evaluate(`document.querySelector(${JSON.stringify(`${CARD} .ly-glass-solid`)}).style.visibility = "hidden"`);
		await pause(200);
		const { data: screen } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await app.evaluate(`document.querySelector(${JSON.stringify(`${CARD} .ly-glass-solid`)}).style.visibility = ""`);
		const got = await pixels(copied);
		const want = await pixels(screen, box, 2);
		check("剪贴板里是图片，尺寸就是卡片（2 倍像素）", Math.abs(got.w - want.w) <= 2 && Math.abs(got.h - want.h) <= 2, `${got.w}×${got.h} vs 卡片 ${want.w}×${want.h}`);
		const diff = got.w === want.w && got.h === want.h ? meanDiff(got.rgb, want.rgb) : 255;
		check("图里就是屏幕上的卡片，不带右上角那排按钮（逐像素平均差 < 3）", diff < 3, `平均差 ${diff.toFixed(2)}`);
		await pause(800);

		console.log(`【${LABEL}】三、在页面里调音量，再问一句`);
		const frameBox = await app.evaluate<Box>(`(() => { const r = document.querySelector(${JSON.stringify(`${CARD} iframe`)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
		const range = await inFrame<Box>(`(() => { const r = document.getElementById("volume").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
		await clickRange({ ...range, x: frameBox.x + range.x, y: frameBox.y + range.y }, 0.8);
		await pause(800);
		const volume = await inFrame<string>(`document.getElementById("volume").value`);
		// Wherever the native thumb's inset put the click; what matters is that it moved, and that this value is what travels.
		check("页面里的音量从 40 拖到了 80 上下", Math.abs(Number(volume) - 80) <= 3, volume);
		await shoot("03_音量调大");
		await d.type(QUESTION);
		await pause(400);
		await d.submit();
		await d.until(`[...document.querySelectorAll("main p")].some((p) => p.innerText.includes(${JSON.stringify(STATE_ANSWER)}))`, 30000);
		await pause(800);
		const told = lastUserText(bodies[2] ?? "");
		check("模型收到了问题和页面状态", told.includes(QUESTION) && told.includes(`<page-state page="播放器">{"volume":${volume}}</page-state>`), told.slice(-200));
		const transcript = await app.evaluate<string>(`document.querySelector("main").innerText`);
		check("气泡里只有人打的那句话，状态不露出来", transcript.includes(QUESTION) && !transcript.includes("page-state") && !transcript.includes('"volume"'), transcript.slice(0, 300));
		await shoot("04_问完");

		await d.hover(`${CARD} iframe`);
		await pause(300);
		await d.click(button("重新运行"));
		await pause(1500);
		const reopened = await inFrame<string>(`document.getElementById("volume").value`).catch((error: unknown) => String(error));
		check(`页面重新运行后音量还在 ${volume}`, reopened === volume, reopened);

		console.log(`【${LABEL}】四、调整设计`);
		await d.hover(`${CARD} iframe`);
		await pause(300);
		await d.click(button("调整设计"));
		await d.until(`document.querySelector("[data-ly-preview-tweaks]")`, 5000);
		await pause(800);
		const before = await inFrame<{ radius: string; padding: string; accent: string }>(PLAYER);
		check("面板出来前页面是原样：圆角 18px", before.radius === "18px", JSON.stringify(before));
		const panelRange = await app.evaluate<Box>(`(() => { const r = document.querySelector('[data-ly-preview-tweaks] input[type=range][aria-label="圆角"]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
		await clickRange(panelRange, 0.6);
		await pause(500);
		await d.click(`[data-ly-preview-tweaks] button[role=switch][aria-label="紧凑"]`);
		await pause(800);
		const after = await inFrame<{ radius: string; padding: string; accent: string }>(PLAYER);
		check("拖圆角、开紧凑，页面当场跟着变", after.radius === "24px" && after.padding === "10px", JSON.stringify(after));
		await shoot("05_调过之后");
		await d.click(`[data-ly-preview-tweaks] button[aria-pressed]`);
		await pause(600);
		const original = await inFrame<{ radius: string; padding: string }>(PLAYER);
		await shoot("06_看原样");
		await d.click(`[data-ly-preview-tweaks] button[aria-pressed="true"]`);
		await pause(600);
		const back = await inFrame<{ radius: string; padding: string }>(PLAYER);
		check("「看原样」按下是原样，再按回到调过的样子", original.radius === "18px" && original.padding === "18px" && back.radius === "24px" && back.padding === "10px", JSON.stringify({ original, back }));
		await app.evaluate(`[...document.querySelectorAll("[data-ly-preview-tweaks] button")].find((b) => b.innerText.includes("按这组设置修改")).setAttribute("data-probe-send", "")`);
		await d.click(`[data-probe-send]`);
		await d.until(`[...document.querySelectorAll("main p")].some((p) => p.innerText.includes(${JSON.stringify(TWEAK_ANSWER)}))`, 30000);
		await pause(800);
		const asked = lastUserText(bodies[3] ?? "");
		check("发给模型的是改了哪几项、从多少到多少", asked.includes("<design-settings>") && asked.includes('"control":"圆角","from":18,"to":24,"unit":"px"') && asked.includes('"control":"紧凑","from":false,"to":true') && !asked.includes("主色"), asked.slice(-300));
		const said = await app.evaluate<boolean>(`[...document.querySelectorAll("main *")].some((el) => el.children.length === 0 && el.textContent.includes("调整设计：圆角 18px → 24px，紧凑 关 → 开"))`);
		check("气泡里是一句人话：调整设计：圆角 18px → 24px，紧凑 关 → 开", said, "没找到");
		const sent = await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-preview-tweaks] [role=status]"))`);
		check("发过之后按钮换成「已发送」", sent, "没有");
		await shoot("07_发出之后");
		await app.evaluate(`[...document.querySelectorAll("[data-ly-preview-tweaks] button")].find((b) => b.innerText.includes("重置")).setAttribute("data-probe-reset", "")`);
		await d.click(`[data-probe-reset]`);
		await pause(700);
		const reset = await inFrame<{ radius: string; padding: string }>(PLAYER);
		check("重置后页面回到原样", reset.radius === "18px" && reset.padding === "18px", JSON.stringify(reset));
		await shoot("08_重置之后");
		await pause(1200);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_页面工具_${passed}of${checks.length}.mp4`);
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
