/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 侧栏「聊天」分区标题滚进去以后钉在顶上，和项目名一样；往回滚时被最后一个项目名顶走。
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/sidebar-chats-pin-demo.ts [before|after] [outDir]`
 * `before` 只拍图、打印数字，在旧构建上跑一遍拿来对照。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "./app.ts";
import { until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = process.argv[3] ?? join(homedir(), "Desktop", "Plume聊天标题吸顶测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9887;
const W = 1280;
const H = 820;

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const PROJECTS = ["alpha", "beta", "gamma", "delta"];
const CHATS = 24;

async function seed(home: string) {
	const sessions: { id: string; title: string; cwd: string; project: string; ago: number }[] = [];
	for (const [p, name] of PROJECTS.entries()) {
		await mkdir(join(home, name), { recursive: true });
		for (let i = 0; i < 5; i++) sessions.push({ id: `${name}-${i}`, title: `${name} 会话 ${i + 1}`, cwd: join(home, name), project: name, ago: 30 + p * 11 + i * 2 });
	}
	// 落在 `workspaces/` 下的会话不属于任何项目，列在「聊天」里（`electron/scratch.ts`）。
	const general = join(home, "workspaces", "general");
	await mkdir(general, { recursive: true });
	for (let i = 0; i < CHATS; i++) sessions.push({ id: `chat-${i}`, title: `聊天 ${i + 1}：宣传页模板推荐`, cwd: general, project: "general", ago: 5 + i * 7 });

	await writeFile(join(home, "window.json"), JSON.stringify({ width: W, height: H, x: 40, y: 40 }));
	seedSessions(home, sessions.map((session) => {
		const at = Date.now() - session.ago * 60_000;
		const meta = { id: session.id, title: session.title, cwd: session.cwd, projectId: session.project, projectName: session.project, createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage, seq: 1 };
		return { meta, records: [] } as Parameters<typeof seedSessions>[1][number];
	}));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		appearance: { theme: "dark" },
		providers: [],
		mcpServers: [],
		projects: PROJECTS.map((name, i) => ({ id: name, name, path: join(home, name), pinned: false, lastOpenedAt: 10 - i })),
		defaultModelId: null,
		permissionMode: "auto",
		thinking: "off",
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

let app: RunningApp;
const VIEW = `document.querySelector(".ly-sidebar-fill .ly-scroll-view")`;
const SECTION = `document.querySelector(".ly-sidebar-fill [data-ly-section='recent']")`;

interface State {
	scrollTop: number;
	/** 「聊天」标题那一行离滚动区顶部多远。 */
	chats: number;
	/** 顶部那一点上盖着的是谁：「聊天」标题、某个项目名，还是会话行。 */
	topHit: string;
	/** 「聊天」那一行的底色与侧栏底色，画到画布上读出来的像素。 */
	fill: number[];
	pane: number[];
	held: boolean;
}

async function state(): Promise<State> {
	return app.evaluate<State>(`(() => {
		const view = ${VIEW};
		const origin = view.getBoundingClientRect();
		const head = ${SECTION}.closest("[data-ly-head]") ?? ${SECTION}.parentElement;
		const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		const rgba = (css) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = css.trim(); paint.fillRect(0, 0, 1, 1); return [...paint.getImageData(0, 0, 1, 1).data]; };
		const hit = document.elementFromPoint(origin.left + 60, origin.top + 10);
		const topHit = hit?.closest("[data-ly-section]")?.textContent.trim().slice(0, 8)
			?? hit?.closest("[data-ly-head]")?.innerText.trim().split("\\n")[0]
			?? (hit?.closest("[data-ly-row]") ? "row:" + hit.closest("[data-ly-row]").innerText.trim().slice(0, 10) : hit?.tagName);
		return {
			scrollTop: Math.round(view.scrollTop),
			chats: Math.round((head.getBoundingClientRect().top - origin.top) * 10) / 10,
			topHit,
			fill: rgba(getComputedStyle(head).backgroundColor),
			pane: rgba(getComputedStyle(view.closest(".ly-nav-column") ?? view.closest(".ly-sidebar-fill")).backgroundColor),
			held: head.hasAttribute("data-ly-head"),
		};
	})()`);
}

/** 真滚轮，一格一格滚，视频里看得到列表在动。 */
async function wheel(total: number, step = 60) {
	const box = await app.evaluate<{ x: number; y: number }>(`(() => { const r = ${VIEW}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	const n = Math.ceil(Math.abs(total) / step);
	for (let i = 0; i < n; i++) {
		await app.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: Math.sign(total) * step, pointerType: "mouse" });
		await pause(45);
	}
	await pause(500);
}

async function snap(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT, `${STAMP}_${MODE}_${name}.png`);
	await writeFile(file, Buffer.from(image.data, "base64"));
	console.log(`   📷 ${file}`);
}

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
	await until(app, `${SECTION}`, 15000);
	await pause(800);

	const frames: Frame[] = [];
	const stop = MODE === "after" ? await startRecording(PORT, frames) : null;
	await pause(1000);

	console.log(`\n[${MODE}] 静止`);
	const rest = await state();
	console.log("   ·", JSON.stringify(rest));
	await snap("01_静止");

	// 滚到「聊天」一节里面：标题本该滚出顶部的位置。
	const into = await app.evaluate<number>(`(() => { const view = ${VIEW}; const head = ${SECTION}.parentElement; return head.getBoundingClientRect().top - view.getBoundingClientRect().top + 300; })()`);
	console.log(`\n[${MODE}] 滚进「聊天」 ${Math.round(into)}px`);
	await wheel(into);
	const inside = await state();
	console.log("   ·", JSON.stringify(inside));
	await snap("02_滚进聊天");
	if (MODE === "after") {
		check("「聊天」标题停在滚动区顶部", Math.abs(inside.chats) < 1, inside.chats);
		check("顶上那一点被「聊天」标题盖住，不是会话行", inside.topHit?.startsWith("聊天") === true, inside.topHit);
		check("标题底色和侧栏一致，滚过去的会话被盖住", JSON.stringify(inside.fill) === JSON.stringify(inside.pane), { fill: inside.fill, pane: inside.pane });
	}

	await pause(800);
	console.log(`\n[${MODE}] 滚到底`);
	await wheel(3000);
	const bottom = await state();
	console.log("   ·", JSON.stringify(bottom));
	await snap("03_滚到底");
	if (MODE === "after") check("滚到底仍钉在顶部", Math.abs(bottom.chats) < 1, bottom.chats);

	await pause(800);
	// 往回滚到「聊天」标题刚回到原位之上：最后一个项目名应该接回顶部。
	console.log(`\n[${MODE}] 往回滚，回到项目区`);
	await wheel(-(bottom.scrollTop - (into - 300) + 120));
	const back = await state();
	console.log("   ·", JSON.stringify(back));
	await snap("04_回到项目区");
	if (MODE === "after") {
		check("回到项目区后「聊天」跟着自己那一块落回原位", back.chats > 1, back.chats);
		check("顶上接回的是最后一个项目名", back.topHit === PROJECTS[PROJECTS.length - 1], back.topHit);
	}

	await pause(1000);
	if (stop) {
		await stop();
		const passed = checks.filter((c) => c.ok).length;
		const video = join(OUT, `${STAMP}_聊天标题吸顶_${passed}of${checks.length}.mp4`);
		await encode(frames, video);
		console.log(`\n🎬 ${video}`);
	}
	await app.stop();
	const failed = checks.filter((c) => !c.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
	if (failed.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop();
	process.exit(1);
});
