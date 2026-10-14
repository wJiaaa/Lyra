/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * 弹窗开、关的动画：逐帧采样卡片的缩放、透明度和遮罩，录一段视频，
 * 浅色深色各拍一张打开后的样子。
 *
 * Run: node --experimental-strip-types e2e/dialog-motion-probe.ts <输出目录> <前缀>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSettings, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT = process.argv[2]!;
const PREFIX = process.argv[3] ?? "dialog";
const PORT = 9533;
const DAY = 86_400_000;
const DELETE = 'button[aria-label="删除「重构登录流程并补上单元测试」"]';
const results: boolean[] = [];

function check(what: string, ok: boolean, saw: unknown): void {
	results.push(ok);
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

/** rAF 采样，跑在页面里：CDP 一来一回比一帧长，在外面问只能问到三四帧。 */
const SAMPLE = `window.__samples = []; (() => {
	const start = performance.now();
	const tick = () => {
		const card = document.querySelector("[data-ly-modal]");
		const scrim = document.querySelector("[data-ly-overlay]");
		if (card && scrim) {
			const m = new DOMMatrix(getComputedStyle(card).transform);
			window.__samples.push({ t: Math.round(performance.now() - start), scale: +m.a.toFixed(3), ty: +m.f.toFixed(1), card: +(+getComputedStyle(card).opacity).toFixed(2), scrim: +(+getComputedStyle(scrim).opacity).toFixed(2), blur: getComputedStyle(scrim).backdropFilter, bg: getComputedStyle(scrim).backgroundColor });
		}
		if (performance.now() - start < 450) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

type Sample = { t: number; scale: number; ty: number; card: number; scrim: number; blur: string; bg: string };

async function launch(theme: "light" | "dark"): Promise<RunningApp> {
	const app = await startApp({
		port: PORT,
		seed: async (dir) => {
			const project = join(dir, "project");
			await mkdir(project, { recursive: true });
			await writeFile(join(dir, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
			const at = Date.now() - 3 * DAY;
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
			const meta = { id: "gone-1", title: "重构登录流程并补上单元测试", cwd: project, projectId: "dddddddddddddddd", projectName: "project", createdAt: at, updatedAt: at, modelId: "x/y", messageCount: 24, seq: 1, usage, archived: true };
			seedSessions(dir, [{ meta, records: [{ type: "meta", meta }, { type: "message", message: { role: "user", content: [{ type: "text", text: "早先的一句" }], timestamp: at } }] }]);
			await writeFile(join(dir, "settings.json"), JSON.stringify({
				version: 1, uiLocale: "zh-CN", providers: [], mcpServers: [],
				projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: Date.now() }],
				hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [], appearance: { theme, reduceMotion: "off" },
			}));
		},
	});
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
	await frames(app, 30);
	await openSettings(app, "已归档的聊天");
	await click(app, "main button", "project，1 个会话");
	await frames(app, 30);
	return app;
}

async function openAndSample(app: RunningApp): Promise<Sample[]> {
	await app.evaluate(SAMPLE);
	await click(app, DELETE);
	await pause(600);
	return app.evaluate<Sample[]>("window.__samples");
}

async function closeAndSample(app: RunningApp): Promise<Sample[]> {
	await app.evaluate(SAMPLE);
	await click(app, "[data-ly-modal] button", "取消");
	await pause(600);
	await until(app, `!document.querySelector("[data-ly-modal]")`);
	return app.evaluate<Sample[]>("window.__samples");
}


/**
 * 动画放到最后一帧时拍一张，放它结束、样式回到 `transform: none` 后再拍一张，比两张卡片里的像素。
 *
 * 文字「动一下」就发生在这一刻：动画期间卡片是单独的合成层，结束时层被撤掉、文字按像素网格重画。
 * 两张一样就是没跳。
 */
async function settleSnap(app: RunningApp): Promise<boolean> {
	await click(app, DELETE);
	await app.evaluate(`(() => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = a.effect.getComputedTiming().endTime - 0.01; } })()`);
	await frames(app, 4);
	const box = await app.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector("[data-ly-modal]").getBoundingClientRect(); return { x: Math.floor(r.x) + 8, y: Math.floor(r.y) + 8, width: Math.floor(r.width) - 16, height: Math.floor(r.height) - 16 }; })()`);
	const grab = async () => (await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } })).data;
	const during = await grab();
	await app.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
	await frames(app, 6);
	const after = await grab();
	await writeFile(join(OUT, `${PREFIX}_最后一帧.png`), Buffer.from(during, "base64"));
	await writeFile(join(OUT, `${PREFIX}_结束后.png`), Buffer.from(after, "base64"));
	const y = await app.evaluate<number>(`document.querySelector("[data-ly-modal]").getBoundingClientRect().y`);
	console.log(`   卡片 y = ${y}`);
	await click(app, "[data-ly-modal] button", "取消");
	await pause(400);
	return during === after;
}

const brief = (samples: Sample[]) => samples.map((s) => `${s.t}ms s${s.scale} y${s.ty} c${s.card} m${s.scrim}`).join(" | ");

await mkdir(OUT, { recursive: true });
for (const theme of ["light", "dark"] as const) {
	console.log(`\n== ${theme}`);
	const app = await launch(theme);
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await pause(800);
		const opening = await openAndSample(app);
		console.log(`   开：${brief(opening)}`);
		const last = opening.at(-1)!;
		check("打开后卡片停在 1 倍、不透明、不位移", last.scale === 1 && last.card === 1 && last.ty === 0, last);
		check("遮罩只压暗不模糊：22% 黑", last.blur === "none" && last.bg === "rgba(0, 0, 0, 0.22)", { blur: last.blur, bg: last.bg });
		check("第一帧是从缩小处开始的（不是从下方升上来）", opening[0]!.scale < 0.99 && opening[0]!.ty === 0, opening[0]);
		const settled = opening.find((s) => s.scale === 1 && s.card === 1);
		check("进场从出现起 200ms 内放完", !!settled && settled.t - opening[0]!.t <= 200, settled && settled.t - opening[0]!.t);
		await closeAndSample(app);
		await pause(500);
		check("动画最后一帧和结束后的文字像素一致（不跳）", await settleSnap(app), "");
		await openAndSample(app);
		const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT, `${PREFIX}_${theme}_打开后.png`), Buffer.from(image.data, "base64"));
		await pause(1000);
		const closing = await closeAndSample(app);
		console.log(`   关：${brief(closing)}`);
		check("退场是缩回去、淡掉", closing.length > 0 && closing.at(-1)!.scale < 1 && closing.at(-1)!.card < 0.5, closing.at(-1));
		await pause(800);
		// 再开一次，放慢看：同一段动画在视频里多出现一遍。
		await openAndSample(app);
		await pause(1000);
		await closeAndSample(app);
		await pause(800);
	} finally {
		await stop();
		await app.stop();
		// 下一轮用同一个调试端口；上一个 Electron 退出后端口要过一会儿才放出来。
		await pause(2000);
	}
	if (theme === "light") await encode(recorded, join(OUT, `${PREFIX}_${theme}_开关动画.mp4`), 60, 1200);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`);
