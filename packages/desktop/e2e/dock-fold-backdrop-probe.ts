/* oxlint-disable no-console -- probe CLI plumbing that prints what it measured */
/**
 * 右栏收起、展开的那 220ms 里，窗口底色有没有从面板和缝里透上来。
 *
 * 毛玻璃是窗口底下的系统材质，CDP 拍不到它；`screencapture -l` 要屏幕录制权限，跑用例的进程多半
 * 没有。所以把页面最底下那层换成洋红（`Emulation.setDefaultBackgroundColorOverride`）：卡片是不透明
 * 的深色，哪里带上了洋红，哪里就是窗口底色透上来了——真机上那里是比卡片亮一截的毛玻璃灰。
 *
 * 两种量法：
 * - 停帧：把滑动的两段动画停在某一刻拍一张，取面板里和缝里的颜色。对话那一格的宽度在主线程上补间、
 *   面板的平移在合成器上，正文一长主线程跟不上，两条边之间就拉开一条缝；停住时两段同一时刻，看不到
 *   这条缝，所以「对话落后」那几张故意让对话慢 70ms。
 * - 真速：screencast 录来回三次，逐帧数面板那一栏里洋红像素有多宽。
 *
 * 跑：pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/dock-fold-backdrop-probe.ts <标签>
 * 视频、截图和取色写到 ~/Desktop/Plume侧栏切换底色测试/。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, frames, openPane, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const run = promisify(execFile);
const label = process.argv[2] ?? "probe";
const ID = "dock-fold-backdrop";
const LONG = "这是一段足够长的文字，用来让对话那一格在宽度变化时有足够多的正文要重排。".repeat(10);
const FOLD = 'button[aria-label="收起右侧面板"]';
const UNFOLD = 'button[aria-label="展开右侧面板"]';
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
const out = join(homedir(), "Desktop", "Plume侧栏切换底色测试");
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "plume-backdrop-"));

const renderer = await startDevRenderer();
const app = await startApp({
	port: 9691,
	rendererUrl: renderer.url,
	async seed(home) {
		const cwd = join(home, "project");
		await mkdir(cwd, { recursive: true });
		const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
		const at = Date.now() - 600_000;
		const message = (seq: number, role: string, text: string) => ({ seq, ts: at + seq * 1000, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 } });
		const meta = { id: ID, title: "右栏底色", cwd, projectId, projectName: "演示", createdAt: at, updatedAt: at, modelId: "m", messageCount: 40, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0 };
		const turns = Array.from({ length: 40 }, (_, i) => message(i + 2, i % 2 ? "assistant" : "user", i % 2 ? LONG : `第 ${i / 2 + 1} 个问题`));
		seedSessions(home, [{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, ...turns] as never }]);
		await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [], appearance: { theme: "dark" } }));
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 860, x: 40, y: 40 }));
	},
});

/** 一张图里一行像素。 */
async function row(image: string, y: number): Promise<{ width: number; at: (x: number) => [number, number, number] }> {
	const probe = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", image]);
	const width = Number(probe.stdout.trim());
	const raw = await run("ffmpeg", ["-v", "error", "-i", image, "-vf", `crop=${width}:1:0:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 1 << 24 });
	const data = raw.stdout as unknown as Buffer;
	const at = (x: number) => Math.min(Math.max(x, 0), width - 1) * 3;
	return { width, at: (x) => [data[at(x)]!, data[at(x) + 1]!, data[at(x) + 2]!] };
}

const hex = ([r, g, b]: [number, number, number]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
/** 停稳时面板卡片的颜色，第一张停帧量出来以后填上。 */
let card = 0;
/** 窗口底色透上来了：带洋红（底下是透明的），或者比卡片亮出一截（底下是窗口那层灰）。 */
const tinted = ([r, g, b]: [number, number, number]) => (r - g > 24 && b - g > 24) || (card > 0 && g > card + 6);

interface Geometry { inner: number; y: number; conversation: number; panel: number; panelRight: number; dockRight: number; opacity: number }

const geometry = (kind: string) => app.evaluate<Geometry>(`(() => {
	const card = (pane) => document.querySelector('[data-dock-pane="' + pane + '"] .ly-dock-card').getBoundingClientRect();
	const conversation = card("conversation");
	const panel = card(${JSON.stringify(kind)});
	return {
		inner: innerWidth,
		y: conversation.top + conversation.height * 0.62,
		conversation: conversation.right,
		panel: panel.left,
		panelRight: panel.right,
		dockRight: document.querySelector("[data-dock-panes]").getBoundingClientRect().right,
		opacity: Number(getComputedStyle(document.querySelector('[data-dock-pane="${kind}"]')).opacity),
	};
})()`);

/** 两段动画停在 `at` 毫秒；`lag` 让对话那一格落后这么多，模拟主线程跟不上。 */
const freeze = (at: number, lag: number) => app.evaluate(`(() => {
	const conversation = document.querySelector('[data-dock-pane="conversation"]');
	for (const motion of document.getAnimations()) {
		if (motion.id !== "ly-dock-geometry") continue;
		motion.pause();
		motion.currentTime = motion.effect.target === conversation ? Math.max(0, ${at - lag}) : ${at};
	}
})()`);
const release = () => app.evaluate(`document.getAnimations().forEach((motion) => motion.id === "ly-dock-geometry" && motion.finish())`);

const report: string[] = [];
const log = (line: string) => {
	report.push(line);
	console.log(line);
};

async function sample(name: string, kind: string, button: string | null, at = 0, lag = 0) {
	if (button) {
		await click(app, button);
		await freeze(at, lag);
	}
	await frames(app, 4);
	const g = await geometry(kind);
	const png = join(out, `${stamp}_${label}_${name}.png`);
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(png, Buffer.from(image.data, "base64"));
	const pixels = await row(png, Math.round(g.y * ((await row(png, 0)).width / g.inner)));
	const scale = pixels.width / g.inner;
	const px = (x: number) => pixels.at(Math.round(x * scale));
	const gap = g.panel - g.conversation;
	// 滑出窗口以后取不到面板：取窗口里还看得见的最右那一点。
	const panel = px(Math.min(g.panel + 40, g.panelRight - 4, g.dockRight - 8));
	if (!button) card = panel[1];
	const seam = gap > 12 ? px((g.panel + g.conversation) / 2) : null;
	const leaks = [panel, seam].filter((c): c is [number, number, number] => c !== null && tinted(c)).length;
	log(`${leaks ? "✗" : "✓"} ${name}：面板 opacity ${g.opacity.toFixed(2)}，面板里 ${hex(panel)}，对话与面板之间 ${Math.round(gap)}px${seam ? `、缝里 ${hex(seam)}` : ""}`);
	if (button) await release();
	await frames(app, 20);
	return leaks === 0;
}

let passed = 0;
let total = 0;
const check = (ok: boolean) => {
	total++;
	if (ok) passed++;
};

try {
	await frames(app, 60);
	await openSession(app, ID);
	await frames(app, 30);
	await openPane(app, "浏览器");
	await until(app, `document.querySelector('${FOLD}')`);
	await frames(app, 60);
	const kind = await app.evaluate<string>(`document.querySelector('[data-dock-pane]:not([inert]):not([data-dock-pane="conversation"])').dataset.dockPane`);
	await app.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 0, b: 255, a: 1 } });
	await frames(app, 10);
	log(`毛玻璃 ${await app.evaluate<string>(`document.documentElement.dataset.vibrancy ?? "无"`)}，窗口那层底色 ${await app.evaluate<string>(`getComputedStyle(document.querySelector(".ly-window-body") ?? document.body).backgroundColor`)}`);

	check(await sample("00_停稳", kind, null));
	for (const at of [60, 110, 160]) {
		check(await sample(`收起_${at}ms`, kind, FOLD, at));
		check(await sample(`展开_${at}ms`, kind, UNFOLD, at));
	}
	for (const at of [80, 140]) {
		check(await sample(`收起_${at}ms_对话落后70ms`, kind, FOLD, at, 70));
		await click(app, UNFOLD);
		await frames(app, 30);
	}

	// 真速：来回三次。screencast 只有十几帧每秒，220ms 的过渡只落到两三帧，量不出东西——
	// 量在页面里逐帧做，录像只给人看。
	const recorded: Frame[] = [];
	const stop = await startRecording(9691, recorded);
	await pause(800);
	const perFrame: { opacity: number; backed: boolean; moving: boolean }[] = [];
	for (let i = 0; i < 3; i++) {
		for (const button of [FOLD, UNFOLD]) {
			const sampling = app.evaluate<{ opacity: number; backed: boolean; moving: boolean }[]>(`new Promise((resolve) => {
				const out = [];
				let n = 40;
				const f = () => {
					const panel = document.querySelector('[data-dock-pane="${kind}"]');
					const moving = document.getAnimations().some((motion) => motion.id === "ly-dock-geometry" && motion.playState === "running");
					out.push({ opacity: Number(getComputedStyle(panel).opacity), backed: document.querySelector("[data-dock-panes]").hasAttribute("data-dock-sliding"), moving });
					if (--n) requestAnimationFrame(f); else resolve(out);
				};
				requestAnimationFrame(f);
			})`);
			await click(app, button);
			perFrame.push(...(await sampling));
			await pause(300);
		}
	}
	await stop();
	const moving = perFrame.filter((frame) => frame.moving);
	const faded = moving.filter((frame) => frame.opacity < 1).length;
	const bare = moving.filter((frame) => !frame.backed).length;
	const lingering = perFrame.filter((frame) => !frame.moving && frame.backed).length;
	const steady = moving.length > 20 && faded === 0 && bare === 0 && lingering === 0;
	check(steady);
	log(`${steady ? "✓" : "✗"} 真速来回三次：滑动中 ${moving.length} 帧，面板变透明 ${faded} 帧，没垫底色 ${bare} 帧；停下后底色还垫着 ${lingering} 帧`);
	await encode(recorded, join(out, `${stamp}_${label}_右栏收起展开_洋红为窗口底色_${passed}of${total}.mp4`));

	// 不换底色再录一段，给人看真实观感（毛玻璃 CDP 拍不到，这段里透上来的是页面自己那层 60% 的灰）。
	await app.send("Emulation.setDefaultBackgroundColorOverride", {});
	await frames(app, 10);
	const plain: Frame[] = [];
	const stopPlain = await startRecording(9691, plain);
	await pause(800);
	for (let i = 0; i < 2; i++) {
		await click(app, FOLD);
		await pause(900);
		await click(app, UNFOLD);
		await pause(900);
	}
	await stopPlain();
	await encode(plain, join(out, `${stamp}_${label}_右栏收起展开_原样.mp4`));
	log(`${label}：${passed}/${total}`);
	await writeFile(join(out, `${stamp}_${label}_取色_${passed}of${total}.txt`), report.join("\n") + "\n");
} finally {
	await app.stop();
	await renderer.close();
	await rm(scratch, { recursive: true, force: true });
}
