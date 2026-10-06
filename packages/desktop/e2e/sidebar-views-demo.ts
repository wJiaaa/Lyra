/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * The sidebar follows the rail: each of 拉取请求 / 定时任务 / 插件 brings its own sidebar, and 对话
 * brings the conversation list back exactly as it was left.
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/sidebar-views-demo.ts [before|after] [outDir]`
 * `before` only takes the pictures — run it on the old build to have something to compare with.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "./app.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = process.argv[3] ?? join(homedir(), "Desktop", "Plume侧栏跟随页面测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9879;
const W = 1280;
const H = 820;

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
// Enough conversations that the list scrolls, so coming back can be checked for its scroll position.
const SESSIONS = Array.from({ length: 40 }, (_, i) => ({ id: `s-${i}`, title: `会话 ${i + 1}`, ago: 5 + i }));
const TASKS = [
	{ id: "task-a", name: "每天早上看一眼 CI", cwd: "", prompt: "看一下 CI", schedule: { kind: "daily", time: "09:00" }, enabled: true },
	{ id: "task-b", name: "整理依赖更新", cwd: "", prompt: "整理依赖", schedule: { kind: "interval", minutes: 120 }, enabled: false },
	{ id: "task-c", name: "周报草稿", cwd: "", prompt: "写周报", schedule: { kind: "daily", time: "18:00" }, enabled: true },
	{ id: "task-d", name: "清理过期分支", cwd: "", prompt: "清理分支", schedule: { kind: "daily", time: "20:00" }, enabled: false },
	{ id: "task-e", name: "检查日志告警", cwd: "", prompt: "看日志", schedule: { kind: "interval", minutes: 30 }, enabled: true },
];

/** Two accounts on hosts that never resolve, and rows from the cache — as `pull-requests.test.ts` does. */
const FORGES = {
	version: 1,
	entries: [
		{ account: { id: "acct-one", kind: "github", label: "kittors · one.invalid", baseUrl: "https://one.invalid", login: "kittors", avatarUrl: null, enabled: true }, token: "not-a-real-token", encrypted: false },
		{ account: { id: "acct-two", kind: "gitlab", label: "work · two.invalid", baseUrl: "https://two.invalid", login: "work", avatarUrl: null, enabled: true }, token: "not-a-real-token", encrypted: false },
	],
};
const pr = (accountId: string, number: number, title: string, relation: string) => ({
	accountId, repo: "kittors/plume", number, title, author: "kittors", avatarUrl: null, state: "OPEN", isDraft: false,
	url: `https://github.com/kittors/plume/pull/${number}`, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
	comments: 1, relation, additions: 12, deletions: 3, headRefName: `fix/${number}`, checkState: "pass", reviewDecision: null,
});
const CACHED = [pr("acct-one", 1, "fix: 项目在软链下时文件操作失效", "reviewing"), pr("acct-one", 2, "feat: 侧栏跟着页面换内容", "authored"), pr("acct-two", 3, "chore: 升级依赖", "reviewed")];

async function seed(home: string) {
	await writeFile(join(home, "forges.json"), JSON.stringify(FORGES));
	const proj = join(home, "proj");
	await mkdir(proj, { recursive: true });
	await writeFile(join(proj, "README.md"), "# proj\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: W, height: H, x: 40, y: 40 }));
	await mkdir(join(home, "sessions"), { recursive: true });
	seedSessions(home, SESSIONS.map((session) => {
		const at = Date.now() - session.ago * 60_000;
		const meta = { id: session.id, title: session.title, cwd: proj, projectId: "e2e", projectName: "proj", createdAt: at, updatedAt: at, modelId: "p/gpt-5.2", messageCount: 2, usage, seq: 3 };
		return {
			meta,
			records: [
				{ ts: at, type: "meta", meta },
				{ ts: at, type: "message", message: { role: "user", content: [{ type: "text", text: session.title }], timestamp: at } },
				{ ts: at, type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的。" }], api: "openai-chat-completions", provider: "p", model: "gpt-5.2", usage, stopReason: "stop", timestamp: at } },
			],
		} as Parameters<typeof seedSessions>[1][number];
	}));
	const model = { id: "p/gpt-5.2", providerId: "p", modelId: "gpt-5.2", name: "gpt-5.2", contextWindow: 128000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true };
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		appearance: { theme: "light", vibrancy: false },
		providers: [{ id: "p", name: "Local", api: "openai-chat-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", enabled: true, models: [model] }],
		mcpServers: [],
		projects: [{ id: "e2e", name: "proj", path: proj, pinned: false, lastOpenedAt: 1 }],
		defaultModelId: "p/gpt-5.2",
		permissionMode: "auto",
		thinking: "off",
		hooks: [],
		scheduledTasks: TASKS.map((task) => ({ ...task, cwd: proj })),
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

let app: RunningApp;
const frames: Frame[] = [];

const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`;
async function until(expression: string, ms = 15_000) {
	for (let i = 0; i < ms / 100; i++) {
		if (await app.evaluate(`Boolean(${expression})`)) return true;
		await pause(100);
	}
	throw new Error(`UI condition not reached: ${expression}`);
}
async function click(expression: string) {
	await until(expression);
	const p = await app.evaluate<{ x: number; y: number }>(`(()=>{const el=${expression};const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...p });
	for (const type of ["mousePressed", "mouseReleased"]) await app.send("Input.dispatchMouseEvent", { type, ...p, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
}
async function hold(ms = 1000) {
	await pause(ms);
}
async function shot(name: string) {
	const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, `${STAMP}_${MODE}_${name}.png`), Buffer.from(picture.data, "base64"));
}
const box = (selector: string) => app.evaluate<{ x: number; w: number } | null>(`(()=>{const el=${q(selector)};if(!el)return null;const r=el.getBoundingClientRect();return {x:Math.round(r.x),w:Math.round(r.width)}})()`);
const rail = (place: string) => q(`[data-ly-rail-item="${place}"]`);
/** Whether an element is on screen: laid out, not `visibility: hidden` anywhere above it, and wider than nothing. */
const shown = (expression: string) =>
	app.evaluate<boolean>(`(()=>{const el=${expression};if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility==="visible"})()`);
const navText = () => app.evaluate<string>(`[...document.querySelectorAll(".ly-nav-column [data-ly-nav-slot]")].filter((el)=>getComputedStyle(el).display!=="none"&&getComputedStyle(el).visibility==="visible").map((el)=>el.innerText).join("|")`);
const conversationsShown = () => shown(q('.ly-nav-column [data-ly-row="s-0"]'));

async function main() {
	await mkdir(OUT, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const stop = await startRecording(PORT, frames);
	try {
		await app.evaluate(`(() => { localStorage.setItem("plume.pull-requests.v3", ${JSON.stringify(JSON.stringify(CACHED))}); return true; })()`);
		await app.evaluate("document.fonts.ready");
		await until(`document.querySelectorAll("[data-ly-row]").length >= 4`);
		// 「聊天」 lists every conversation, so it is long enough to scroll.
		await click(q('[data-ly-tab="chats"]'));
		await until(`document.querySelectorAll("[data-ly-row]").length >= 30`);
		await click(q('[data-ly-row="s-0"]'));
		await hold(900);

		console.log("\n== A 对话：侧栏是会话列表，往下滚一段");
		await app.evaluate(`(()=>{const s=${q('.ly-nav-column [data-ly-row="s-0"]')}.closest("[data-ly-scroller]")||[...document.querySelectorAll(".ly-nav-column *")].find((el)=>el.scrollHeight>el.clientHeight+40&&getComputedStyle(el).overflowY!=="visible");s.scrollTop=300;return s.scrollTop})()`);
		await hold(600);
		const scrollBefore = await app.evaluate<number>(`[...document.querySelectorAll(".ly-nav-column *")].find((el)=>el.scrollHeight>el.clientHeight+40&&getComputedStyle(el).overflowY!=="visible")?.scrollTop ?? -1`);
		await shot("01_对话");
		if (MODE === "after") {
			const head = await app.evaluate<{ title: number; heads: number[]; strip: number[] }>(`(()=>{const p=${q(".ly-nav-column")}.getBoundingClientRect();const cx=(el)=>{const r=el.getBoundingClientRect();return Math.round(r.left+r.width/2-p.left)};return {title:Math.round(${q(".ly-sidebar-head span")}.getBoundingClientRect().top-p.top),heads:[...document.querySelectorAll(".ly-sidebar-head button")].map(cx),strip:[...document.querySelectorAll("[data-ly-rail] .ml-auto button")].map(cx)}})()`);
			check("「Plume」离面板顶边 ≥ 12px", head.title >= 12, head.title);
			const left = await app.evaluate<{ title: number; newChat: number; band: number }>(`(()=>{const p=${q(".ly-nav-column")}.getBoundingClientRect().left;const x=(el)=>Math.round(el.getBoundingClientRect().left-p);const range=document.createRange();range.selectNodeContents(${q(".ly-sidebar-head span")});const walk=document.createTreeWalker(${q(".ly-nav-column [data-ly-band] [data-ly-head]")},NodeFilter.SHOW_TEXT);let node=walk.nextNode();while(node&&!node.textContent.trim())node=walk.nextNode();const r2=document.createRange();r2.selectNodeContents(node);return {title:Math.round(range.getBoundingClientRect().left-p),newChat:x(${q(".ly-nav-column nav button svg")}),band:Math.round(r2.getBoundingClientRect().left-p)}})()`);
			check("「Plume」、「新对话」的图标、「今天」左沿在同一条线上", Math.abs(left.title - left.newChat) <= 1 && Math.abs(left.newChat - left.band) <= 1, left);
			check("搜索、通知和下面的筛选、归档各自同一条中线", head.heads.length === 2 && head.strip.length >= 2 && head.heads.every((x, i) => Math.abs(x - head.strip[head.strip.length - 2 + i]!) <= 1), head);
		}

		console.log("\n== B 拉取请求：侧栏换成拉取请求的列表");
		await click(rail("pull-requests"));
		await hold(1400);
		await shot("02_拉取请求");
		if (MODE === "after") {
			check("会话列表让开了", !(await conversationsShown()), null);
			const text = await navText();
			check("侧栏里是拉取请求这一页的东西（没登录时是添加账号）", /未添加代码托管账号|全部/.test(text), text.slice(0, 80));
			const titleTop = await app.evaluate<number>(`Math.round(${q('[data-ly-nav-slot="pull-requests"] .ly-sidebar-head span')}.getBoundingClientRect().top - ${q(".ly-nav-column")}.getBoundingClientRect().top)`);
			check("「拉取请求」和「Plume」在同一高度，换页时标题不跳", titleTop === (await app.evaluate<number>(`Math.round(${q(".ly-sidebar-head span")}.getBoundingClientRect().top - ${q(".ly-nav-column")}.getBoundingClientRect().top)`)) && titleTop >= 12, titleTop);
			const rows = await app.evaluate<number>(`document.querySelectorAll('[data-ly-nav-slot="pull-requests"] .ly-pr-row').length`);
			check("三条拉取请求都在侧栏里", rows === 3, rows);
			const inContent = await app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-solo-screen] [data-ly-toprow="pr-list"]'))`);
			check("内容区里不再有第二份列表", !inContent, inContent);
		}

		console.log("\n== C 定时任务：侧栏列出任务，点一条，内容区滚到那张卡片");
		await click(rail("scheduled"));
		await hold(1400);
		await shot("03_定时任务");
		if (MODE === "after") {
			check("会话列表让开了", !(await conversationsShown()), null);
			const names = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-ly-nav-slot="scheduled"] [data-scheduled-nav]')].map((el)=>el.textContent.trim())`);
			check("侧栏按顺序列出全部 5 个任务", names.length === 5 && names[0]!.includes("每天早上看一眼 CI") && names[4]!.includes("检查日志告警"), names);
			const card = () => app.evaluate<{ lit: boolean; top: number; bottom: number }>(`(()=>{const c=${q('[data-scheduled-task="task-e"]')};const r=c.getBoundingClientRect();return {lit:c.className.includes("border-accent"),top:Math.round(r.top),bottom:Math.round(r.bottom)}})()`);
			await click(q('[data-scheduled-nav="task-e"]'));
			await hold(150);
			const lit = await card();
			check("点最后一个任务：它的卡片亮起", lit.lit, lit);
			await hold(900);
			const placed = await card();
			check("滚动停下后整张卡片在窗口里", placed.top >= 40 && placed.bottom <= H, placed);
			await shot("04_定时任务_点了最后一个");
			await hold(1000);
			const before = names.length;
			await click(q('[data-ly-nav-slot="scheduled"] [data-scheduled-new]'));
			await until(`document.querySelectorAll('[data-ly-nav-slot="scheduled"] [data-scheduled-nav]').length === ${before + 1}`);
			const cards = await app.evaluate<number>(`document.querySelectorAll("[data-scheduled-task]").length`);
			check("侧栏的「新建任务」：侧栏和内容区都多了一条", cards === before + 1, { cards });
			await hold(900);
		}

		console.log("\n== D 插件：侧栏是类型和分类");
		await click(rail("plugins"));
		await hold(2000);
		await shot("05_插件");
		if (MODE === "after") {
			check("会话列表让开了", !(await conversationsShown()), null);
			const kinds = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-ly-nav-slot="plugins"] [data-market-kind]')].map((el)=>el.getAttribute("data-market-kind"))`);
			check("侧栏有 全部 / 插件 / MCP / 技能 四项", kinds.join() === "all,plugin,mcp,skill", kinds);
			const strip = await app.evaluate<boolean>(`Boolean(document.querySelector('[data-market] [role="tablist"]'))`);
			check("内容区不再有那排类型标签", !strip, strip);
			await click(q('[data-market-kind="mcp"]'));
			await hold(900);
			const current = await app.evaluate<string | null>(`document.querySelector('[data-market-kind][aria-current="page"]')?.getAttribute("data-market-kind") ?? null`);
			check("点 MCP：侧栏标出 MCP", current === "mcp", current);
			await shot("06_插件_MCP");
			await click(q('[data-market-kind="all"]'));
			await hold(700);
		}

		console.log("\n== E 回到对话：会话列表原样回来");
		await click(rail("chat"));
		await hold(1200);
		await shot("07_回到对话");
		if (MODE === "after") {
			check("会话列表回来了", await conversationsShown(), null);
			const scrollAfter = await app.evaluate<number>(`[...document.querySelectorAll(".ly-nav-column *")].find((el)=>el.scrollHeight>el.clientHeight+40&&getComputedStyle(el).overflowY!=="visible")?.scrollTop ?? -1`);
			check("滚动位置还在原处", scrollBefore > 0 && scrollAfter === scrollBefore, { scrollBefore, scrollAfter });
		}

		console.log("\n== F 窄窗口：侧栏是抽屉，入口在抽屉里，页面自己带列表");
		await click(rail("pull-requests"));
		await hold(900);
		await app.send("Emulation.setDeviceMetricsOverride", { width: 700, height: H, deviceScaleFactor: 0, mobile: false });
		await hold(1200);
		await shot("08_窄窗口_拉取请求");
		if (MODE === "after") {
			const drawer = await app.evaluate<{ places: number; rows: boolean }>(`({ places: [...document.querySelectorAll('aside[data-pane="drawer"] button')].filter((b)=>["拉取请求","定时任务","插件"].includes(b.textContent.trim())).length, rows: Boolean(document.querySelector('aside[data-pane="drawer"] [data-ly-row="s-0"]')) })`);
			check("抽屉里仍是会话列表和三个入口", drawer.places === 3 && drawer.rows, drawer);
			// Narrow, the page is the list until one is chosen and the detail after; one was chosen while wide.
			// The detail's own header only draws once it has loaded, and these hosts never answer; its way back to the list is always there.
			const own = await app.evaluate<{ rows: number; detail: boolean }>(`({ rows: document.querySelectorAll("[data-ly-solo-screen] .ly-pr-row").length, detail: Boolean(document.querySelector('[data-ly-solo-screen] button[aria-label="全部 Pull Request"]')) })`);
			check("页面自己画拉取请求（列表或选中的那条）", own.rows === 3 || own.detail, own);
		}
		await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 0, mobile: false });
		await hold(900);

		if (MODE === "after") {
			console.log("\n== G 侧栏拖到最窄 240px：拉取请求的三个筛选和刷新仍在一行里放得下");
			await app.evaluate(`(() => { localStorage.setItem("dw:sidebar-width", "240"); location.reload(); return true; })()`);
			await until(`document.querySelector('[data-ly-rail-item="pull-requests"]')`);
			await click(rail("pull-requests"));
			await until(`document.querySelector('[data-ly-nav-slot="pull-requests"] [data-ly-toprow="pr-list"]')`);
			await hold(1200);
			const row = await app.evaluate<{ width: number; scroll: number; client: number; labels: string[] }>(`(()=>{const r=${q('[data-ly-nav-slot="pull-requests"] [data-ly-toprow="pr-list"]')};return {width:Math.round(r.getBoundingClientRect().width),scroll:r.scrollWidth,client:r.clientWidth,labels:[...r.querySelectorAll("button")].map((b)=>{const x=b.getBoundingClientRect();return (b.textContent.trim()||b.getAttribute("aria-label"))+":"+Math.round(x.right)})}})()`);
			const panel = await box(".ly-nav-column");
			check("筛选行没有溢出，最后一颗按钮在侧栏右沿以内", row.scroll <= row.client && panel !== null && row.labels.every((label) => Number(label.split(":")[1]) <= panel.x + panel.w), { row, panel });
			await shot("09_侧栏最窄_拉取请求");
			await app.evaluate(`(() => { localStorage.removeItem("dw:sidebar-width"); return true; })()`);
		}
	} finally {
		await stop();
		await app.stop();
	}
	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT, `${STAMP}_${MODE}_侧栏跟随页面_${passed}of${checks.length}.mp4`);
	await encode(frames, video);
	console.log(`\n${passed}/${checks.length}  →  ${video}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
