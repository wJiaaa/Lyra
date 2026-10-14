/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 划词菜单什么时候弹：双击先等第三下，三击只弹一次，单个字不弹，拖选照旧立刻弹。
 *
 * 双击松开就弹的话，人接着点第三下想选整段，菜单先收起、再在整段上弹一次；手抖拖出一个字也会弹出
 * 一条菜单压在正文上（见 `QuoteMenu.tsx` 的 `onUp`、`quote.ts` 的 `quotedIn`）。
 *
 * 用法：pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/quote-menu-clicks-demo.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { clickAt, clicksAt, dragSelect, frames, openSession, shot, textSpan, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume划词菜单时机测试");
const PORT = 9438;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;

const SESSION = "qa-quote-clicks";
const LINE = "在 tty 里开了 Python REPL 实测：";
const QUOTABLE = '[data-ly-chat-surface="conversation"] [data-ly-quote="assistant"]';
const MENU = '[data-ly-popover][role="menu"]';
/** 人手连点两下之间的间隔。 */
const GAP = 150;

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${JSON.stringify(saw)}`);
}

async function seed(home: string): Promise<void> {
	await seedInteractions(home);
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const messages = [
		{ role: "user", content: [{ type: "text", text: "2*2 等于几，在 Python 里验一下" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: `2*2 = 4\n\n${LINE}\n\n结果和心算一致。` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 },
	];
	const meta = { id: SESSION, title: SESSION, projectId, projectName: "交互验证", cwd, createdAt: 3, updatedAt: 4, modelId: "qa/model", messageCount: messages.length, usage, seq: messages.length + 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, ts: 3 }, ...messages.map((message) => ({ type: "message" as const, message, ts: 3 })), { type: "meta", meta, ts: 4 }] } as never]);
}

/**
 * 第三下按下去的那一刻菜单在不在。在的话，这一下先把它收起、松开又在整段上弹一次——同一个
 * Popover 换了挂点，挂载次数量不出来，只能在按下的那一刻看。
 */
const watchThird = () =>
	app.evaluate(`(()=>{window.__menuAtThird=null;window.removeEventListener('mousedown',window.__thirdProbe,true);
		window.__thirdProbe=(e)=>{if(e.detail===3)window.__menuAtThird=Boolean(document.querySelector('${MENU}'));};
		window.addEventListener('mousedown',window.__thirdProbe,true);})()`);
const menuAtThird = () => app.evaluate<boolean | null>("window.__menuAtThird");
const menuShown = () => app.evaluate<boolean>(`Boolean(document.querySelector('${MENU}'))`);
const selected = () => app.evaluate<string>("getSelection().toString()");

/** 点一下空白处收掉选区和菜单。 */
async function reset(): Promise<void> {
	await clickAt(app, { x: 20, y: 20 });
	await until(app, `!document.querySelector('${MENU}') && getSelection().isCollapsed`);
	await pause(600);
}

async function run(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const renderer = await startDevRenderer();
	app = await startApp({ port: PORT, seed, rendererUrl: renderer.url });
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await openSession(app, SESSION);
		await until(app, `[...document.querySelectorAll('${QUOTABLE} p')].some(p=>p.textContent===${JSON.stringify(LINE)})`);
		await frames(app, 30);
		await pause(800);

		console.log("\n1. 双击选词：松开时不弹，等过第三下的时间才弹");
		const word = await textSpan(app, QUOTABLE, "Python");
		const started = Date.now();
		await clicksAt(app, { x: (word.start.x + word.end.x) / 2, y: word.start.y }, 2, GAP);
		await pause(GAP);
		check("双击松开 150ms 后还没有菜单（人可能还要点第三下）", !(await menuShown()), await selected());
		await until(app, `document.querySelector('${MENU}')`);
		const waited = Date.now() - started;
		check("之后菜单弹出来，选的是这个词", (await selected()) === "Python", await selected());
		check("从第一下到弹出不到 1 秒", waited < 1000, `${waited}ms`);
		await frames(app, 12);
		await shot(app, `${STAMP}_01_双击选词等一下再弹`);
		await pause(1200);
		await reset();

		console.log("\n2. 三击选段：中途不弹，整段选中后只弹一次");
		await watchThird();
		await clicksAt(app, { x: (word.start.x + word.end.x) / 2, y: word.start.y }, 3, GAP);
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 30);
		check("选中的是整段", (await selected()).startsWith(LINE), await selected());
		check("第三下按下时还没有菜单，不会先弹后收再弹", (await menuAtThird()) === false, await menuAtThird());
		await shot(app, `${STAMP}_02_三击选段只弹一次`);
		await pause(1200);
		await reset();

		console.log("\n3. 只拖选一个字：不弹");
		const one = await textSpan(app, QUOTABLE, "测");
		await dragSelect(app, { x: one.start.x - 1, y: one.start.y }, { x: one.end.x + 1, y: one.end.y });
		await pause(700);
		check("选中了一个字", (await selected()).trim() === "测", await selected());
		check("700ms 后仍没有菜单", !(await menuShown()), await menuShown());
		await shot(app, `${STAMP}_03_单字不弹`);
		await pause(1200);
		await reset();

		console.log("\n4. 拖选几个字：照旧立刻弹，不等");
		const part = await textSpan(app, QUOTABLE, "Python REPL");
		const dragged = Date.now();
		await dragSelect(app, part.start, part.end);
		await until(app, `document.querySelector('${MENU}')`);
		const after = Date.now() - dragged;
		check("拖选松开后马上弹（不到 300ms，不走双击的等待）", after < 300, `${after}ms`);
		await frames(app, 12);
		await shot(app, `${STAMP}_04_拖选立刻弹`);
		await pause(1200);
	} finally {
		await stop();
	}
	const passed = checks.filter((each) => each.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，采到 ${recorded.length} 帧`);
	await app.stop();
	app = undefined as unknown as RunningApp;
	await renderer.close();
	if (recorded.length > 0) await encode(recorded, join(OUT_DIR, `${STAMP}_划词菜单时机_${passed}of${checks.length}.mp4`), 60, 1200);
	if (passed !== checks.length) process.exitCode = 1;
}

run()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		await app?.stop().catch(() => {});
	});
