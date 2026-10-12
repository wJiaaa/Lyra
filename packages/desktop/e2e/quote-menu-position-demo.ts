/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 划词菜单对着选中的那行字，而不是整栏：三击选中紧挨在代码块前面的一段，菜单的横中线要落在那行字上。
 *
 * 三击时终点落进代码块，`user-select: none` 的标题栏整个被包进选区，`getBoundingClientRect()` 量出
 * 整栏宽，菜单曾因此偏到栏中间（见 `quote.ts` 的 `selectedText`）。
 *
 * 用法：node --experimental-strip-types e2e/quote-menu-position-demo.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { dragSelect, frames, openSession, shot, textSpan, tripleClickAt, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume划词菜单位置测试");
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;

const SESSION = "qa-quote-code";
const LINE = "在 tty 里开了 Python REPL 实测：";
const QUOTABLE = '[data-ly-chat-surface="conversation"] [data-ly-quote="assistant"]';
const MENU = '[data-ly-popover][role="menu"]';

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
		{ role: "assistant", content: [{ type: "text", text: `2*2 = 4\n\n${LINE}\n\n\`\`\`python\n>>> 2*2\n4\n\`\`\`` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 },
	];
	const meta = { id: SESSION, title: SESSION, projectId, projectName: "交互验证", cwd, createdAt: 3, updatedAt: 4, modelId: "qa/model", messageCount: messages.length, usage, seq: messages.length + 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, ts: 3 }, ...messages.map((message) => ({ type: "message" as const, message, ts: 3 })), { type: "meta", meta, ts: 4 }] } as never]);
}

/** 菜单的横中线、那行字的横中线，和菜单下沿到字上沿的距离。 */
const placement = () =>
	app.evaluate<{ menu: number; text: number; gap: number; selected: string } | null>(
		`(()=>{const m=document.querySelector('${MENU}');if(!m)return null;
		 const p=[...document.querySelectorAll('${QUOTABLE} p')].find(e=>e.textContent===${JSON.stringify(LINE)});
		 const r=document.createRange();r.selectNodeContents(p);const t=r.getBoundingClientRect();const b=m.getBoundingClientRect();
		 return {menu:Math.round(b.left+b.width/2),text:Math.round(t.left+t.width/2),gap:Math.round(t.top-b.bottom),selected:getSelection().toString()};})()`,
	);

async function run(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	try {
		await openSession(app, SESSION);
		await until(app, `document.querySelector('${QUOTABLE} .ly-code-block')`);
		await frames(app, 30);
		await pause(800);

		console.log("\n1. 三击选中代码块前面那一段，菜单对着那行字");
		const span = await textSpan(app, QUOTABLE, LINE);
		await tripleClickAt(app, { x: (span.start.x + span.end.x) / 2, y: span.start.y });
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 12);
		const tripled = await placement();
		check("选中的是这一段（三击带上了段尾换行）", Boolean(tripled?.selected.startsWith(LINE)), tripled?.selected);
		check("菜单横中线对着那行字（差不到 2px）", Boolean(tripled && Math.abs(tripled.menu - tripled.text) < 2), tripled);
		check("菜单在那行字上方 8px", tripled?.gap === 8, tripled?.gap);
		await shot(app, `${STAMP}_01_三击选段菜单对着字`);
		await pause(1200);

		console.log("\n2. 段内拖选照旧对着选中的那几个字");
		await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 20, button: "left", clickCount: 1 });
		await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 20, button: "left", clickCount: 1 });
		await until(app, `!document.querySelector('${MENU}')`);
		const part = await textSpan(app, QUOTABLE, "Python REPL");
		await dragSelect(app, part.start, part.end);
		await until(app, `document.querySelector('${MENU}')`);
		await frames(app, 12);
		const dragged = await app.evaluate<{ menu: number; selection: number }>(
			`(()=>{const b=document.querySelector('${MENU}').getBoundingClientRect();const s=getSelection().getRangeAt(0).getBoundingClientRect();
			 return {menu:Math.round(b.left+b.width/2),selection:Math.round(s.left+s.width/2)};})()`,
		);
		check("拖选几个字时菜单对着它们的中线", Math.abs(dragged.menu - dragged.selection) < 2, dragged);
		await shot(app, `${STAMP}_02_段内拖选`);
		await pause(1200);
	} finally {
		await stop();
	}
	const passed = checks.filter((each) => each.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，采到 ${recorded.length} 帧`);
	await app.stop();
	app = undefined as unknown as RunningApp;
	if (recorded.length > 0) await encode(recorded, join(OUT_DIR, `${STAMP}_划词菜单位置_${passed}of${checks.length}.mp4`), 60, 1200);
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
