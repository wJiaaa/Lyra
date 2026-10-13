/* oxlint-disable no-console -- probe CLI plumbing that prints what it measured and where the film went */
/**
 * Whether a dialog leaves the way it came in, read on every painted frame.
 *
 * `node --experimental-strip-types e2e/dialog-exit-probe.ts <label> [output dir]`
 *
 * The dialog is 新建项目, reached from the composer's project chip. Two closes:
 *
 * 1. its own 取消 button — which called `onClose` straight and unmounted the dialog in that frame,
 * 2. Escape about 50ms into the 180ms entrance — whose exit had a fixed `from`, so the card jumped
 *    back to fully opaque before it faded.
 *
 * Each frame records the card's opacity. "Played" means painted frames strictly between opaque and
 * gone after the close; "no jump" means the opacity never climbs once the close has been heard.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, press, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9474;
const label = process.argv[2] ?? "run";
const now = new Date();
const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
	.map((part) => String(part).padStart(2, "0"))
	.join("-");
const out = process.argv[3] ?? join(homedir(), "Desktop", "Plume浮层退场测试");

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

let app: RunningApp | undefined;
function running(): RunningApp {
	if (!app) throw new Error("app 还没起来");
	return app;
}

/** Logs the dialog card's opacity on every frame, and when the closing input was heard. */
async function watch() {
	await running().evaluate(`(() => {
		const probe = { samples: [], on: true, closeAt: 0 };
		window.__dialog = probe;
		probe.heard = () => { if (!probe.closeAt) probe.closeAt = performance.now(); };
		window.addEventListener("mousedown", probe.heard, true);
		window.addEventListener("keydown", probe.heard, true);
		const tick = (t) => {
			if (!probe.on) return;
			const card = document.querySelector("[data-ly-modal]");
			probe.samples.push({ t, o: card ? Math.round(Number(getComputedStyle(card).opacity) * 1000) / 1000 : null });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	})()`);
}

async function read() {
	await pause(700);
	return running().evaluate<{ closeAt: number; samples: { t: number; o: number | null }[]; left: number }>(`(() => {
		const probe = window.__dialog;
		probe.on = false;
		window.removeEventListener("mousedown", probe.heard, true);
		window.removeEventListener("keydown", probe.heard, true);
		return { closeAt: probe.closeAt, samples: probe.samples, left: document.querySelectorAll("[data-ly-modal], [data-ly-overlay]").length };
	})()`);
}

function judge(name: string, reading: Awaited<ReturnType<typeof read>>) {
	const before = reading.samples.filter((s) => s.t < reading.closeAt && s.o !== null).map((s) => s.o as number);
	const after = reading.samples.filter((s) => s.t >= reading.closeAt);
	const gone = after.findIndex((s) => s.o === null);
	const visible = (gone === -1 ? after : after.slice(0, gone)).map((s) => s.o as number);
	const between = visible.filter((o) => o > 0.02 && o < 0.98).length;
	const atClose = before.at(-1);
	const peak = Math.max(...visible, 0);
	let climbs = 0;
	for (let i = 1; i < visible.length; i++) if (visible[i] > visible[i - 1] + 0.01) climbs++;
	// Each frame with how long after the close it was painted: a fade squeezed into a few frames is a cut.
	const trail = visible.map((o, i) => `${o.toFixed(2)}@${Math.round(after[i].t - reading.closeAt)}ms`).join(" → ") || "（第一帧就没了）";
	console.log(`\n${name}：关之前最后一帧 ${atClose?.toFixed(2) ?? "—"}；关之后逐帧 ${trail}${gone === -1 ? "" : " → 无"}；${between} 帧中间态；残留 ${reading.left}`);
	check(`${name}：退场播出来了（中间态 ≥ 4 帧）`, between >= 4, `${between} 帧`);
	check(`${name}：关之后不往回跳（不先变回不透明再淡）`, climbs === 0 && (atClose === undefined || peak <= atClose + 0.02), `关时 ${atClose}，之后最高 ${peak}，往回跳 ${climbs} 次`);
	check(`${name}：半秒后不留任何东西`, reading.left === 0, `${reading.left} 个节点`);
}

// The project chip reads as the folder's name; 新建项目 is a row in the menu it opens.
const CHIP = '[data-dock-pane="conversation"] button';
const CHIP_NAME = "project";
const NEW = '[role="menu"] button';
const CANCEL = "[data-ly-modal] button";

async function openNewProject(page: RunningApp) {
	await click(page, CHIP, CHIP_NAME);
	await click(page, NEW, "新建项目");
	await until(page, `document.querySelector('[data-ly-project-dialog]')`);
}

async function main() {
	app = await startApp({ port: PORT, seed: async (home) => { await seedInteractions(home); } });
	await click(app, '[data-ly-row="qa-short"] > button');
	await pause(800);
	const film: Frame[] = [];
	const marks: number[] = [];
	const stopFilm = await startRecording(PORT, film);
	await pause(600);

	// 1. 取消, after the entrance has settled.
	await openNewProject(app);
	await pause(700);
	await watch();
	marks.push(Date.now());
	await click(app, CANCEL, "取消");
	judge("点「取消」", await read());
	await pause(500);

	// 2. Escape ~50ms into the entrance.
	await openNewProject(app);
	await watch();
	await pause(30);
	marks.push(Date.now());
	await press(app, "Escape", 27);
	judge("入场途中按 Esc", await read());
	await pause(500);

	await stopFilm();
	await mkdir(out, { recursive: true });
	const passed = checks.filter((c) => c.ok).length;
	const name = `${stamp}_${label}_对话框退场_${passed}of${checks.length}`;
	await encode(film, join(out, `${name}.mp4`), 60);
	// Both closes again at a tenth of the speed: a 130ms exit is gone before the eye finds it.
	const slow: Frame[] = [];
	let offset = 0;
	for (const at of marks) {
		const around = film.filter((f) => f.at >= at - 250 && f.at <= at + 600);
		if (!around.length) continue;
		const base = around[0].at;
		for (const frame of around) slow.push({ at: offset + (frame.at - base) * 10, data: frame.data });
		offset += (around.at(-1)!.at - base) * 10 + 1500;
	}
	if (slow.length) await encode(slow, join(out, `${name}_慢放10倍.mp4`), 60);
	console.log(`\n${passed}/${checks.length} 通过；录像 ${film.length} 帧，放在 ${out}`);
	process.exitCode = passed === checks.length ? 0 : 1;
}

const claudeHome = await mkdtemp(join(tmpdir(), "plume-claude-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 2;
} finally {
	await app?.stop();
	await rm(claudeHome, { recursive: true, force: true });
}
