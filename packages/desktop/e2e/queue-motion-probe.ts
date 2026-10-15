/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 模型正在回答时发话：排队条进场、拖动、手动删掉、队首被送出，输入框上方和转录各自怎么动。
 *
 * 逐帧记排队卡片的上沿和高度、转录里最后一个问题的上沿、转录离底部多远。采样排在每一帧绘制之后
 * （rAF 里再排一个宏任务）：rAF 跑在布局和 `ResizeObserver` 之前，在那里读到的是贴底修正之前的
 * 位置，会把一帧都没画出来过的偏差当成抖动。
 *
 * 一次变化只该是一次单向移动：往反方向走过、或者末尾突然补一截，都是人看到的「跳」。
 *
 * `pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/queue-motion-probe.ts [输出目录]`
 * `LABEL=修前` 给产物文件名加前缀。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, openSession, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume排队条动画测试");
const LABEL = process.env.LABEL ?? "修后";
const PORT = 9648;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}`);
}

function emit(res: ServerResponse, type: string, data: object) {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

/**
 * 挂着的回合，探针说结束才结束。只有第一轮吐字：后面几轮要是也在流，贴底追赶的滑动会混进排队条
 * 引起的移动里，分不出是谁动的。
 */
const open: ServerResponse[] = [];
let turns = 0;
function finishTurn(): boolean {
	const res = open.shift();
	if (!res) return false;
	// 一个字都没写就收尾的回合，运行时不当它正常结束。收尾时补一句。
	emit(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "好。" } });
	emit(res, "content_block_stop", { index: 0 });
	emit(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	emit(res, "message_stop", {});
	res.end();
	return true;
}

const model = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const index = turns++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		emit(res, "message_start", { message: { id: `qm-${index}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
		emit(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		if (index === 0) {
			let chunk = 0;
			const timer = setInterval(() => {
				if (res.writableEnded || chunk >= 6) return clearInterval(timer);
				emit(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: `第 ${++chunk} 段，正在写。\n\n` } });
			}, 120);
		}
		open.push(res);
	});
});

const PANE = '[data-dock-pane="conversation"]';
const TA = `${PANE} textarea`;

/** 每一帧绘制之后的几何。 */
const SAMPLER = `(()=>{window.__s=[];const pane=${JSON.stringify(PANE)};let sc=null;const f=()=>{setTimeout(()=>{
const card=document.querySelector(pane+' [data-composer-queue]');
const qs=document.querySelectorAll(pane+' [data-question-index]');const last=qs[qs.length-1];
if(!sc||!sc.isConnected){sc=last;while(sc&&!(/(auto|scroll)/.test(getComputedStyle(sc).overflowY)&&sc.scrollHeight>sc.clientHeight))sc=sc.parentElement;}
const cr=card?.getBoundingClientRect();
window.__s.push({t:performance.now(),qH:cr?cr.height:null,ref:last?last.getBoundingClientRect().top:null,n:qs.length,
dist:sc?sc.scrollHeight-sc.scrollTop-sc.clientHeight:null,
rowTops:card?[...card.querySelectorAll('[data-queue-row]')].map(r=>Math.round(r.getBoundingClientRect().top*10)/10):[]});},0);requestAnimationFrame(f);};requestAnimationFrame(f);})()`;

type Sample = { t: number; qH: number | null; ref: number | null; n: number; dist: number | null; rowTops: number[] };

/** 一串数的走法：总位移、最大单帧跳动、往反方向走过多少。 */
function motion(values: number[]) {
	if (values.length < 2) return null;
	const net = values.at(-1)! - values[0];
	const sign = Math.sign(net);
	let against = 0;
	let jump = 0;
	for (let i = 1; i < values.length; i++) {
		const step = values[i] - values[i - 1];
		jump = Math.max(jump, Math.abs(step));
		against = Math.max(against, sign === 0 ? Math.abs(step) : -sign * step);
	}
	return { net, jump, against, path: values.map((v) => v.toFixed(1)).join(" ") };
}

const fmt = (m: ReturnType<typeof motion>) => (m ? `净 ${m.net.toFixed(1)}px，最大单帧 ${m.jump.toFixed(1)}px，反向 ${m.against.toFixed(1)}px` : "无");

async function mark(): Promise<number> {
	return app.evaluate<number>("performance.now()");
}
async function samples(from: number, ms: number): Promise<Sample[]> {
	const all = await app.evaluate<Sample[]>("window.__s");
	return all.filter((s) => s.t >= from && s.t <= from + ms);
}
async function snap(name: string) {
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from((await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));
}
async function send(text: string) {
	await click(app, TA);
	await type(app, TA, text);
	await press(app, "Enter", 13);
}

/** 卡片高度和转录参照在一段窗口里只朝一个方向走，末尾不补一截。 */
function oneMove(name: string, span: Sample[], expect: "up" | "down") {
	const heights = span.map((s) => s.qH ?? 0);
	const height = motion(heights);
	const ref = motion(span.filter((s) => s.ref !== null).map((s) => s.ref!));
	console.log(`   卡片高度 ${height?.path}`);
	console.log(`   转录参照 ${ref?.path}`);
	check(`${name}：卡片高度单向变化（${fmt(height)}）`, height !== null && height.against <= 0.5 && (expect === "up" ? height.net > 0 : height.net < 0));
	if (expect === "up") {
		// 进场是 e-out：越到后面越慢，末步该很小。末尾突然补一截就是有一部分走的是另一条曲线。
		const steps = heights.map((v, i) => (i ? Math.abs(v - heights[i - 1]) : 0));
		const tail = steps.findLastIndex((v) => v > 0.05);
		const lastStep = tail > 0 ? steps[tail] : 0;
		check(`${name}：卡片高度末尾不突然补一截（末步 ${lastStep.toFixed(1)}px，最大步 ${height?.jump.toFixed(1)}px）`, height !== null && lastStep <= Math.max(1.5, height.jump * 0.5));
	} else {
		// 收起是 e-in，末步本来就最大；要看的是收到底才拿走，而不是收到一半被切掉：被切的那一步会比前一步大出一截。
		const shown = heights.filter((v, i) => i === 0 || v !== heights[i - 1]);
		const last = shown.length > 2 ? shown.at(-2)! - shown.at(-1)! : 0;
		const prior = shown.length > 2 ? shown.at(-3)! - shown.at(-2)! : 0;
		check(`${name}：收到底才拿走（末步 ${last.toFixed(1)}px，前一步 ${prior.toFixed(1)}px）`, last <= prior * 1.6 + 0.5);
	}
	check(`${name}：转录内容单向移动（${fmt(ref)}）`, ref !== null && ref.against <= 0.5);
	const away = Math.max(...span.map((s) => s.dist ?? 0));
	check(`${name}：转录一直贴着底部（离底最大 ${away.toFixed(1)}px）`, away <= 1.5);
}

/** 队首被送出：新问题进转录的那一帧，卡片也到终点；之后转录不再动。 */
function handOver(name: string, span: Sample[]) {
	if (process.env.DUMP) console.log(span.map((s) => `${s.n}:${s.qH?.toFixed(0) ?? "—"}`).join(" "));
	const landed = span.findIndex((s, i) => i > 0 && s.n !== span[i - 1].n);
	const final = span.at(-1)?.qH ?? null;
	const settled = span.findIndex((s, i) => i >= landed && (final === null ? s.qH === null : s.qH !== null && Math.abs(s.qH - final) < 0.5));
	const ref = motion(span.slice(Math.max(landed, 0)).filter((s) => s.ref !== null).map((s) => s.ref!));
	console.log(`   卡片高度 ${span.map((s) => (s.qH === null ? "—" : s.qH.toFixed(1))).join(" ")}`);
	console.log(`   新问题进转录在第 ${landed} 帧，卡片在第 ${settled} 帧到终点`);
	console.log(`   新问题之后的转录参照 ${ref?.path}`);
	check(`${name}：卡片和转录在同一帧交接（卡片晚 ${settled - landed} 帧）`, landed > 0 && settled === landed);
	// 之后新一轮的「正在想」那一行会长出来，把转录往上推——那是同一个方向，不算；往回走才算。
	check(`${name}：新消息落进转录之后内容不往回走（${fmt(ref)}）`, ref !== null && ref.against <= 0.5);
}

await mkdir(OUT_DIR, { recursive: true });
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server did not start");
const renderer = await startDevRenderer();
const app = await startApp({
	port: PORT,
	rendererUrl: renderer.url,
	seed: async (home) => {
		await seedInteractions(home, address.port);
		const path = join(home, "settings.json");
		const settings = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off", autoSummarizeTitle: false, appearance: { theme: "dark" } }));
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 820, x: 0, y: 0 }));
	},
});
const grab = await frameGrabber(PORT);
const film: Frame[] = [];
const camera = { rolling: false };
let filming: Promise<void> = Promise.resolve();
try {
	await openSession(app, "qa-short");
	await until(app, `document.querySelector(${JSON.stringify(TA)})`);
	camera.rolling = true;
	filming = (async () => {
		while (camera.rolling) film.push({ at: Date.now(), data: await grab.shot() });
	})();
	await pause(600);
	await send("开一轮，让它一直写着");
	await until(app, `document.querySelector('[data-composer-send="stop"]')`, 3000);
	// 字吐完以后「正在写」那一行会停顿一会儿再回来，它长出来也会推动转录——等它回来、站稳再量。
	await pause(3500);
	await app.evaluate(SAMPLER);
	await pause(300);

	console.log("\n【一】回答中发第一条：排队卡片出现");
	let t = await mark();
	await send("测试");
	await until(app, `document.querySelector('[data-composer-queue] [data-queue-row]')`, 2000);
	await pause(900);
	oneMove("第一条进场", await samples(t, 700), "up");
	await snap("01_第一条排上");

	console.log("\n【二】再发一条：卡片长一行");
	t = await mark();
	await send("第二条");
	await until(app, `document.querySelectorAll('[data-composer-queue] [data-queue-row]').length===2`, 2000);
	await pause(900);
	oneMove("第二条进场", await samples(t, 700), "up");
	await snap("02_两条排着");

	console.log("\n【三】把第二条拖到最前面：松手后不回弹");
	const grips = await app.evaluate<{ x: number; y: number }[]>(
		`[...document.querySelectorAll('[data-composer-queue] [data-queue-grip]')].map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})`,
	);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...grips[1] });
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", ...grips[1], button: "left", clickCount: 1 });
	for (let step = 1; step <= 10; step++) {
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: grips[1].x, y: grips[1].y + ((grips[0].y - 4 - grips[1].y) * step) / 10, button: "left" });
		await pause(40);
	}
	await pause(400);
	t = await mark();
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: grips[1].x, y: grips[0].y - 4, button: "left", clickCount: 1 });
	await pause(600);
	{
		const released = (await samples(t, 450)).filter((s) => s.rowTops.length === 2);
		const order = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-composer-queue] [data-queue-row]')].map(e=>e.textContent.trim().slice(0,4))`);
		console.log(`   松手后顺序 ${order.join(" / ")}`);
		console.log(`   松手后两行上沿 ${released.map((s) => s.rowTops.join("/")).join("  ")}`);
		const end = released.at(-1)?.rowTops ?? [];
		const bounce = Math.max(0, ...released.flatMap((s) => s.rowTops.map((v, i) => Math.abs(v - end[i]))));
		check(`拖动：顺序换过来了（${order.join(" / ")}）`, Boolean(order[0]?.startsWith("第二")));
		check(`拖动：松手后各行当帧落定、不回弹（偏离终点最大 ${bounce.toFixed(1)}px）`, released.length > 0 && bounce <= 0.5);
	}
	await snap("03_拖动之后");

	console.log("\n【四】这一轮结束，队首被送出，还剩一条");
	t = await mark();
	finishTurn();
	await until(app, `document.querySelectorAll('[data-composer-queue] [data-queue-row]:not([data-leaving])').length===1`, 3000);
	await pause(900);
	handOver("送出一条", await samples(t - 100, 1600));
	await snap("04_送出一条剩一条");

	console.log("\n【五】手动删掉剩下那条：卡片收起");
	t = await mark();
	await click(app, "[data-composer-queue] [data-queue-remove]");
	await until(app, `!document.querySelector('[data-composer-queue]')`, 2000);
	await pause(700);
	oneMove("手动删除", await samples(t, 600), "down");
	await snap("05_删完");

	console.log("\n【六】再排一条，这一轮结束时它被送出：卡片整个离场");
	await send("最后一条");
	await until(app, `document.querySelector('[data-composer-queue] [data-queue-row]')`, 2000);
	await pause(800);
	t = await mark();
	finishTurn();
	await until(app, `!document.querySelector('[data-composer-queue]')`, 3000).catch(async (error) => {
		console.log("   卡片没走：", await app.evaluate(`JSON.stringify({rows:[...document.querySelectorAll('[data-composer-queue] [data-queue-row]')].map(r=>r.textContent.trim().slice(0,6)+(r.hasAttribute('data-leaving')?'(leaving)':'')),stop:!!document.querySelector('[data-composer-send="stop"]')})`));
		throw error;
	});
	await pause(900);
	handOver("送出最后一条", await samples(t - 100, 1600));
	await snap("06_最后一条送出");
} finally {
	camera.rolling = false;
	await filming.catch(() => {});
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (film.length > 0) await encode(film, join(OUT_DIR, `${STAMP}_${LABEL}_回答中发消息排队_${passed}of${checks.length}.mp4`), 30);
	grab.close();
	while (finishTurn());
	await app.stop();
	await renderer.close();
	model.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
