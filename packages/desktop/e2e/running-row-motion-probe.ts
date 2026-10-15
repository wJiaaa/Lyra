/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一轮回答里，转录末尾「正在想 / Writing…」那一行收起、回来时，贴底的转录有没有整块跳。
 *
 * 模型这一端照剧本走：先想 1.2 秒（只有那一行），再每 300ms 吐一段、吐四段，停 4 秒（超过
 * `STALL_MS`，那一行会回来），再吐两段，收尾。逐帧记最后一个问题的上沿和那一行的高度——采样排在
 * 绘制之后，理由见 `queue-motion-probe.ts`。
 *
 * 要看的三处：第一段字到的那一刻、停顿里那一行回来的那一刻、停顿后字接着来的那一刻。每一处转录
 * 都只该平滑地往上走，或者干脆不动；单帧挪出一大截就是人看到的「跳」。
 *
 * `pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/running-row-motion-probe.ts [输出目录]`
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

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume运行行跳动测试");
const LABEL = process.env.LABEL ?? "修后";
const PORT = 9654;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}`);
}

function emit(res: ServerResponse, type: string, data: object) {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

/** 模型那一端每件事发生在请求到达后的第几毫秒，探针按它切窗口。 */
const SCRIPT = { think: 1200, gap: 300, first: 4, stall: 4000, second: 2, tail: 1500 };
let started = 0;
/** 这一轮在请求到达后多久收尾，和下面的排法一致。 */
const END_MS = SCRIPT.think + SCRIPT.first * SCRIPT.gap + SCRIPT.stall - SCRIPT.gap + SCRIPT.second * SCRIPT.gap + SCRIPT.tail;

let requests = 0;
const model = createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const index = requests++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		emit(res, "message_start", { message: { id: `rr-${index}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
		emit(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		/*
		 * 第一轮是热身：夹具里的旧会话记的是另一个模型，第一次发送会在问题上方插一条「模型已切换」，
		 * 晚问题一帧出现、把转录推下去——那是另一件事，不该算在这一行头上。热身一轮把它吃掉，也让量的
		 * 那一轮从「上一轮以回答收尾」开始，正是留着的那一格该派上用场的时候。
		 */
		if (index === 0) {
			setTimeout(() => {
				emit(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "好。" } });
				emit(res, "content_block_stop", { index: 0 });
				emit(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
				emit(res, "message_stop", {});
				res.end();
			}, 600);
			return;
		}
		started = Date.now();
		const say = (text: string) => emit(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text } });
		let at = SCRIPT.think;
		for (let i = 1; i <= SCRIPT.first; i++, at += SCRIPT.gap) setTimeout(() => say(`第 ${i} 段，正在写。\n\n`), at);
		at += SCRIPT.stall - SCRIPT.gap;
		for (let i = 1; i <= SCRIPT.second; i++, at += SCRIPT.gap) setTimeout(() => say(`停顿之后第 ${i} 段。\n\n`), at);
		setTimeout(() => {
			emit(res, "content_block_stop", { index: 0 });
			emit(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
			emit(res, "message_stop", {});
			res.end();
		}, at + SCRIPT.tail);
	});
});

const PANE = '[data-dock-pane="conversation"]';
const TA = `${PANE} textarea`;

/** 每一帧绘制之后：最后一个问题的上沿、离底多远、末尾那一行的高度和透明度、正文多长。 */
const SAMPLER = `(()=>{window.__s=[];const pane=${JSON.stringify(PANE)};let sc=null;const f=()=>{setTimeout(()=>{
const qs=document.querySelectorAll(pane+' [data-question-index]');const last=qs[qs.length-1];
if(!sc||!sc.isConnected){sc=last;while(sc&&!(/(auto|scroll)/.test(getComputedStyle(sc).overflowY)&&sc.scrollHeight>sc.clientHeight))sc=sc.parentElement;}
const rows=document.querySelectorAll(pane+' .ly-transcript > .ly-reveal');const row=rows[rows.length-1];
window.__s.push({t:Date.now(),ref:last?last.getBoundingClientRect().top:null,n:qs.length,dist:sc?sc.scrollHeight-sc.scrollTop-sc.clientHeight:null,
rowH:row?row.getBoundingClientRect().height:null,rowO:row?parseFloat(getComputedStyle(row.firstElementChild?.firstElementChild??row).opacity)*parseFloat(getComputedStyle(row).opacity):null,
kids:window.__dump?[...document.querySelector(pane+' .ly-transcript > .flex').children].slice(-4).map(k=>(k.textContent.slice(0,14))+':'+Math.round(k.getBoundingClientRect().height)).join(' | '):null,
text:(document.querySelector(pane+' .ly-transcript')?.textContent.match(/正在写。|停顿之后/g)??[]).length});},0);requestAnimationFrame(f);};requestAnimationFrame(f);})()`;

type Sample = { t: number; ref: number | null; n: number; dist: number | null; rowH: number | null; rowO: number | null; text: number };

/** 一段窗口里转录的走法：最大单帧挪动、往下（反方向）走过多少、净挪了多少。 */
function motion(span: Sample[]) {
	const values = span.filter((s) => s.ref !== null).map((s) => s.ref!);
	let jump = 0;
	let down = 0;
	for (let i = 1; i < values.length; i++) {
		const step = values[i] - values[i - 1];
		jump = Math.max(jump, Math.abs(step));
		down = Math.max(down, step);
	}
	return { jump, down, net: values.length ? values.at(-1)! - values[0] : 0, path: values.map((v) => v.toFixed(1)).join(" ") };
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
	if (process.env.DUMP) await app.evaluate("window.__dump=1");
	await app.evaluate(SAMPLER);
	camera.rolling = true;
	filming = (async () => {
		while (camera.rolling) film.push({ at: Date.now(), data: await grab.shot() });
	})();
	await pause(600);
	await click(app, TA);
	await type(app, TA, "热身");
	await press(app, "Enter", 13);
	await until(app, `!document.querySelector('[data-composer-send="stop"]')&&document.querySelector('${PANE} .ly-transcript')?.textContent.includes('好。')`, 8000);
	await pause(1200);
	await click(app, TA);
	await type(app, TA, "写几段，中间停一下");
	await press(app, "Enter", 13);
	await until(app, `!document.querySelector('[data-composer-send="stop"]')&&document.querySelector('${PANE} .ly-transcript')?.textContent.includes('停顿之后第 2 段')`, 15000);
	await pause(1200);
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_这一轮结束.png`), Buffer.from((await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));

	const all = (await app.evaluate<Sample[]>("window.__s")).filter((s) => s.t >= started);
	const landed = all.findIndex((s, i) => i > 0 && s.n !== all[i - 1].n);
	const turn = all.slice(landed + 1);
	const firstText = turn.findIndex((s) => s.text > 0);
	const lastFirst = turn.findIndex((s) => s.text >= SCRIPT.first);
	const resume = turn.findIndex((s) => s.text > SCRIPT.first);
	const pick = (from: number, to: number) => turn.filter((s) => s.t >= from && s.t <= to);
	const around = (i: number) => (i < 0 ? [] : pick(turn[i].t - 200, turn[i].t + 450));

	const log = (name: string, span: Sample[]) => {
		const m = motion(span);
		console.log(`\n【${name}】${span.length} 帧`);
		console.log(`   那一行高度 ${span.map((s) => s.rowH?.toFixed(0) ?? "—").join(" ")}`);
		console.log(`   那一行不透明度 ${span.map((s) => s.rowO?.toFixed(2) ?? "—").join(" ")}`);
		console.log(`   转录参照 ${m.path}`);
		return m;
	};

	const think = log("想的那一段（字到之前）", pick((turn[0]?.t ?? 0) + 500, (turn[firstText]?.t ?? 0) - 20));
	if (process.env.DUMP) for (const s of all.slice(Math.max(landed - 2, 0), landed + 6)) console.log(s.n, s.ref?.toFixed(1), s.dist, (s as Sample & { kids?: string }).kids);
	const opening = log("用户消息落下、那一行出现", all.slice(Math.max(landed - 2, 0), landed + 40));
	const first = log("第一段字到", around(firstText));
	// 停顿窗口收在字接着来之前 150ms：`answering` 先于字画出来变回 true，最后几帧那一行已经在淡出。
	const stallSpan = pick(turn[lastFirst]?.t + 400, turn[resume]?.t - 150);
	const stall = log("停顿里", stallSpan);
	const back = log("停顿后字接着来", around(resume));

	check(`那一行出现：转录不往下走（往下走过 ${opening.down.toFixed(1)}px，最大单帧 ${opening.jump.toFixed(1)}px）`, opening.down <= 0.5);
	check(`想的那一段：转录不动（最大单帧 ${think.jump.toFixed(1)}px）`, think.jump <= 0.5);
	check(`第一段字到：没有整块跳（最大单帧 ${first.jump.toFixed(1)}px，往下走过 ${first.down.toFixed(1)}px）`, first.jump <= 8 && first.down <= 0.5);
	check(`停顿里那一行回来：转录不动（净 ${stall.net.toFixed(1)}px，最大单帧 ${stall.jump.toFixed(1)}px）`, Math.abs(stall.net) <= 1 && stall.jump <= 0.5);
	const visibleInStall = stallSpan.at(-1)?.rowO ?? 0;
	check(`停顿里那一行看得见（不透明度 ${visibleInStall.toFixed(2)}）`, visibleInStall >= 0.95);
	const hiddenWhileWriting = turn[lastFirst]?.rowO ?? 1;
	check(`字在来的时候那一行看不见（不透明度 ${hiddenWhileWriting.toFixed(2)}）`, hiddenWhileWriting <= 0.05);
	check(`停顿后字接着来：没有整块跳（最大单帧 ${back.jump.toFixed(1)}px，往下走过 ${back.down.toFixed(1)}px）`, back.jump <= 8 && back.down <= 0.5);
	const end = log("这一轮收尾", pick(started + END_MS - 150, started + END_MS + 900));
	// 收尾时回答底下长出一行时间和复制按钮，这一行同一帧让位：只挪两者的差，而且不往回沉。
	check(`这一轮收尾：刚读完的那段话不往下沉、不整块跳（净 ${end.net.toFixed(1)}px，最大单帧 ${end.jump.toFixed(1)}px，往下走过 ${end.down.toFixed(1)}px）`, end.down <= 0.5 && end.jump <= 10);
	const away = Math.max(...turn.map((s) => s.dist ?? 0));
	console.log(`\n   整轮离底最大 ${away.toFixed(1)}px`);
} finally {
	camera.rolling = false;
	await filming.catch(() => {});
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (film.length > 0) await encode(film, join(OUT_DIR, `${STAMP}_${LABEL}_回答中运行行收起与回来_${passed}of${checks.length}.mp4`), 30);
	grab.close();
	await app.stop();
	await renderer.close();
	model.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
