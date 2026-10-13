/* oxlint-disable no-console -- probe CLI: what it prints is the evidence */
/**
 * A preview card's height from the frame it mounts in to the one it settles on, in a real window.
 *
 * Four scenes, all in one profile, each a stored conversation opened from the sidebar:
 *
 *   fixed    a page whose body is `height: 360px`. The reporter used to lift that rule whenever the
 *            page did not fill the frame, measured 256 in the 440 the card starts at, and the card
 *            shrank past the page and grew back to 362 once the page overflowed it.
 *   slow     the same page, busy for two seconds before anything in it can run — a heavy page, or
 *            any page on a busy machine. The card's wait was counted from its mount: it ran out
 *            before the page existed, 440 was taken for the answer, remembered, and from then on the
 *            card could only grow.
 *   fold     a reply that calls preview and then goes back to reasoning in the same message
 *            ([thinking, preview, thinking, read]). That call stayed in a row of nothing but
 *            reasoning, which folds, and the page folded away with it.
 *   reopen   the window reloaded and `fixed` opened again: the card starts at the height it
 *            remembered and must not move. Inside its 1px border the page got 360 of its 362, sat
 *            exactly at its own height, measured 256 again and dipped.
 *
 * Every verdict comes from what the window drew: the card's and the frame's heights, frame by frame
 * from the mount, and where the frame sits relative to the fold.
 *
 *   node --experimental-strip-types e2e/preview-height-probe.ts [fixed,slow,fold,reopen] [label]
 *
 * Screenshots and the recording land in ~/Desktop/Plume预览卡片测试/.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { frames, openSession, until } from "./drive.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const PORT = 9643;
const OUT = join(homedir(), "Desktop", "Plume预览卡片测试");
const [SCENES = "fixed,slow,fold,reopen", LABEL = "修复后"] = process.argv.slice(2);
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** The page's own height. The frame should end at this plus the reporter's 2px of slack. */
const PAGE_HEIGHT = 360;
const SLOW_MS = 2000;

/** A body of a fixed height whose content, without that rule, composes to about 254px. */
const page = (title: string, holdMs = 0) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>${
	holdMs ? `<script>for(var until=Date.now()+${holdMs};Date.now()<until;);</script>` : ""
}<style>
*{box-sizing:border-box}
body{margin:0;height:${PAGE_HEIGHT}px;position:relative;display:grid;place-items:center;background:linear-gradient(160deg,#fff6e6,#ffe4c4);font-family:-apple-system,"PingFang SC",sans-serif;overflow:hidden}
.bubble{position:absolute;top:24px;left:50%;transform:translateX(-50%);background:#fff;border-radius:999px;padding:10px 22px;font-weight:600;font-size:15px;color:#7a4a1c;white-space:nowrap}
.dog{position:relative;width:200px;height:190px;margin-top:64px}
.ear{position:absolute;top:0;width:62px;height:72px;background:#f0953e;border-radius:12px 60px 6px 60px}
.ear.l{left:16px;transform:rotate(-14deg)}.ear.r{right:16px;transform:scaleX(-1) rotate(-14deg)}
.head{position:absolute;top:30px;left:10px;width:180px;height:150px;background:#f0953e;border-radius:48% 48% 44% 44%}
.mask{position:absolute;left:28px;right:28px;bottom:0;height:88px;background:#fff7ee;border-radius:50% 50% 46% 46%}
.eye{position:absolute;top:62px;width:22px;height:24px;background:#2b1d14;border-radius:50%}
.eye.l{left:50px}.eye.r{right:50px}
.nose{position:absolute;top:96px;left:50%;width:22px;height:15px;margin-left:-11px;background:#2b1d14;border-radius:50% 50% 60% 60%}
.chin{position:absolute;bottom:6px;left:50%;transform:translateX(-50%);font-size:12px;color:#7a4a1c}
</style></head><body>
<div class="bubble">${title}</div>
<div class="dog"><div class="ear l"></div><div class="ear r"></div><div class="head"><div class="mask"></div><div class="eye l"></div><div class="eye r"></div><div class="nose"></div></div></div>
<div class="chin">页面底边</div>
</body></html>`;

/** One conversation per scene; `reopen` opens `fixed` again. */
const SCENE = {
	fixed: { session: "probe-fixed", preview: "fixed1", title: "固定高度的小狗", themed: false, hold: 0, fold: false },
	slow: { session: "probe-slow", preview: "slow1", title: "晚两秒才报高度的小狗", themed: false, hold: SLOW_MS, fold: false },
	fold: { session: "probe-fold", preview: "fold1", title: "想完接着想的小狗", themed: true, hold: 0, fold: true },
} as const;
type Scene = (typeof SCENE)[keyof typeof SCENE];

const ANSWER = "画好了，就在上面。";

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1, providers: [], mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: null, permissionMode: "auto", thinking: "off", autoSummarizeTitle: false,
		appearance: { theme: "light" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
	}));
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const at = Date.now() - 600_000;
	const sessions = Object.values(SCENE).map((scene, n) => {
		const t = at + n * 60_000;
		const call = { type: "toolCall", id: `call_${scene.preview}`, name: "preview", arguments: { title: scene.title, html: "<p>…</p>" } };
		const shown = { role: "toolResult", toolCallId: call.id, toolName: "preview", content: [{ type: "text", text: `预览已生成：${scene.title}` }], details: { preview: { id: scene.preview, sessionId: scene.session, title: scene.title, entry: "index.html", ...(scene.themed ? { themed: true } : {}) } }, isError: false, timestamp: t + 3000 };
		const messages = scene.fold
			? [
				{ role: "user", content: [{ type: "text", text: "给我画一只小狗。" }], timestamp: t },
				// The shape under test: the preview is not the reply's last call, more reasoning follows it in the same message.
				{ role: "assistant", content: [{ type: "thinking", thinking: "先画一版页面。" }, call, { type: "thinking", thinking: "再读一下项目里的说明。" }, { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } }], stopReason: "toolUse", timestamp: t + 1000 },
				shown,
				{ role: "toolResult", toolCallId: "call_read", toolName: "read", content: [{ type: "text", text: "（空）" }], isError: false, timestamp: t + 3500 },
				{ role: "assistant", content: [{ type: "text", text: ANSWER }], stopReason: "stop", timestamp: t + 4000 },
			]
			: [
				{ role: "user", content: [{ type: "text", text: "给我画一只小狗。" }], timestamp: t },
				{ role: "assistant", content: [call], stopReason: "toolUse", timestamp: t + 1000 },
				shown,
				{ role: "assistant", content: [{ type: "text", text: ANSWER }], stopReason: "stop", timestamp: t + 4000 },
			];
		const meta = { id: scene.session, title: scene.title, cwd: project, projectId, projectName: "project", createdAt: t, updatedAt: t + 4000, modelId: "none", messageCount: messages.length, usage, seq: 0 };
		return { meta, records: [{ type: "meta", meta, ts: t }, ...messages.map((message) => ({ type: "message", message, ts: t }))] };
	});
	for (const scene of Object.values(SCENE)) {
		const dir = join(home, "previews", scene.session, scene.preview);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "index.html"), page(scene.title, scene.hold));
	}
	seedSessions(home, sessions as Parameters<typeof seedSessions>[1]);
}

// ---------------------------------------------------------------------------

let app: RunningApp | undefined;
/** One standing connection: a script registered for new documents lives only as long as the connection that asked. */
let grab: Awaited<ReturnType<typeof frameGrabber>> | undefined;
const checks: { scene: string; what: string; ok: boolean; saw: unknown }[] = [];
function check(scene: string, what: string, ok: boolean, saw: unknown) {
	checks.push({ scene, what, ok, saw });
	console.log(`   ${ok ? "✅" : "❌"} [${scene}] ${what}\n      ${JSON.stringify(saw)}`);
}

/**
 * A log of every preview card's life, kept by the window itself from before the card exists — for
 * the reload, from before the app's own code runs. Per frame: the card's outer height, the frame's
 * own height (what the page is given) and the frame's opacity (whether anyone can see it yet).
 */
const TRACE = `(() => {
	if (window.__previewTrace) return;
	const t0 = performance.now();
	const events = [];
	window.__previewTrace = events;
	const at = () => Math.round(performance.now() - t0);
	addEventListener('load', (event) => {
		if (event.target && event.target.tagName === 'IFRAME') events.push({ t: at(), title: event.target.title, kind: 'load' });
	}, true);
	addEventListener('message', (event) => {
		const h = event.data && event.data.__dwPreviewHeight;
		if (typeof h !== 'number') return;
		const frame = [...document.querySelectorAll('main iframe')].find((f) => f.contentWindow === event.source);
		events.push({ t: at(), title: frame ? frame.title : '?', kind: 'report', h });
	}, true);
	const write = Storage.prototype.setItem;
	Storage.prototype.setItem = function (key, value) {
		if (String(key).startsWith('ly-preview-height:')) events.push({ t: at(), title: String(key), kind: 'remember', h: Number(value) });
		return write.call(this, key, value);
	};
	const last = new Map();
	const tick = () => {
		for (const frame of document.querySelectorAll('main [data-ly-preview] iframe')) {
			if (!frame.checkVisibility()) continue;
			const card = frame.closest('[data-ly-preview]');
			const h = Math.round(card.getBoundingClientRect().height);
			const inner = Math.round(frame.getBoundingClientRect().height);
			const op = Math.round(Number(getComputedStyle(frame).opacity) * 100) / 100;
			const key = h + '/' + inner + '/' + op;
			if (last.get(frame) !== key) {
				if (!last.has(frame)) events.push({ t: at(), title: frame.title, kind: 'mount' });
				last.set(frame, key);
				events.push({ t: at(), title: frame.title, kind: 'frame', h, inner, op });
			}
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

interface TraceEvent {
	t: number;
	title: string;
	kind: "mount" | "load" | "report" | "remember" | "frame";
	h?: number;
	inner?: number;
	op?: number;
}

const traced = async (scene: Scene) =>
	(await app!.evaluate<TraceEvent[]>("window.__previewTrace || []")).filter((one) => one.title === scene.title || one.title.endsWith(`/${scene.preview}`));

function timeline(events: TraceEvent[]): string {
	const start = events.find((one) => one.kind === "mount")?.t ?? events[0]?.t ?? 0;
	return events
		.map((one) => {
			const t = String(one.t - start).padStart(6);
			if (one.kind === "frame") return `${t}ms  frame     card ${one.h}  frame ${one.inner}  opacity ${one.op}`;
			if (one.kind === "report" || one.kind === "remember") return `${t}ms  ${one.kind.padEnd(8)}  ${one.h}`;
			return `${t}ms  ${one.kind}`;
		})
		.join("\n");
}

/** The heights a card passed through while it could be seen, kept where it changed direction. */
function turns(heights: number[]): number[] {
	const path: number[] = [];
	for (const h of heights) {
		const [a, b] = path.slice(-2);
		if (path.length >= 2 && (b - a) * (h - b) >= 0) path[path.length - 1] = h;
		else if (path.at(-1) !== h) path.push(h);
	}
	return path;
}

/** Frame by frame, while visible: from where it shows up to where it settles, one way only. */
function judgeFrames(scene: string, events: TraceEvent[]) {
	const seen = events.flatMap((one) => (one.kind === "frame" && (one.op ?? 0) > 0 ? [one.h!] : []));
	const path = turns(seen);
	const first = seen[0] ?? 0;
	const last = seen.at(-1) ?? 0;
	const oneWay = path.length <= 2 && seen.every((h) => h >= Math.min(first, last) - 1 && h <= Math.max(first, last) + 1);
	check(scene, "逐帧（看得见的帧）：卡片高度只朝一个方向走，没有缩过头再长回来", seen.length > 0 && oneWay, { frames: seen.length, path });
}

interface Reading {
	card: number | null;
	frame: number | null;
	shown: boolean;
	inProcess: boolean | null;
	open: string | null;
	order: { line: number; cardTop: number; cardBottom: number; answer: number } | null;
}

const read = (scene: Scene) =>
	app!.evaluate<Reading>(`(() => {
	const all = [...document.querySelectorAll('main iframe')].filter((f) => f.title === ${JSON.stringify(scene.title)});
	// Kept in the DOM while folded, so the visible one if there is one, and otherwise whichever there is.
	const frame = all.find((f) => f.checkVisibility()) ?? all[0];
	const card = frame ? frame.closest('[data-ly-preview]') : null;
	const block = [...document.querySelectorAll('main [data-ly-turn-process]')].find((el) => el.checkVisibility());
	const toggle = block ? block.querySelector('button[aria-expanded]') : null;
	const answer = [...document.querySelectorAll('main [data-ly-transcript-rows] *')].find((el) => el.children.length === 0 && el.checkVisibility() && el.textContent.includes(${JSON.stringify(ANSWER)}));
	const r = (el) => el.getBoundingClientRect();
	return {
		card: card ? Math.round(r(card).height) : null,
		frame: frame ? Math.round(r(frame).height) : null,
		shown: Boolean(frame && frame.checkVisibility() && getComputedStyle(frame).opacity === '1' && r(frame).height >= 100),
		inProcess: frame ? Boolean(frame.closest('[data-ly-turn-process]')) : null,
		open: toggle ? toggle.getAttribute('aria-expanded') : null,
		order: toggle && card && answer ? { line: Math.round(r(toggle).bottom), cardTop: Math.round(r(card).top), cardBottom: Math.round(r(card).bottom), answer: Math.round(r(answer).top) } : null,
	};
})()`);

const remembered = (scene: Scene) => app!.evaluate<string | null>(`localStorage.getItem('ly-preview-height:${scene.session}/${scene.preview}')`);

async function caption(text: string): Promise<void> {
	await app!.evaluate(`(() => {
		let tag = document.getElementById('probe-caption');
		if (!tag) {
			tag = document.createElement('div');
			tag.id = 'probe-caption';
			tag.style.cssText = 'position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;padding:6px 14px;border-radius:999px;background:rgba(229,72,77,.92);color:#fff;font:600 13px -apple-system,sans-serif';
			document.body.appendChild(tag);
		}
		tag.textContent = ${JSON.stringify(`${LABEL} · ${text}`)};
	})()`);
	await pause(1000);
}

async function shoot(scene: string, what: string): Promise<void> {
	const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT, `${STAMP}_${LABEL}_${scene}_${what}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`      截图 ${file}`);
}

/** Open a scene's conversation and wait until its card is visible and has stopped moving. */
async function openScene(scene: Scene): Promise<Reading> {
	await app!.evaluate(`window.__previewTrace && (window.__previewTrace.length = 0)`);
	await openSession(app!, scene.session);
	// The answer, not the page: a page folded away is never visible, and that is one of the things to see.
	await until(app!, `[...document.querySelectorAll('main [data-ly-transcript-rows] *')].some((el) => el.children.length === 0 && el.checkVisibility() && el.textContent.includes(${JSON.stringify(ANSWER)}))`, 900);
	return rest(scene);
}

async function rest(scene: Scene): Promise<Reading> {
	let last: Reading | null = null;
	// Long enough for the slow page and both of the card's waits.
	for (let i = 0; i < 40; i++) {
		await pause(250);
		const now = await read(scene);
		if (last && now.card === last.card && i >= 16) return now;
		last = now;
	}
	return last!;
}

const near = (value: number | null, target: number, slack = 2) => value !== null && Math.abs(value - target) <= slack;

async function sceneFixed(): Promise<void> {
	const scene = SCENE.fixed;
	await caption("固定高度（body 360px）的页面：卡片应直接落到页面高度，不先缩过头");
	const seen = await openScene(scene);
	const events = await traced(scene);
	console.log(timeline(events));
	await shoot("fixed", "落定");
	check("fixed", `框给页面的高度是页面的 ${PAGE_HEIGHT}px 加 2px 余量`, near(seen.frame, PAGE_HEIGHT + 2), seen);
	check("fixed", "页面第一次报的就是它自己的高度，不是摘掉高度规则量出来的 256", events.find((one) => one.kind === "report")?.h === PAGE_HEIGHT + 2, events.filter((one) => one.kind === "report").map((one) => one.h));
	judgeFrames("fixed", events);
	check("fixed", "记下的高度是页面的高度", (await remembered(scene)) === String(PAGE_HEIGHT + 2), await remembered(scene));
}

async function sceneSlow(): Promise<void> {
	const scene = SCENE.slow;
	await caption(`页面开头忙 ${SLOW_MS / 1000} 秒才说得出自己多高：卡片应照样跟到页面高度，不锁在 440`);
	const seen = await openScene(scene);
	const events = await traced(scene);
	console.log(timeline(events));
	await shoot("slow", "落定");
	check("slow", `晚到的高度照样被采纳：框是 ${PAGE_HEIGHT + 2} 上下，不是 440`, near(seen.frame, PAGE_HEIGHT + 2), seen);
	check("slow", "440 没有被当成量好的高度记下来", !events.some((one) => one.kind === "remember" && one.h === 440), events.filter((one) => one.kind === "remember").map((one) => one.h));
	judgeFrames("slow", events);
}

async function sceneFold(): Promise<void> {
	const scene = SCENE.fold;
	await caption("调用 preview 之后同一条回复里接着想：页面应在折叠行外面");
	const seen = await openScene(scene);
	await shoot("fold", "收着");
	check("fold", "过程是收着的", seen.open === "false", { open: seen.open });
	check("fold", "收着的时候页面画在对话里，不在折叠里", seen.shown && seen.inProcess === false, { shown: seen.shown, inProcess: seen.inProcess });
	const order = seen.order;
	check("fold", "从上到下：折叠行 → 页面 → 回答", Boolean(order && order.line <= order.cardTop && order.cardBottom <= order.answer), order);
}

async function sceneReopen(): Promise<void> {
	const scene = SCENE.fixed;
	const before = await remembered(scene);
	await caption(`记下的高度是 ${before}px，重新载入窗口再打开`);
	// Electron runs a script registered this way only once the Page domain is on — without it, silently nothing.
	await grab!.send("Page.enable", {});
	await grab!.send("Page.addScriptToEvaluateOnNewDocument", { source: TRACE });
	await grab!.send("Page.reload", {});
	await pause(1500);
	await until(app!, `document.querySelector('main textarea')`, 1800);
	await frames(app!, 30);
	const current = await app!.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row="${scene.session}"] > button[aria-current]'))`);
	if (!current) await openSession(app!, scene.session);
	await until(app!, `[...document.querySelectorAll('main iframe')].some((f) => f.title === ${JSON.stringify(scene.title)} && f.checkVisibility())`, 900);
	const seen = await rest(scene);
	const events = await traced(scene);
	console.log(timeline(events));
	await caption(`重开：卡片 ${seen.card}px，框 ${seen.frame}px`);
	await shoot("reopen", "重开");
	const cards = events.flatMap((one) => (one.kind === "frame" ? [one.h!] : []));
	check("reopen", "重开后卡片一帧都不动（从挂上起所有帧同一个高度）", cards.length > 0 && new Set(cards).size === 1, { path: turns(cards) });
	check("reopen", "重开后框还是页面的高度", near(seen.frame, PAGE_HEIGHT + 2), seen);
	const after = await remembered(scene);
	const writes = events.filter((one) => one.kind === "remember").map((one) => one.h);
	// Ending where it started is not enough: on the way, 256 was written over it and then 362 again.
	check("reopen", "记下的高度没被改写，中途也没有", after === before && writes.every((h) => String(h) === before), { before, after, writes });
}

async function main(): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const film: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	/*
	 * Shot by shot rather than `startRecording`: a screencast only gets frames the compositor draws,
	 * and a window covered by another one — the terminal running this — is not drawn. A screenshot
	 * forces the frame. Kept rolling through the reload, when for a moment there is nothing to shoot.
	 */
	grab = await frameGrabber(PORT);
	const camera = { rolling: true };
	const reel = (async () => {
		while (camera.rolling) {
			try {
				film.push({ at: Date.now(), data: await grab!.shot() });
			} catch {
				if (!camera.rolling) return;
			}
			await pause(100);
		}
	})();
	const stop = async () => {
		camera.rolling = false;
		await Promise.race([reel, pause(3000)]);
		grab?.close();
	};
	try {
		await until(app, `document.querySelector('main textarea')`, 1800);
		await app.evaluate(TRACE);
		await pause(800);
		const scenes: Record<string, () => Promise<void>> = { fixed: sceneFixed, slow: sceneSlow, fold: sceneFold, reopen: sceneReopen };
		for (const name of SCENES.split(",")) {
			console.log(`\n== ${name}（${LABEL}）`);
			try {
				await scenes[name]!();
			} catch (error) {
				check(name, "场景跑完", false, String((error as Error)?.stack ?? error));
			}
			await pause(1200);
		}
	} finally {
		await stop();
		await app.stop();
	}
	const passed = checks.filter((one) => one.ok).length;
	const out = join(OUT, `${STAMP}_${LABEL}_预览卡片高度与折叠_${passed}of${checks.length}.mp4`);
	if (film.length > 0) await encode(film, out, 30, 2000);
	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exitCode = 1;
});
