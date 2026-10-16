/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 设置页章节切换：导航选中行直接换过去，正文淡入上移。
 *
 * 用法：node --experimental-strip-types e2e/settings-switch-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { shot } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "设置页切换测试");
const PORT = 9544;
const STAMP = new Date()
	.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
	.replace(/[: ]/g, "-")
	.slice(0, 16);

const PAGES = ["常规", "外观", "屏幕截图", "浏览器", "个性化"] as const;

let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	await mkdir(join(home, "project"), { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ path: join(home, "project"), name: "demo", pinned: false, lastOpenedAt: Date.now() }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "light" },
		}),
	);
}

async function measure() {
	return app.evaluate<{
		view: string;
		animation: string;
		current: string;
		moving: number;
		heading: string;
	}>(`(() => {
		const root = document.querySelector("[data-ly-settings]");
		const page = root && root.querySelector('[data-active="true"]');
		const current = root && root.querySelector('[aria-current="page"]');
		const heading = root && root.querySelector("main h1");
		return {
			view: page?.getAttribute("data-view") || "",
			animation: page ? getComputedStyle(page).animationName : "",
			current: (current?.textContent || "").trim(),
			// 导航里还在跑的过渡：选中底色滑过去、旧行淡出，都会出现在这里。
			moving: root?.querySelector("nav")?.getAnimations({ subtree: true }).length ?? -1,
			heading: (heading?.textContent || "").trim().slice(0, 24),
		};
	})()`);
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);

	try {
		await d.until('document.querySelector("[data-ly-open-settings]")', 30000);
		await pause(800);
		await d.click("[data-ly-open-settings]");
		await d.until('document.querySelector("[data-ly-settings] [aria-current=\\"page\\"]")', 20000);
		await pause(900);

		const home = await measure();
		check("设置导航有选中行", home.current.length > 0, `current ${home.current}`);
		check("正文用 settings 入场而不是 workspace 那一刀", home.animation.includes("ly-settings-in") || home.view !== "", `anim ${home.animation} view ${home.view}`);
		await pause(700);

		for (const label of PAGES) {
			console.log(`【切】${label}`);
			await d.markByText(`/${label}/`, "data-ly-settings-nav");
			const marked = await app.evaluate<boolean>("Boolean(document.querySelector('[data-ly-settings-nav]'))");
			check(`导航里找得到「${label}」`, marked, marked ? "" : "没有这颗按钮");
			if (!marked) continue;
			const t0 = Date.now();
			await d.click("[data-ly-settings-nav]");
			const arriving = await measure();
			await shot(app, `${STAMP}_点下「${label}」那一刻`);
			await pause(260);
			const after = await measure();
			const dt = Date.now() - t0;
			console.log(`   ${JSON.stringify({ arriving, after })}  ${dt}ms`);
			check(`「${label}」点下去右侧换到这一页`, after.heading.includes(label) || after.view.length > 0, `view ${after.view} heading ${after.heading} ${dt}ms`);
			// 第一页打开设置时就在了，再点一次不会重新入场。
			if (label !== PAGES[0]) check(`「${label}」入场是 ly-settings-in`, arriving.animation.includes("ly-settings-in"), `anim ${arriving.animation}`);
			check(`「${label}」点下去选中行就是它`, arriving.current.includes(label), `current ${arriving.current}`);
			check(`「${label}」选中底色直接换过去，导航里没有在跑的过渡`, arriving.moving === 0, `moving ${arriving.moving}`);
			await pause(900);
		}
	} finally {
		await stop();
		await app?.stop().catch(() => {});
	}

	const passed = checks.filter((c) => c.ok).length;
	const path = join(OUT_DIR, `${STAMP}_设置页切换_${passed}of${checks.length}.mp4`);
	if (frames.length) await encode(frames, path);
	console.log(`\n${passed}/${checks.length} 项通过`);
	if (frames.length) console.log(path);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exitCode = 1;
});
