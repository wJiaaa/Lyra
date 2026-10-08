/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * An agent's interactive page in a real window, recorded while it is checked.
 *
 * The model is scripted: it looks around, puts up a page whose script throws, checks the fixed page
 * out of sight, publishes it by id, and answers. What is measured is what only a real window can say
 * — that the broken page never reached the reader, that the check came back as a screenshot in the
 * app's theme and put nothing on screen, that the page stays in sight once the turn folds away, that it wears
 * the app's theme and follows it live, that it can be clicked, and that its link leaves through the
 * app rather than turning the frame into an error page.
 *
 * Usage: node --experimental-strip-types e2e/preview-visualizer-demo.ts [label]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, evaluateRenderer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "改动后";
const OUT_DIR = join(homedir(), "Desktop", "Plume交互预览测试");
const PORT = 9491;
const MODEL_PORT = 9593;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SOURCE = `http://127.0.0.1:${MODEL_PORT}/source`;
const ANSWER = "三月是全年峰值，比二月高出将近一倍。";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.wrap{display:grid;gap:14px}
.bars{display:flex;align-items:flex-end;gap:10px;height:170px}
.bar{flex:1;border-radius:6px 6px 0 0;transition:height .35s}
.bar span{display:block;text-align:center;font-size:12px;color:var(--muted-foreground);transform:translateY(-18px)}
.row{display:flex;align-items:center;gap:12px}
button{font:inherit;color:var(--primary-foreground);background:var(--primary);border:0;border-radius:var(--radius);padding:6px 14px;cursor:pointer}
.muted{color:var(--muted-foreground)}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<div class="bars" id="bars"></div>
<div class="row"><button id="shuffle">换一组数据</button><span class="muted" id="sum"></span><a id="source" href="${SOURCE}">数据来源</a></div>
</div><script>
var months=["一月","二月","三月","四月","五月","六月"],data=[34,48,92,61,55,40],round=0;
function draw(){var bars=document.getElementById("bars");bars.innerHTML="";var max=Math.max.apply(null,data);
data.forEach(function(v,i){var b=document.createElement("div");b.className="bar";b.style.height=(v/max*150)+"px";b.style.background="var(--chart-"+(i%6+1)+")";b.innerHTML="<span>"+months[i]+"</span>";bars.appendChild(b)});
document.getElementById("sum").textContent="第 "+(round+1)+" 组 · 合计 "+data.reduce(function(a,b){return a+b},0);}
document.getElementById("shuffle").addEventListener("click",function(){round++;data=data.map(function(){return 20+Math.round(Math.random()*80)});draw()});
draw();
</script></body></html>`;
const BROKEN = PAGE.replace("draw();\n</script>", "drawChart();\n</script>");

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
/** The id the check handed back, read off the request that carries its result. */
const checkedId = (body: string) => /id: ([0-9a-f]{8})/.exec(body)?.[1] ?? "missing";
const SCRIPT: ((body: string) => Block[])[] = [
	() => [{ tool: "ls", args: { path: "." } }],
	() => [{ tool: "preview", args: { title: "月度数据", html: BROKEN } }],
	() => [{ tool: "preview", args: { title: "月度数据", html: PAGE, check: true } }],
	(body) => [{ tool: "preview", args: { id: checkedId(body) } }],
	() => [{ text: ANSWER }],
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
		if (req.url === "/source") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<h1>数据来源</h1>");
			return;
		}
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
	await writeFile(join(project, "sales.csv"), "month,value\n");
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
		// The link goes to the built-in browser, where the probe can see it arrive — not to the desktop's own browser.
		browser: { openLinks: "builtin" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

/** The page's own document, through its own DevTools target: the frame is another origin, often another process. */
async function inFrame<T>(expression: string): Promise<T> {
	const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
	const target = list.find((entry) => entry.type === "iframe" && entry.url.startsWith("ly-preview://"));
	if (!target) throw new Error(`没有找到预览的 iframe target：${list.map((entry) => `${entry.type} ${entry.url.slice(0, 60)}`).join(" | ")}`);
	// A frame reloading under the call (the rerun) can leave the socket hanging; a sample is worth three seconds at most.
	return Promise.race([
		evaluateRenderer<T>(target.webSocketDebuggerUrl, expression),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("页面没有在 3 秒内回答")), 3000)),
	]);
}

/** Where things are on screen, from the outside. */
const LAYOUT = `(() => {
	const frames = [...document.querySelectorAll("main iframe")].filter((f) => f.src.startsWith("ly-preview://"));
	const frame = frames.find((f) => f.checkVisibility({ opacityProperty: true }) && f.getBoundingClientRect().height > 40);
	const card = frame?.parentElement?.parentElement;
	const answer = [...document.querySelectorAll("main p")].find((p) => p.innerText.includes(${JSON.stringify(ANSWER)}));
	const head = document.querySelector("main [data-ly-turn-elapsed='done']");
	const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }; };
	return {
		frames: frames.length,
		frame: rect(frame), card: rect(card), answer: rect(answer), head: rect(head),
		kind: card?.dataset.lyPreview ?? null,
		browserCards: document.querySelectorAll("main [data-browser-card]").length,
		border: card ? getComputedStyle(card).borderTopWidth : null,
		ink: getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim(),
		scheme: document.documentElement.classList.contains("light") ? "light" : "dark",
	};
})()`;

interface Layout {
	frames: number;
	frame: { x: number; y: number; w: number; h: number; bottom: number } | null;
	card: { x: number; y: number; w: number; h: number; bottom: number } | null;
	answer: { x: number; y: number; w: number; h: number; bottom: number } | null;
	head: { x: number; y: number; w: number; h: number; bottom: number } | null;
	kind: string | null;
	browserCards: number;
	border: string | null;
	ink: string;
	scheme: string;
}

/** Pixels, from the screen as the reader sees it: one point inside the page's empty corner, one just outside the card. */
async function samePaint(layout: Layout): Promise<{ inside: number[]; outside: number[] }> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const card = layout.card!;
	return app.evaluate(`(async () => {
		const image = new Image(); image.src = "data:image/png;base64,${data}"; await image.decode();
		const scale = image.naturalWidth / innerWidth;
		const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
		const at = (x, y) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3);
		return { inside: at(${card.x + card.w - 6}, ${card.y + card.h - 6}), outside: at(${card.x + card.w + 6}, ${card.y + card.h - 6}) };
	})()`);
}

/** The image in the last tool result of an Anthropic request body, as base64. */
function screenshotSent(body: string): string | null {
	try {
		const messages = (JSON.parse(body) as { messages: { content: unknown }[] }).messages;
		const blocks = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])) as { type: string; content?: unknown }[];
		const result = blocks.findLast((block) => block.type === "tool_result");
		const image = (Array.isArray(result?.content) ? result.content : []).find((block: { type: string }) => block.type === "image") as { source?: { data?: string } } | undefined;
		return image?.source?.data ?? null;
	} catch {
		return null;
	}
}

function lastToolResult(body: string): string {
	const at = body.lastIndexOf('"tool_result"');
	return at < 0 ? "（请求里没有 tool_result）" : body.slice(at, at + 600);
}

const near = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]) <= 3);

/** What the model was shown: its size, the colour in the page's empty bottom-right corner, and whether the chart's bars are in it. */
async function readShot(data: string): Promise<{ width: number; height: number; corner: number[]; hasBars: boolean }> {
	return app.evaluate(`(async () => {
		const image = new Image(); image.src = "data:image/png;base64,${data}"; await image.decode();
		const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
		const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
		const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const at = (x, y) => [...pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)];
		const corner = at(canvas.width - 4, canvas.height - 4);
		// The first bar is --chart-1, the accent: a saturated pixel somewhere is the chart having drawn.
		let hasBars = false;
		for (let i = 0; i < pixels.length && !hasBars; i += 16) { const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]; hasBars = Math.max(r, g, b) - Math.min(r, g, b) > 80; }
		return { width: canvas.width, height: canvas.height, corner, hasBars };
	})()`);
}

async function shoot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from(data, "base64"));
}

/** A real click at a point inside the page, in window coordinates. */
async function clickAt(x: number, y: number) {
	for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
		await app.send("Input.dispatchMouseEvent", { type, x, y, ...(type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }) });
	}
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	try {
		console.log(`【${LABEL}】一、让 agent 画一张能交互的图`);
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1000);
		await d.type("把 sales.csv 的月度数据画成图");
		await pause(500);
		await d.submit();
		await d.settled(120000);
		await pause(1500);

		const done = await app.evaluate<Layout>(LAYOUT);
		const fixRequest = bodies[2] ?? "";
		check("抛异常的那一版被拦下，异常回给了模型", /drawChart is not defined/.test(fixRequest), fixRequest.slice(-300));
		const shot = screenshotSent(bodies[3] ?? "");
		check("检查把截图交给了模型", shot !== null, lastToolResult(bodies[3] ?? ""));
		check("发布只传了 id，没有重发整页 HTML", /"id":"[0-9a-f]{8}"/.test(bodies[4] ?? "") && !(bodies[4] ?? "").slice((bodies[4] ?? "").lastIndexOf('"tool_use"')).includes("shuffle"), (bodies[4] ?? "").slice(-300));
		check("对话里只有发布的那一张页面（检查不画卡片，也没有浏览器卡片）", done.frames === 1 && done.browserCards === 0, `${done.frames} 个预览 iframe，${done.browserCards} 张浏览器卡片`);
		check("回合结束后页面仍然看得见", done.frame !== null && done.frame.h > 150, JSON.stringify(done.frame));
		check(
			"页面在「已工作」那一行之后、回答之前",
			Boolean(done.frame && done.answer && done.head && done.head.bottom <= done.frame.y && done.frame.bottom <= done.answer.y),
			JSON.stringify({ head: done.head, frame: done.frame, answer: done.answer }),
		);
		check("页面没有卡片边框，是回复的一部分", done.kind === "themed" && done.border === "0px", `${done.kind} / ${done.border}`);
		if (done.card) {
			const paint = await samePaint(done);
			check("页面底色就是对话的底色（逐像素）", paint.inside.every((value, i) => Math.abs(value - paint.outside[i]) <= 2), JSON.stringify(paint));
			if (shot) {
				const seen = await readShot(shot);
				await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_00_模型看到的截图.png`), Buffer.from(shot, "base64"));
				check("截图是对话里的样子：同样的底色和正文色", near(seen.corner, paint.outside) && seen.hasBars, JSON.stringify({ seen, outside: paint.outside }));
				// Checked at the column's nominal width (720), not this window's: the page is the same height either way here.
				check("截图在卡片会截断的地方截断：和卡片一样高", Math.abs(seen.height - done.card.h) <= 4, `${seen.width}×${seen.height} vs 卡片 ${done.card.w}×${done.card.h}`);
			}
		}
		await shoot("01_回合结束后");

		const themed = await inFrame<{ fg: string; color: string; scheme: string; height: number; hash: string }>(`({
			fg: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
			color: getComputedStyle(document.documentElement).color,
			scheme: getComputedStyle(document.documentElement).colorScheme,
			height: document.documentElement.scrollHeight,
			hash: location.hash,
		})`).catch((error: unknown) => ({ fg: "", color: String(error), scheme: "", height: 0, hash: "" }));
		check("页面拿到了应用的正文色", themed.fg !== "" && themed.fg === done.ink, `${themed.fg} vs ${done.ink}`);
		check("主题片段读完就从地址里拿掉", themed.hash === "", themed.hash);
		check("卡片高度贴合页面内容", done.card !== null && Math.abs(done.card.h - themed.height) <= 6, `${done.card?.h} vs ${themed.height}`);

		console.log(`【${LABEL}】二、在页面里点按钮`);
		const button = await inFrame<{ x: number; y: number } | null>(`(() => { const r = document.getElementById("shuffle")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`).catch(() => null);
		if (button && done.frame) {
			const before = await inFrame<string>(`document.getElementById("sum").textContent`);
			await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: done.frame.x + button.x, y: done.frame.y + button.y });
			await pause(600);
			await clickAt(done.frame.x + button.x, done.frame.y + button.y);
			await pause(900);
			const after = await inFrame<string>(`document.getElementById("sum").textContent`);
			check("按钮点得动，图换了一组数据", before !== after && /第 2 组/.test(after), `${before} → ${after}`);
			await shoot("02_点过按钮");
		} else check("按钮点得动，图换了一组数据", false, "找不到按钮");

		const controls = await app.evaluate<string[]>(`[...document.querySelectorAll("main [data-ly-preview] button")].map((b) => b.getAttribute("aria-label"))`);
		check("按内容定高的页面不再有「放到最大」（只会在下面加一片空白）", !controls.includes("放到最大") && controls.includes("在侧栏中打开"), JSON.stringify(controls));

		console.log(`【${LABEL}】三、切到浅色主题`);
		await app.evaluate(`(async()=>{const s=await window.plume.settings.get();await window.plume.settings.save({...s,appearance:{...s.appearance,theme:"light"}});})()`);
		await d.until(`document.documentElement.classList.contains("light")`, 10000);
		await pause(1200);
		const light = await app.evaluate<Layout>(LAYOUT);
		const relit = await inFrame<{ fg: string; scheme: string; sum: string }>(`({
			fg: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
			scheme: getComputedStyle(document.documentElement).colorScheme,
			sum: document.getElementById("sum")?.textContent ?? "",
		})`).catch(() => ({ fg: "", scheme: "", sum: "" }));
		check("切换主题后页面跟着换色，不重新加载", relit.fg === light.ink && relit.scheme === "light" && /第 2 组/.test(relit.sum), JSON.stringify({ relit, ink: light.ink }));
		if (light.card) {
			const paint = await samePaint(light);
			check("浅色下页面底色仍是对话的底色（逐像素）", paint.inside.every((value, i) => Math.abs(value - paint.outside[i]) <= 2), JSON.stringify(paint));
		}
		await shoot("03_浅色主题");

		console.log(`【${LABEL}】三·五、重新运行`);
		await d.hover("main [data-ly-preview] iframe");
		await pause(300);
		await d.click('main [data-ly-preview] button[aria-label="重新运行"]');
		const rerun: { t: number; h: number; o: string; fg?: string }[] = [];
		const t0 = Date.now();
		while (Date.now() - t0 < 2500) {
			const sample = await app.evaluate<{ h: number; o: string }>(`(() => { const c = document.querySelector("main [data-ly-preview]"); const f = c?.querySelector("iframe"); return { h: Math.round(c?.getBoundingClientRect().height ?? 0), o: f ? getComputedStyle(f).opacity : "-" }; })()`);
			const fg = await inFrame<string>(`getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim()`).catch(() => "?");
			rerun.push({ t: Date.now() - t0, ...sample, fg });
			if (rerun.length === 3) await shoot("03b_重新运行中");
			await pause(40);
		}
		const settledHeight = rerun.at(-1)?.h ?? 0;
		check("重新运行时卡片高度不跳", rerun.every((sample) => Math.abs(sample.h - settledHeight) <= 4), JSON.stringify(rerun.map((sample) => sample.h)));
		check("重新运行后的页面一上来就是当前主题", rerun.every((sample) => sample.fg === "?" || sample.fg === "" || sample.fg === light.ink), JSON.stringify(rerun.map((sample) => sample.fg)));
		await shoot("03c_重新运行后");

		console.log(`【${LABEL}】四、点页面里的链接`);
		const link = await inFrame<{ x: number; y: number } | null>(`(() => { const r = document.getElementById("source")?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`).catch(() => null);
		if (link && light.frame) {
			// Focus on the app's own composer first: the click into the page then races its own message here.
			await d.click("main textarea");
			await pause(400);
			await clickAt(light.frame.x + link.x, light.frame.y + link.y);
			await pause(2000);
			const tabs = await app.evaluate<string[]>(`window.plume.browser.state().then((s) => s.tabs.map((t) => t.url))`);
			const stayed = await inFrame<string>(`location.href`).catch((error: unknown) => `（读不到：${String(error).slice(0, 80)}）`);
			check("链接在内置浏览器里打开", tabs.some((url) => url.startsWith(SOURCE)), JSON.stringify(tabs));
			check("页面本身留在原地，没有被链接带走", stayed.startsWith("ly-preview://"), stayed);
			await shoot("04_点过链接");
		} else check("链接在内置浏览器里打开", false, "找不到链接");
		await pause(1500);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_交互预览_${passed}of${checks.length}.mp4`);
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
