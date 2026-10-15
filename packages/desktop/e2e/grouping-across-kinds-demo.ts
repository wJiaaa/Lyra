/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 开关开着的几类挨在一起合成一行——拿一段真实会话在真窗口里看，边验边录。
 *
 * 会话从本机 `~/.plume/sessions/sessions.db` 复制出来（只留这一条），放进一次性的 profile，结束时删掉。
 * 那一段是「edit 失败 → sed -n 看一眼 → python 改 → edit 失败 → read → edit」：只按同一类合时一次调用
 * 一行，开着的几类挨着也合之后应当是一行。
 *
 * 用法：node --experimental-strip-types e2e/grouping-across-kinds-demo.ts [before|after] [会话 id] [输出目录]
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, openSession } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { sessionsDbPath } from "./session-fixture.ts";

const LABEL = process.argv[2] ?? "after";
const SESSION = process.argv[3] ?? "b784f76e-504f-4c23-a476-d4c267cc09fe";
const OUT_DIR = process.argv[4] ?? join(homedir(), "Desktop", "Plume跨类合并测试");
const PORT = 9497;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

/** 这一段的起止：两句话之间那几次调用。 */
const FROM = "CLI 只按 message 展示";
const TO = "更新 spec 检查点";
const NEXT = "现在验证";

async function seed(home: string): Promise<void> {
	const db = sessionsDbPath(home);
	await mkdir(join(home, "sessions"), { recursive: true });
	// `.backup` 只读源库，拿到的是一致的快照（含 WAL 里还没落盘的）。
	execFileSync("sqlite3", ["-readonly", join(homedir(), ".plume", "sessions", "sessions.db"), `.backup '${db}'`]);
	const keep = SESSION.replace(/'/g, "");
	const tables = execFileSync("sqlite3", [db, "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%session_id%'"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
	execFileSync("sqlite3", [db, [...tables.map((t) => `DELETE FROM ${t} WHERE session_id != '${keep}';`), `DELETE FROM sessions WHERE id != '${keep}';`, "VACUUM;"].join(" ")]);
	const cwd = execFileSync("sqlite3", [db, `SELECT json_extract(meta, '$.cwd') FROM sessions WHERE id = '${keep}'`], { encoding: "utf8" }).trim();
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [],
		mcpServers: [],
		projects: [{ id: cwd, name: cwd.split("/").at(-1), path: cwd, pinned: true, lastOpenedAt: 1 }],
		showThinking: true,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

/** 转录里两句话之间画出来的每一行活：`[data-ly-step]` 上写着什么。 */
const between = (from: string, to: string) => `(() => {
	const textAt = (needle) => {
		const walk = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
		for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent.includes(needle)) return node.parentElement;
		return null;
	};
	const a = textAt(${JSON.stringify(from)}), b = textAt(${JSON.stringify(to)});
	if (!a || !b) return null;
	return [...document.querySelectorAll("main [data-ly-step]")]
		.filter((step) => a.compareDocumentPosition(step) & Node.DOCUMENT_POSITION_FOLLOWING && step.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
		.filter((step) => !step.parentElement.closest("[data-ly-step]"))
		.map((step, i) => (i === 0 && step.setAttribute("data-probe-first", ""), step))
		.map((step) => (step.querySelector(".ly-flow-row") ?? step).textContent.replace(/\\s+/g, " ").trim());
})()`;

let app: RunningApp | undefined;
const frames: Frame[] = [];
let shot = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	const scrollTo = (needle: string) => app!.evaluate(`(() => {
		const walk = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT);
		for (let node = walk.nextNode(); node; node = walk.nextNode()) if (node.textContent.includes(${JSON.stringify(needle)})) { node.parentElement.scrollIntoView({ block: "start" }); return true; }
		return false;
	})()`);

	await d.until(`document.querySelector('[data-ly-row="${SESSION}"]')`, 60000);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await openSession(app, SESSION);
	await d.until(`document.querySelector("main")?.textContent.includes(${JSON.stringify(TO)})`, 20000);
	await pause(1000);

	await scrollTo(FROM);
	await pause(1200);
	const after = await app.evaluate<string[] | null>(between(TO, NEXT));
	// 后量这一段：点开时要找的是它的第一行（`data-probe-first`）。
	await app.evaluate(`document.querySelectorAll("[data-probe-first]").forEach((el) => el.removeAttribute("data-probe-first"))`);
	const repair = await app.evaluate<string[] | null>(between(FROM, TO));
	console.log(`「${FROM}」到「${TO}」之间：`, repair);
	console.log(`「${TO}」到「${NEXT}」之间：`, after);
	await capture("改失败再改那一段");

	if (LABEL === "after") {
		check("edit 失败 → sed → python → edit 失败 → read → edit 合成一行", repair?.length === 1, repair);
		check("那一行说的是几类合起来的总数", /修改文件/.test(repair?.[0] ?? "") && /执行命令/.test(repair?.[0] ?? "") && /读取文件/.test(repair?.[0] ?? ""), repair);
		check("「更新 spec 检查点」后面的 edit 失败 → read → edit 也是一行", after?.length === 1, after);

		// 点开那一行：六次调用都还在，挂在竖线上。
		await click(app, "main [data-probe-first] .ly-flow-row");
		await pause(1400);
		const rail = await app.evaluate<number>(`(() => {
			const rails = [...document.querySelectorAll("main [data-ly-step-rail]")].filter((rail) => rail.getBoundingClientRect().height > 0);
			return rails.length === 1 ? rails[0].children.length : -rails.length;
		})()`);
		await capture("点开那一行");
		check("点开后六次调用一次一行，一个不少", rail === 6, rail);
		await click(app, "main [data-probe-first] .ly-flow-row");
		await pause(1000);
	}
	await scrollTo(NEXT);
	await pause(1400);
	await capture("后面验证那一段");
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	const video = join(OUT_DIR, `${STAMP}_${LABEL}_跨类合并_${passed}of${checks.length}.mp4`);
	await encode(frames, video);
	console.log(`\n${passed}/${checks.length} 通过，视频：${video}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
}
