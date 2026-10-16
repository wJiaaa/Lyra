/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 欢迎页发出第一条：对话页的输入框从底边升起来的那一段，逐帧是什么样。
 *
 * 欢迎页和对话页各挂一个输入框（见 `Composer.tsx` 的 `sentAt`）。新框只在自己的位置上升起，
 * 不从欢迎页那个框的位置滑下来，所以离开欢迎页之后，框的顶边一帧也不该高过它最终停的地方。
 * 逐帧记下框的顶边、宽度、透明度，以及这一帧画的是哪个实例、页面处在哪种状态。
 *
 * 先量反面：从欢迎页点开一个已有会话，换的是页面，框直接在底部，不升也不滑。
 *
 * 用法：node --experimental-strip-types e2e/composer-handoff-probe.ts [输出目录]
 */

import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { startApp, type RunningApp } from "./app.ts";
import { click, openSession, press, type, until } from "./drive.ts";
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
	opacity: number;
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
			out.push({ t: Math.round(performance.now() - t0), top: Math.round(r.top), width: Math.round(r.width), center: Math.round(r.left + r.width / 2), instance: ids.get(card), surface, animations: column ? column.getAnimations().length : -1, opacity: column ? Number(getComputedStyle(column).opacity) : 1 });
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

		await app.evaluate(SAMPLER);
		await openSession(app, "qa-short");
		await new Promise((r) => setTimeout(r, 1800));
		const switched = await app.evaluate<Sample[]>("window.__handoff");
		const moving = switched.filter((s) => s.animations > 0).length;
		const settled = switched.filter((s) => s.surface !== "empty");
		const stops = new Set(settled.map((s) => s.top)).size;
		console.log(`\n── 点开已有会话：页面经过 ${[...new Set(switched.map((s) => s.surface))].join(" → ")}；离开欢迎页后顶边停在 ${stops} 处 ──`);
		check("点开已有会话时输入框不滑动", moving === 0, `${moving} 帧挂着动画`);
		check("点开已有会话时输入框一步到底", stops === 1, `顶边经过 ${[...new Set(settled.map((s) => s.top))].join(" → ")}`);

		await click(app, 'button[aria-label="在「交互验证」里新建会话"]');
		await until(app, `document.querySelector(${JSON.stringify(field)})`, 5000);
		await new Promise((r) => setTimeout(r, 1200));
		await type(app, field, "帮我看看这个项目的结构");
		await new Promise((r) => setTimeout(r, 800));

		await app.evaluate(SAMPLER);
		await press(app, "Enter", 13);
		await new Promise((r) => setTimeout(r, 2200));
		await stop();

		const samples = await app.evaluate<Sample[]>("window.__handoff");
		console.log("\n── 逐帧（t ms · 实例 · 页面 · top · width · 透明度 · 动画数）──");
		let previous: Sample | null = null;
		for (const s of samples) {
			if (previous && previous.top === s.top && previous.width === s.width && previous.opacity === s.opacity && previous.instance === s.instance && previous.surface === s.surface) continue;
			console.log(`   ${String(s.t).padStart(5)} · #${s.instance} · ${s.surface.padEnd(8)} · ${String(s.top).padStart(4)} · ${String(s.width).padStart(4)} · ${s.opacity.toFixed(2)} · ${s.animations}`);
			previous = s;
		}

		const arrived = samples.filter((s) => s.surface !== "empty");
		const first = arrived[0];
		const last = arrived[arrived.length - 1];
		if (!first || !last) throw new Error("没采到对话页的输入框");
		const highest = Math.min(...arrived.map((s) => s.top));
		const rise = first.top - last.top;
		const widths = new Set(arrived.map((s) => s.width));
		console.log(`\n   页面经过：${[...new Set(samples.map((s) => s.surface))].join(" → ")}；对话页第一帧 top ${first.top}、透明度 ${first.opacity.toFixed(2)}；停在 ${last.top}`);
		console.log(`   宽度：${[...widths].join(" / ")}；结束时 column 上还挂着 ${last.animations} 段动画\n`);

		check("不从中间滑下来：离开欢迎页后顶边没有高过终点", highest >= last.top - 1, `最高 ${highest}，终点 ${last.top}`);
		check("宽度一开始就是对话那一栏，不再横着拉开", widths.size === 1, [...widths].join(" / "));
		if (REDUCED) {
			check("减少动态效果时直接到位、不透明", rise === 0 && first.opacity === 1, `升起 ${rise}px，第一帧透明度 ${first.opacity}`);
		} else {
			check("从底边升起（第一帧在终点下方 ≤ 16px）", rise > 0 && rise <= 16, `${first.top} → ${last.top}，升起 ${rise}px`);
			check("升起时淡入", first.opacity < 0.5 && last.opacity === 1, `${first.opacity.toFixed(2)} → ${last.opacity}`);
		}
		check("动画播完不留残余", last.animations === 0, `${last.animations} 段`);
	} finally {
		await app?.stop();
		model.close();
	}
	const passed = checks.filter((c) => c.ok).length;
	await mkdir(OUT_DIR, { recursive: true });
	const label = REDUCED ? "减少动态效果" : "切会话不动_发送从底部升起";
	const out = join(OUT_DIR, `${STAMP}_${label}_${passed}of${checks.length}.mp4`);
	await encode(frames, out);
	console.log(`\n   录屏：${out}`);
	process.exit(passed === checks.length ? 0 : 1);
}

await main();
