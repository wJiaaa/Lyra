/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * A preview card's height when the column it sits in changes width, recorded in a real window.
 *
 * Text rewraps: a side panel narrows the column, the page gets taller and the card grows with it.
 * What used to go wrong is the way back — the panel closed, the page reported its old height, and the
 * card stayed at the narrow one with blank conversation under the page. Measured here: the card
 * height against the page's own report, through a panel opening and closing and a window shrinking
 * and coming back.
 *
 * Usage: node --experimental-strip-types e2e/preview-height-demo.ts [label]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { openPane } from "./drive.ts";

const LABEL = process.argv[2] ?? "改动后";
const OUT_DIR = join(homedir(), "Desktop", "Plume预览高度测试");
const PORT = 9497;
const MODEL_PORT = 9597;
const INSPECT_PORT = 9498;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
/** The main window, from the main process — see `resize-lag-probe.ts`. */
const WINDOW =
	'process._linkedBinding("electron_browser_window").BrowserWindow.getAllWindows()' +
	".filter((w) => !w.isDestroyed() && w.isVisible())" +
	".sort((a, b) => b.getBounds().width - a.getBounds().width)[0]";

const PARAGRAPH = "同一段处境：后台会话「重构 API 鉴权」刚跑完，同时它的上下文到了 82%，运行时的压缩提示也到了。窗口里正在看的是另一个会话，两张卡片一前一后落进同一列，遮住的正是内容。";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
.box{border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px}
h3{margin:0 0 6px;font-size:14px}p{margin:0;color:var(--muted-foreground)}
</style></head><body>${["A 现状", "B 一个会话一张卡", "C 读数搬进托盘", "D 只占一行静默条"].map((name) => `<div class="box"><h3>${name}</h3><p>${PARAGRAPH}</p></div>`).join("")}</body></html>`;

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [[{ tool: "preview", args: { title: "四个方案", html: PAGE } }], [{ text: "四个方案并排在上面。" }]];

let app: RunningApp;
let model: Server;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  （${saw}）`);
}

function sse(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", async () => {
			const blocks = SCRIPT[Math.min(request, SCRIPT.length - 1)];
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
		appearance: { theme: "light" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

/**
 * Every height the page reports, with the width it was measured at, from the app's side of the
 * sandbox — the same message the card reads.
 */
const LISTEN = `(() => { window.__reports = []; addEventListener("message", (e) => {
	const h = e.data && e.data.__dwPreviewHeight; if (typeof h !== "number") return;
	window.__reports.push({ h, w: e.data.__lyPreviewWidth });
}, true); })()`;
const CARD = `(() => { const c = document.querySelector("main [data-ly-preview]"); if (!c) return null;
	const r = c.getBoundingClientRect(); const last = window.__reports.at(-1);
	return { card: Math.round(r.height), width: Math.round(r.width), page: last ? last.h : null, pageWidth: last ? last.w : null }; })()`;

interface Card { card: number; width: number; page: number | null; pageWidth: number | null }

/** Waits out the card's height transition, then reads where it came to rest. */
async function rest(): Promise<Card> {
	let last: Card | null = null;
	for (let i = 0; i < 20; i++) {
		await pause(250);
		const now = await app.evaluate<Card>(CARD);
		if (last && now.card === last.card && now.width === last.width) return now;
		last = now;
	}
	return last!;
}

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
		await d.until('document.querySelector("main textarea")', 30000);
		await app.evaluate(LISTEN);
		await pause(800);
		await d.type("把四个方案画成一页");
		await d.submit();
		await d.settled(120000);

		console.log(`【${LABEL}】一、一轮跑完`);
		const start = await rest();
		// The page's report carries the reporter's 2px of slack; the card is that, give or take rounding.
		check("卡片贴合页面", start.page !== null && Math.abs(start.card - start.page) <= 2, JSON.stringify(start));
		await shoot("01_一轮跑完");
		await pause(1000);

		console.log(`【${LABEL}】二、开浏览器面板，对话栏变窄`);
		await openPane(app, "浏览器");
		const narrow = await rest();
		check("对话栏变窄，页面折行变高，卡片跟着长高", narrow.width < start.width && narrow.card > start.card, JSON.stringify(narrow));
		await shoot("02_面板打开");
		await pause(1000);

		console.log(`【${LABEL}】三、收起面板，对话栏恢复原宽`);
		await d.click('button[aria-label="收起右侧面板"]');
		const back = await rest();
		check("宽度回到原样", back.width === start.width, `${back.width} vs ${start.width}`);
		check("卡片缩回原来的高度，底下没有空白", Math.abs(back.card - start.card) <= 2, `${back.card} vs ${start.card}，页面报 ${back.page}`);
		await shoot("03_面板收起");
		await pause(1000);

		console.log(`【${LABEL}】四、窗口缩到 560 宽再恢复`);
		await app.main(`${WINDOW}.setBounds({ width: 560, height: 820 }, false)`);
		const small = await rest();
		check("窗口变窄，卡片跟着长高", small.card > start.card, JSON.stringify(small));
		await shoot("04_窗口变窄");
		await pause(1000);
		await app.main(`${WINDOW}.setBounds({ width: 1180, height: 820 }, false)`);
		const restored = await rest();
		check("窗口恢复后卡片缩回原来的高度", Math.abs(restored.card - start.card) <= 2, `${restored.card} vs ${start.card}，页面报 ${restored.page}`);
		await shoot("05_窗口恢复");
		await pause(1500);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_预览随宽度定高_${passed}of${checks.length}.mp4`);
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
