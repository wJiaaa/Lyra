/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * Toast 要自己走——在真窗口里量每张卡片在屏幕上待了多久。
 *
 * 两种它从前会一直挂着的情况，都用侧栏右键「标记为未读 / 已读」弹出来：
 *
 *   一、指针在卡片上点了关闭。卡片卸掉了，`mouseleave` 再也不会来，整排 toast 停在「悬停暂停」里，
 *       之后弹出的每一张都等一次没人会做的悬停。
 *   二、一张还在的时候又来一张。列表一变，旧卡片的倒计时被整个重置，新消息不断就一直不走。
 *
 * 时长取自画面：页面里挂一个 MutationObserver，记每张卡片挂上和摘下的时刻。
 *
 * 用法：node --experimental-strip-types e2e/toast-lifetime-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, contextClick, until } from "./drive.ts";
import { fixtureStore } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume提示自动关闭测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
/** `TOAST_LIFETIME.info`，加上一个 tick 和退场动画的余量。 */
const LIFETIME = 6000;
const SLACK = 600;

let app: RunningApp;
let sessionId = "";
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const store = fixtureStore(home);
	const meta = await store.create(cwd, "fake/model", "拿来标记已读未读的对话");
	sessionId = meta.id;
	await store.append(meta, { type: "message", message: { role: "user", content: [{ type: "text", text: "随便一句话" }], timestamp: Date.now() } });
	store.close();
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			uiLocale: "zh-CN",
			permissionMode: "full",
			projects: [{ path: cwd, name: "demo", pinned: true, lastOpenedAt: Date.now() }],
			providers: [],
		}),
	);
}

/** 每张卡片挂上、摘下的时刻（页面时钟）。 */
const WATCH = `(() => {
	window.__toasts = [];
	const seen = new Map();
	new MutationObserver(() => {
		const now = performance.now();
		const live = new Set(document.querySelectorAll('[data-ly-toaster] [role=status]'));
		for (const card of live) if (!seen.has(card)) { const entry = { text: card.textContent, born: now, gone: null }; seen.set(card, entry); window.__toasts.push(entry); }
		for (const [card, entry] of seen) if (!live.has(card) && entry.gone === null) entry.gone = now;
	}).observe(document.body, { childList: true, subtree: true });
})()`;

interface Lived { text: string; born: number; gone: number | null }
const toasts = () => app.evaluate<Lived[]>("window.__toasts");
const now = () => app.evaluate<number>("performance.now()");

/** 右键那条对话，点菜单里的一项。 */
async function mark(item: "标记为未读" | "标记为已读"): Promise<void> {
	await contextClick(app, `[data-ly-row="${sessionId}"] > button`);
	await click(app, "[data-ly-popover] button", item);
	await until(app, `[...document.querySelectorAll('[data-ly-toaster] [role=status]')].some(e=>e.textContent.includes(${JSON.stringify(item.replace("标记", "已标记"))}))`);
}

async function shot(name: string): Promise<void> {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	try {
		await app.evaluate("document.fonts.ready");
		await until(app, `document.querySelector('[data-ly-row="${sessionId}"]')`);
		await app.evaluate(WATCH);
		await pause(800);

		console.log("一、指针在卡片上点关闭，下一张还会不会自己走");
		await mark("标记为未读");
		await pause(900);
		await click(app, '[data-ly-toaster] button[aria-label="关闭"]');
		await pause(600);
		await mark("标记为已读");
		const second = await now();
		await shot("01_关闭上一张后又弹一张");
		// 指针停在侧栏上，不碰 toast。
		await pause(LIFETIME + SLACK + 400);
		const afterClose = (await toasts()).find((t) => t.text.includes("已标记为已读") && t.born >= second - 1000);
		check(
			"关掉指针下的卡片后，下一张按时自己走",
			!!afterClose?.gone && afterClose.gone - afterClose.born <= LIFETIME + SLACK,
			afterClose?.gone ? `在屏幕上待了 ${Math.round(afterClose.gone - afterClose.born)}ms` : "过了 7 秒仍在屏幕上",
		);
		await shot("02_七秒后");
		if (!afterClose?.gone) {
			// 旧实现：移上去再移开才放得开，不然后面一段量的还是这一处。
			await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 760, y: 70 });
			await pause(200);
			await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 760, y: 500 });
			await pause(LIFETIME + SLACK);
		}

		console.log("二、一张还在时又来一张，前一张的倒计时会不会被重置");
		await mark("标记为未读");
		await pause(4000);
		await mark("标记为已读");
		await shot("03_两张同时在");
		await pause(LIFETIME + SLACK + 400);
		const list = await toasts();
		const first = list.findLast((t) => t.text.includes("已标记为未读"));
		const next = list.findLast((t) => t.text.includes("已标记为已读"));
		check(
			"前一张没有因为后一张到来而续期",
			!!first?.gone && first.gone - first.born <= LIFETIME + SLACK,
			first?.gone ? `前一张待了 ${Math.round(first.gone - first.born)}ms` : "前一张仍在屏幕上",
		);
		check(
			"后一张按自己的时长走",
			!!next?.gone && next.gone - next.born <= LIFETIME + SLACK,
			next?.gone ? `后一张待了 ${Math.round(next.gone - next.born)}ms` : "后一张仍在屏幕上",
		);
		await shot("04_都走了");
	} finally {
		await stop();
		await app.stop();
	}
	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT_DIR, `${STAMP}_toast自己关闭_${passed}of${checks.length}.mp4`);
	await encode(frames, video);
	console.log(`\n${passed}/${checks.length} 通过 → ${video}`);
	process.exitCode = passed === checks.length ? 0 : 1;
}

await main();
