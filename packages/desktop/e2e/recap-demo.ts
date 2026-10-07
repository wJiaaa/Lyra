/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 会话回顾卡，在真窗口里从头走一遍，边验边录。
 *
 * 剧本：在 qa-short 里发一句，趁它还在跑切去 qa-long，让那一轮在看不见的地方收尾；切回来，
 * 转录末尾应当出现「你不在的时候」那张卡。然后点「跳到新内容」、悬停侧栏那一行、关掉卡、打
 * `/recap` 再要一份——最后这一次转录没变，不该再请求模型。
 *
 * 假模型分三种请求作答：带工具的是那一轮（拖住、放行后写一段超过一屏的回答），写回顾的那一次
 * 回三行（故意带上项目符号，验清洗），其余（拟标题）回一句短的。
 *
 * 用法：node --experimental-strip-types e2e/recap-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, openSession, press, type, until } from "./drive.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seedInteractions } from "./interaction-fixture.ts";

const PORT = 9711;
const MODEL_PORT = 9712;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume会话回顾测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const RECAP_LINES = ["把演示任务跑完了，回答写了十二段", "没有改动任何文件", "接下来等你确认要不要继续扩展"];
const CARD = "[data-ly-recap]";

let app: RunningApp;
let model: Server;
const open = new Set<ServerResponse>();
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let recapRequests = 0;
let release: (() => void) | null = null;
const held = new Promise<void>((resolve) => {
	release = resolve;
});

function answer(res: ServerResponse, text: string): void {
	sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	sse(res, { type: "content_block_stop", index: 0 });
	sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	sse(res, { type: "message_stop" });
	res.end();
}

function startModel(): Server {
	let requests = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			void (async () => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				open.add(res);
				res.on("close", () => open.delete(res));
				sse(res, { type: "message_start", message: { id: `msg_${requests++}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				if (body.includes("写回顾")) {
					recapRequests++;
					answer(res, RECAP_LINES.map((line) => `- ${line}`).join("\n"));
				} else if (body.includes("todo_write")) {
					sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "开始干活了。\n\n" } });
					await held;
					answer(res, Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 段：${"这是一段足够长的演示回答，用来把新内容撑过一屏。".repeat(4)}`).join("\n\n"));
				} else answer(res, "演示");
			})();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	app = await startApp({ port: PORT, seed: (home) => seedInteractions(home, MODEL_PORT) });
	const grab = await frameGrabber(PORT);
	const recorded: Frame[] = [];
	const recording = new AbortController();
	const loop = (async () => {
		while (!recording.signal.aborted) {
			recorded.push({ at: Date.now(), data: await grab.shot() });
			await pause(120);
		}
	})();
	const still = async (name: string) => writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from((await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));

	try {
		await until(app, `document.querySelector('[data-ly-row="qa-short"] > button')`, 1800);
		await openSession(app, "qa-short");
		await frames(app, 30);
		await still("01_出发前");
		await pause(800);

		console.log("【一】在 qa-short 里发一句，让它跑起来");
		await type(app, "main textarea", "跑一轮演示");
		await pause(600);
		await press(app, "Enter", 13);
		await until(app, `[...document.querySelectorAll('button[aria-label]')].some((b) => /停止|Stop/.test(b.getAttribute('aria-label') || ''))`, 1200);
		await pause(800);

		console.log("\n【二】切去 qa-long，让那一轮在看不见的地方收尾");
		await openSession(app, "qa-long");
		await pause(600);
		release?.();
		await pause(2500);
		check("没有新进展的会话不出回顾卡", !(await app.evaluate<boolean>(`!!document.querySelector('${CARD}')`)), "qa-long 上出现了卡片");

		console.log("\n【三】切回 qa-short");
		await openSession(app, "qa-short");
		await until(app, `document.querySelector('${CARD}')?.textContent.includes(${JSON.stringify(RECAP_LINES[0])})`, 1200);
		await frames(app, 30);
		const card = await app.evaluate<{ lines: string[]; title: string; shadow: string; border: string; aboveComposer: boolean; last: boolean }>(`(() => {
			const card = document.querySelector('${CARD}');
			const box = card.getBoundingClientRect();
			const composer = document.querySelector('main textarea').getBoundingClientRect();
			const style = getComputedStyle(card);
			return {
				lines: [...card.querySelectorAll('p')].map((p) => p.textContent),
				title: card.querySelector('span')?.textContent ?? '',
				shadow: style.boxShadow,
				border: style.borderTopWidth,
				aboveComposer: box.bottom <= composer.top,
				last: !card.nextElementSibling || card.nextElementSibling.getAttribute('aria-hidden') === 'true',
			};
		})()`);
		check("卡片标题是「你不在的时候」", card.title === "你不在的时候", card.title);
		check("三行回顾，项目符号已经剥掉", JSON.stringify(card.lines) === JSON.stringify(RECAP_LINES), JSON.stringify(card.lines));
		check("一道细边、没有阴影", card.shadow === "none" && card.border === "1px", `${card.shadow} / ${card.border}`);
		check("在转录末尾、输入框上方", card.aboveComposer && card.last, JSON.stringify(card));
		check("这一次回顾请求了一次模型", recapRequests === 1, String(recapRequests));
		await still("02_切回来出现回顾卡");
		await pause(1500);

		console.log("\n【四】点「跳到新内容」");
		await click(app, `${CARD} button`, "跳到新内容");
		await pause(1200);
		const jumped = await app.evaluate<number>(`(() => {
			const asked = [...document.querySelectorAll('[data-question-index]')].at(-1);
			let scroller = asked.parentElement;
			while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
			return Math.round(asked.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
		})()`);
		check("跳到这一轮的问题，问题停在视口顶上", jumped >= 0 && jumped <= 120, `${jumped}px`);
		await still("03_跳到新内容");
		await pause(800);

		console.log("\n【五】悬停侧栏那一行，卡片里带着回顾");
		await hover(app, '[data-ly-row="qa-short"] > button');
		await until(app, `document.querySelector('[data-ly-session-card]')?.textContent.includes(${JSON.stringify(RECAP_LINES[0])})`, 900);
		check("侧栏悬停卡片显示最近一次回顾", true, "");
		await still("04_侧栏悬停卡片");
		await pause(1500);
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
		await pause(400);

		console.log("\n【六】关掉卡片，再打 /recap");
		await click(app, `${CARD} button[aria-label="关闭"]`);
		await until(app, `!document.querySelector('${CARD}')`, 300);
		check("× 关掉之后卡片消失", true, "");
		await pause(800);
		await type(app, "main textarea", "/recap");
		await pause(800);
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('${CARD}')?.textContent.includes(${JSON.stringify(RECAP_LINES[0])})`, 900);
		const manual = await app.evaluate<{ title: string; jump: boolean }>(`(() => {
			const card = document.querySelector('${CARD}');
			return { title: card.querySelector('span')?.textContent ?? '', jump: [...card.querySelectorAll('button')].some((b) => b.textContent.includes('跳到新内容')) };
		})()`);
		check("手动的那一张叫「回顾」，不带跳转", manual.title === "回顾" && !manual.jump, JSON.stringify(manual));
		check("转录没变，/recap 直接用缓存，不再请求模型", recapRequests === 1, String(recapRequests));
		await still("05_手动recap");
		await pause(1500);
	} finally {
		recording.abort();
		await loop.catch(() => {});
		grab.close();
		for (const res of open) res.destroy();
		await app?.stop().catch(() => {});
		await new Promise<void>((resolve) => model.close(() => resolve()));
	}

	const passed = checks.filter((c) => c.ok).length;
	await encode(recorded, join(OUT_DIR, `${STAMP}_会话回顾_${passed}of${checks.length}.mp4`), 30, 2000);
	console.log(`\n${passed}/${checks.length} 项通过，录像和截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	for (const res of open) res.destroy();
	await app?.stop().catch(() => {});
	model?.close();
	process.exitCode = 1;
});
