/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 排队条上的「现在就发」：停下正在写的那一轮，拿这一条重新开始。边验边录。
 *
 * 从前它是插话——要等模型写完手上这一步才被读到。真实会话里那一步是三分半的思考加一大段 HTML，
 * 人按下去四分多钟什么也没发生，计时照走、速度读数冻住，看上去像模型不回了。
 *
 * 假模型是本地的 Anthropic 流式接口：第一轮写两段之后停住不收尾（只有被停下才会结束），第二、三轮
 * 正常答完。要看的是：
 *   - 按下去当场停：第二个请求在一秒内到；
 *   - 半截回复留在转录里、在这句话上面，模型下一次请求读得到它；
 *   - 这句话发给模型时带着「在你工作时发来、打断了你」的说明；
 *   - 中间不闪「已暂停」，停止按钮不变回发送；
 *   - 条上其余的那条不动，新的一轮答完后照常自动发出去，而且它不带打断的说明。
 *
 * 用法：pnpm build 之后 node --experimental-strip-types e2e/interrupt-now-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, openSession, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume现在就发测试");
const PORT = 9763;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const FIRST = "把迁移脚本跑一遍";
const NOW = "别动生产库，只跑测试库";
const LATER = "跑完把日志路径告诉我";
const PARTIAL = "脚本分三段：建表、回填、切换。";
const NOTE = "（打断）用户在你工作时发来了这条消息";
const PANE = '[data-dock-pane="conversation"]';

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------------------------
// 假模型
// ---------------------------------------------------------------------------------------------

const bodies: { at: number; body: string }[] = [];

function sse(res: ServerResponse, type: string, data: object): void {
	if (!res.writableEnded && !res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function finish(res: ServerResponse): void {
	sse(res, "content_block_stop", { index: 0 });
	sse(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } });
	sse(res, "message_stop", {});
	res.end();
}

const SCRIPT: Record<number, string[]> = {
	1: ["第 1 轮：先看一下迁移脚本里有哪几步。", `\n\n${PARTIAL}`, "\n\n接下来连上生产库开始执行"],
	2: ["第 2 轮：好，不碰生产库。", "\n\n已经把连接串换成测试库，迁移在测试库上跑完了。"],
	3: ["第 3 轮：日志在 logs/migrate-test.log。"],
};

function startModel(): Server {
	return createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			const turn = bodies.push({ at: Date.now(), body });
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, "message_start", { message: { id: `demo-${turn}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			const lines = SCRIPT[turn] ?? ["好。"];
			let n = 0;
			// 第一轮写到第二段就停住：后面那句「连上生产库」永远等不到，除非被停下。
			const stopAt = turn === 1 ? 2 : lines.length;
			const timer = setInterval(() => {
				sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: lines[n] } });
				n += 1;
				if (n < stopAt) return;
				clearInterval(timer);
				if (turn !== 1) setTimeout(() => finish(res), 600);
			}, 500);
			res.on("close", () => clearInterval(timer));
		});
	});
}

// ---------------------------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------------------------

let app: RunningApp;
let shotNo = 0;

async function screenshot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shotNo++;
	await writeFile(join(OUT_DIR, `${STAMP}_${String(shotNo).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
}

const paneText = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(PANE)})?.innerText ?? ""`);
const queueRows = () => app.evaluate<string[]>(`[...document.querySelectorAll('[data-queue-row]:not([data-leaving="true"])')].map((e) => e.innerText.trim())`);
/** 转录里看得见的用户气泡。隐藏的那一层是切换用的预渲染，不算。 */
const bubbles = () =>
	app.evaluate<string[]>(`[...document.querySelectorAll('${PANE} [data-question-index]')].filter((e) => e.checkVisibility()).map((e) => e.innerText.trim())`);

async function send(text: string): Promise<void> {
	await type(app, `${PANE} textarea`, text);
	await pause(400);
	await press(app, "Enter", 13);
}

/** 每一帧记一次：「已暂停」那一行在不在、输入框右下角是不是停止按钮。从按下去开始，到新的一轮开始写。 */
const SAMPLER = `(() => {
	const samples = [];
	window.__interruptSamples = samples;
	const tick = () => {
		const pane = document.querySelector(${JSON.stringify(PANE)});
		const paused = [...(pane?.querySelectorAll('[aria-label="继续"]') ?? [])].some((e) => e.checkVisibility());
		samples.push({ t: performance.now(), paused, stop: !!document.querySelector('[data-composer-send="stop"]') });
		if (samples.length < 600) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const model = startModel();
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("假模型没起来");
	const frames: Frame[] = [];
	try {
		app = await startApp({
			port: PORT,
			seed: async (home) => {
				await seedInteractions(home, address.port);
				const path = join(home, "settings.json");
				const settings = JSON.parse(await readFile(path, "utf8"));
				await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off" }));
			},
		});
		const stop = await startRecording(PORT, frames);

		console.log("一、开一轮，模型写了两段之后停住");
		await openSession(app, "qa-short");
		await pause(800);
		await send(FIRST);
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.innerText.includes("回填、切换")`, 1200);
		await pause(1000);

		console.log("二、正在跑的时候说两句，都排在输入框上面");
		await send(NOW);
		await until(app, `document.querySelectorAll('[data-queue-row]').length === 1`);
		await pause(500);
		await send(LATER);
		await until(app, `document.querySelectorAll('[data-queue-row]').length === 2`);
		await pause(1000);
		await screenshot("两句排在条上");
		check("两句都在排队条上", (await queueRows()).length === 2, JSON.stringify(await queueRows()));

		console.log("三、点第一条的「现在就发」");
		await app.evaluate(SAMPLER);
		const pressedAt = Date.now();
		await click(app, '[data-queue-row]:first-child [data-queue-now]');
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.innerText.includes("不碰生产库")`, 1200);
		const answeredAt = Date.now();
		await pause(300);
		await screenshot("按下之后模型立刻改口");
		const reached = bodies[1] ? bodies[1].at - pressedAt : Number.NaN;
		check("按下去一秒内第二个请求就到了模型", reached < 1000, `${reached}ms`);
		console.log(`      按下 → 第二个请求 ${reached}ms，→ 屏幕上出现新回答 ${answeredAt - pressedAt}ms`);

		const samples = await app.evaluate<{ t: number; paused: boolean; stop: boolean }[]>("window.__interruptSamples");
		check("从按下到新回答出现，一帧也没闪「已暂停 · 继续」", samples.every((s) => !s.paused), `${samples.filter((s) => s.paused).length}/${samples.length} 帧`);
		check("停止按钮一直在，没变回发送", samples.every((s) => s.stop), `${samples.filter((s) => !s.stop).length}/${samples.length} 帧不是停止按钮`);

		const text = await paneText();
		const partialAt = text.indexOf("回填、切换");
		const nowAt = text.indexOf(NOW);
		const answerAt = text.indexOf("不碰生产库");
		check("半截回复还在转录里", partialAt >= 0, "没找到");
		check("顺序是：半截回复 → 这句话 → 新回答", partialAt >= 0 && partialAt < nowAt && nowAt < answerAt, `${partialAt} / ${nowAt} / ${answerAt}`);
		check("这句话在转录里只有一条", (await bubbles()).filter((b) => b.includes(NOW)).length === 1, JSON.stringify(await bubbles()));
		check("没等到的那句「连上生产库」没出现", !text.includes("连上生产库"), "出现了");
		check("条上剩下另一句，还在等", JSON.stringify(await queueRows()).includes(LATER) && (await queueRows()).length === 1, JSON.stringify(await queueRows()));

		const second = bodies[1]?.body ?? "";
		check("第二个请求里有模型自己的半截回复", second.includes(PARTIAL), "没有");
		check("第二个请求里这句话带着「在你工作时发来、打断了你」的说明", second.includes(NOTE) && second.includes(NOW), second.slice(-400));

		console.log("四、新的一轮答完，排着的那句自动发出去");
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.innerText.includes("logs/migrate-test.log")`, 1500);
		await until(app, `!document.querySelector('[data-composer-send="stop"]')`, 1200);
		await pause(1200);
		await screenshot("排着的那句接着发完");
		const third = bodies[2]?.body ?? "";
		check("第三个请求带着排着的那句", third.includes(LATER), bodies[2] ? "没带" : "没有第三个请求");
		check("排着的那句没被当成打断：说明只套在打断的那一句上", third.split(NOTE).length - 1 === 1, `${third.split(NOTE).length - 1} 处`);
		check("排队条空了", (await queueRows()).length === 0, JSON.stringify(await queueRows()));
		await pause(1000);
		await stop();
	} finally {
		await app?.stop().catch(() => {});
		await closeListeningServer(model);
	}
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_现在就发打断重开_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过，录像与截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
