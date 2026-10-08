/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 会话回顾卡，在真窗口里从头走一遍，边验边录。
 *
 * 剧本：在 qa-short 里发一句，趁它还在跑切去 qa-long，让那一轮在看不见的地方收尾；切回来，
 * 输入框上方应当出现回顾条。然后切走再切回来（应当还在）、悬停侧栏那一行、关掉卡、打
 * `/recap` 再要一份——这一次转录没变，不该再请求模型。最后发一句话，回顾收起。
 *
 * 假模型分三种请求作答：带工具的是那一轮（拖住、放行后写一段超过一屏的回答），写回顾的那一次
 * 回一句（故意带上项目符号、多写一行，验清洗），其余（拟标题）回一句短的。
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

/** 一百多字：一行放不下，应当折成两行、不被省略。 */
const RECAP = "把演示任务从头跑完了，回答一共写了十二段，每段都在说明新内容怎样撑过一屏；这一轮没有改动任何文件，也没有运行测试或构建；接下来需要你决定要不要继续扩展演示内容，或者换成一个真实项目再完整跑一遍，看看效果";
/** 假模型故意不听话：带项目符号，还多写了一行。卡片上应当只剩第一句。 */
const RECAP_REPLY = `- ${RECAP}\n- 这一行不该出现`;
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
					answer(res, RECAP_REPLY);
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
		await until(app, `document.querySelector('${CARD}')?.textContent.includes(${JSON.stringify(RECAP)})`, 1200);
		await frames(app, 30);
		const card = await app.evaluate<{ lines: string[]; shadow: string; border: string; aboveComposer: boolean; inDock: boolean; radius: string; fill: string; mark: string; buttons: string[]; rows: number; clipped: boolean; markOff: number; closeOff: number }>(`(() => {
			const card = document.querySelector('${CARD}');
			const box = card.getBoundingClientRect();
			const composer = document.querySelector('main textarea').getBoundingClientRect();
			const style = getComputedStyle(card);
			return {
				lines: [...card.querySelectorAll('p')].map((p) => p.textContent),
				shadow: style.boxShadow,
				border: style.borderTopWidth,
				aboveComposer: box.bottom <= composer.top,
				inDock: !!card.closest('.ly-composer-dock'),
				radius: style.borderTopLeftRadius,
				fill: style.backgroundColor,
				mark: card.querySelector('span[aria-hidden]')?.textContent ?? '',
				buttons: [...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
				...(() => {
					// 折了几行、有没有被省略，记号和叉的中线离第一行中线多远。
					const p = card.querySelector('p');
					const ps = getComputedStyle(p);
					const line = parseFloat(ps.lineHeight);
					const top = p.getBoundingClientRect().top + parseFloat(ps.paddingTop);
					const first = top + line / 2;
					const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
					const mark = card.querySelector('span[aria-hidden]');
					const markLine = mark.getBoundingClientRect().top + parseFloat(getComputedStyle(mark).paddingTop) + line / 2;
					return {
						rows: Math.round((p.clientHeight - parseFloat(ps.paddingTop) - parseFloat(ps.paddingBottom)) / line),
						clipped: p.scrollHeight > p.clientHeight + 1,
						markOff: Math.abs(markLine - first),
						closeOff: Math.abs(mid(card.querySelector('button')) - first),
					};
				})(),
			};
		})()`);
		check("一句话回顾，项目符号和多余的行都剥掉了", JSON.stringify(card.lines) === JSON.stringify([RECAP]), JSON.stringify(card.lines));
		check("一道细边、没有阴影", card.shadow === "none" && card.border === "1px", `${card.shadow} / ${card.border}`);
		check("在输入框那一摞里、输入框上方", card.aboveComposer && card.inDock, JSON.stringify(card));
		check("和子智能体条一样的 12px 圆角", card.radius === "12px", card.radius);
		// 用滚轮把转录往上滚一大段，条的位置不该动；滚动容器的 scrollTop 变了多少，证明确实滚了。
		// 不拿 `[data-question-index]` 量：左边问题导航的刻度也带这个属性，而它是不动的。
		const probe = `(() => {
			let scroller = document.elementFromPoint(1000, 300);
			while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
			return { bar: document.querySelector('${CARD}')?.getBoundingClientRect().top ?? -1, text: -(scroller?.scrollTop ?? 0) };
		})()`;
		const before = await app.evaluate<{ bar: number; text: number }>(probe);
		await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1000, y: 300, deltaX: 0, deltaY: -1200 });
		await pause(800);
		const after = await app.evaluate<{ bar: number; text: number }>(probe);
		const moved = { scrolled: Math.round(after.text - before.text), bar: Math.abs(after.bar - before.bar) };
		// 等转录的滚动彻底静下来（开窗补内容还会再滚几下）：侧栏悬停卡碰到任何 scroll 都会收起。
		await app.evaluate(`new Promise((resolve) => { let t = setTimeout(done, 600); function done() { removeEventListener('scroll', bump, true); resolve(0); } function bump() { clearTimeout(t); t = setTimeout(done, 600); } addEventListener('scroll', bump, true); })`);
		check("滚动转录时条留在输入框上方不动", moved.scrolled > 200 && moved.bar < 1, JSON.stringify(moved));
		await still("03_滚到顶条还在");
		check("卡片有一层底色", card.fill !== "rgba(0, 0, 0, 0)" && card.fill !== "transparent", card.fill);
		check("记号是 ※", card.mark === "※", card.mark);
		check("一行放不下的回顾折成两行，没有被省略", card.rows === 2 && !card.clipped, `${card.rows} 行${card.clipped ? "，被省略了" : ""}`);
		check("※ 和关闭都对着第一行", card.markOff < 1 && card.closeOff < 1, `※ 偏 ${card.markOff}px，× 偏 ${card.closeOff}px`);
		check("只有记号、回顾和关闭，没有标题和别的按钮", JSON.stringify(card.buttons) === JSON.stringify(["关闭"]), JSON.stringify(card.buttons));
		check("这一次回顾请求了一次模型", recapRequests === 1, String(recapRequests));
		await still("02_切回来出现回顾卡");
		await pause(1500);

		console.log("\n【四】切到 qa-long 再切回来，回顾还在");
		await openSession(app, "qa-long");
		await pause(600);
		// 切走的会话界面隐藏着留在 DOM 里，它那一份也还在：只看画面上可见的。
		check("别的会话上没有这条回顾", !(await app.evaluate<boolean>(`[...document.querySelectorAll('${CARD}')].some((c) => c.checkVisibility())`)), "qa-long 上出现了回顾");
		await openSession(app, "qa-short");
		await until(app, `document.querySelector('${CARD}')?.textContent.includes(${JSON.stringify(RECAP)})`, 300);
		check("切回来回顾还在", true, "");
		await still("04_切回来还在");
		await pause(1000);

		console.log("\n【五】悬停侧栏那一行，卡片里带着回顾");
		// 鼠标从切回会话那一下起就停在这一行上：先移开，悬停才是一次新的进入。
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
		await pause(400);
		await hover(app, '[data-ly-row="qa-short"] > button');
		await until(app, `document.querySelector('[data-ly-session-card]')?.textContent.includes(${JSON.stringify(RECAP)})`, 900);
		check("侧栏悬停卡片显示最近一次回顾", true, "");
		await still("05_侧栏悬停卡片");
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
		await until(app, `document.querySelector('${CARD}')?.textContent.includes(${JSON.stringify(RECAP)})`, 900);
		check("转录没变，/recap 直接用缓存，不再请求模型", recapRequests === 1, String(recapRequests));
		await still("06_手动recap");
		await pause(1500);

		console.log("\n【七】发一句话，回顾收起");
		await type(app, "main textarea", "接着做");
		await pause(600);
		await press(app, "Enter", 13);
		await until(app, `!document.querySelector('${CARD}')`, 300);
		check("发出新消息后回顾收起", true, "");
		await still("07_发消息后收起");
		await pause(1000);
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
