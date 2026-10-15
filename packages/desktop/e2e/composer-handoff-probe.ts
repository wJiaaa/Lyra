/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 欢迎页发出第一条：输入框从标题下面走到底部的那一段，逐帧是什么样。
 *
 * 欢迎页和对话页各挂一个输入框（见 `Composer.tsx` 的 `handoff`），看上去是同一个框换了位置。
 * 换的那一下要是一帧瞬移、或者半路被另一个实例接走而跳到终点，人看到的就是「生硬」。
 * 所以逐帧记下框的顶边、宽度、横向中心，以及这一帧画的是哪个实例、页面处在哪种状态。
 *
 * 用法：node --experimental-strip-types e2e/composer-handoff-probe.ts [输出目录]
 */

import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { startApp, type RunningApp } from "./app.ts";
import { press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, startRecording, type Frame } from "./record.ts";

const PORT = 9761;
const MODEL_PORT = 9762;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume输入框交接测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const REDUCED = process.env.REDUCE_MOTION === "1";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ——  ${saw}`);
}

/** 一句话就答完的假模型：这里要看的是发送那一刻，不是回答。 */
function startModel(): Server {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const sse = (payload: { type: string }) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse({ type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as { type: string });
			sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as { type: string });
			sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好的。" } } as { type: string });
			sse({ type: "content_block_stop", index: 0 } as { type: string });
			sse({ type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

interface Sample {
	t: number;
	top: number;
	width: number;
	center: number;
	instance: number;
	surface: string;
	animations: number;
}

/*
 * 页面里挂一个 rAF 采样器。量的是卡片 `.ly-composer`——人看到的就是它。实例编号用 WeakMap 发，
 * 换了一个元素就换一个号，半路被另一个框接走的那一帧在序列里看得出来。
 */
const SAMPLER = `(() => {
	const ids = new WeakMap();
	let next = 0;
	const out = [];
	window.__handoff = out;
	const t0 = performance.now();
	const tick = () => {
		const card = [...document.querySelectorAll('.ly-composer-dock .ly-composer')].find((el) => el.checkVisibility());
		const surface = document.querySelector('[data-ly-chat-surface]')?.getAttribute('data-ly-chat-surface') ?? '-';
		if (card) {
			if (!ids.has(card)) ids.set(card, next++);
			const r = card.getBoundingClientRect();
			const column = card.closest('.ly-composer-dock > div');
			out.push({ t: Math.round(performance.now() - t0), top: Math.round(r.top), width: Math.round(r.width), center: Math.round(r.left + r.width / 2), instance: ids.get(card), surface, animations: column ? column.getAnimations().length : -1 });
		}
		if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return true;
})()`;

async function main(): Promise<void> {
	const model = startModel();
	let app: RunningApp | null = null;
	const frames: Frame[] = [];
	try {
		app = await startApp({ port: PORT, seed: (home) => seedInteractions(home, MODEL_PORT) });
		if (REDUCED) await app.evaluate(`document.documentElement.dataset.reduceMotion = "on"`);
		const stop = await startRecording(PORT, frames);
		const field = '[data-ly-chat-surface="empty"] textarea';
		await until(app, `document.querySelector(${JSON.stringify(field)})`, 30000);
		await new Promise((r) => setTimeout(r, 800));
		await type(app, field, "帮我看看这个项目的结构");
		await new Promise((r) => setTimeout(r, 800));

		await app.evaluate(SAMPLER);
		await press(app, "Enter", 13);
		await new Promise((r) => setTimeout(r, 2200));
		await stop();

		const samples = await app.evaluate<Sample[]>("window.__handoff");
		console.log("\n── 逐帧（t ms · 实例 · 页面 · top · width · 中心 · 动画数）──");
		let previous: Sample | null = null;
		for (const s of samples) {
			if (previous && previous.top === s.top && previous.width === s.width && previous.instance === s.instance && previous.surface === s.surface) continue;
			console.log(`   ${String(s.t).padStart(5)} · #${s.instance} · ${s.surface.padEnd(8)} · ${String(s.top).padStart(4)} · ${String(s.width).padStart(4)} · ${s.center} · ${s.animations}`);
			previous = s;
		}

		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || !last) throw new Error("一帧都没采到");
		const travel = Math.abs(last.top - first.top);
		let biggest = 0;
		for (let i = 1; i < samples.length; i++) biggest = Math.max(biggest, Math.abs(samples[i].top - samples[i - 1].top));
		const widths = samples.map((s) => s.width);
		const monotonic = widths.every((w, i) => i === 0 || w >= widths[i - 1] - 1);
		const instances = new Set(samples.map((s) => s.instance)).size;
		const surfaces = [...new Set(samples.map((s) => s.surface))].join(" → ");

		console.log(`\n   页面经过：${surfaces}；实例 ${instances} 个；纵向总位移 ${travel}px；单帧最大位移 ${biggest}px`);
		console.log(`   宽度：${first.width} → ${last.width}；结束时 column 上还挂着 ${last.animations} 段动画\n`);

		if (REDUCED) {
			check("减少动态效果时直接到位", biggest === travel, `单帧最大位移 ${biggest}px，总位移 ${travel}px`);
		} else {
			check("顶边没有一帧瞬移（单帧位移 ≤ 总位移的 35%）", travel > 0 && biggest <= travel * 0.35, `单帧最大 ${biggest}px / 总 ${travel}px`);
			check("宽度一路变宽，没有回缩", monotonic, `${widths[0]} → ${widths[widths.length - 1]}`);
			check("横向中心前后一致", Math.abs(last.center - first.center) <= 1, `${first.center} → ${last.center}`);
		}
		check("动画播完不留残余", last.animations === 0, `${last.animations} 段`);
	} finally {
		await app?.stop();
		model.close();
	}
	const passed = checks.filter((c) => c.ok).length;
	await mkdir(OUT_DIR, { recursive: true });
	const label = REDUCED ? "减少动态效果" : "欢迎页发出第一条";
	const out = join(OUT_DIR, `${STAMP}_${label}_${passed}of${checks.length}.mp4`);
	await encode(frames, out);
	console.log(`\n   录屏：${out}`);
	process.exit(passed === checks.length ? 0 : 1);
}

await main();
