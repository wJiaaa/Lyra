/* oxlint-disable no-console -- probe CLI plumbing that prints what it did and where the film went */
/**
 * Whether the project menu opens where it stays: five opens, the card's position read on every painted frame.
 *
 * `node --experimental-strip-types e2e/popover-first-frame-probe.ts <label> [output dir]`
 *
 * The window is the reported one — 1072×790, fifteen projects — where the list at full length fits
 * neither above nor below the chip but fits on one side once capped at 340. The first frame used to
 * be placed from the full length and slid into the window over the chip; the next one, measured
 * again, jumped to the side it belonged on. Positions come from a rAF loop (what each frame was about to paint), the film from the
 * screencast, which delivers every composited frame — the one-frame jump included, as long as the
 * window is not covered.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { click, frames, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9526;
const OPENS = 5;
const NAMES = [
	"quantum", "aurora", "borealis", "cascade", "delta", "ember", "fjord", "glacier",
	"harbor", "island", "jade", "kepler", "lumen", "meadow", "nova",
];

const label = process.argv[2] ?? "run";
// Local time, as the files are named for whoever opens the folder — not UTC.
const now = new Date();
const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
	.map((part) => String(part).padStart(2, "0"))
	.join("-");
const out = process.argv[3] ?? join(homedir(), "Desktop", "Plume浮层退场测试");

async function seed(home: string): Promise<void> {
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1072, height: 790, x: 0, y: 0 }));
	const projects = [];
	for (const [index, name] of NAMES.entries()) {
		const path = join(home, "projects", name);
		await mkdir(path, { recursive: true });
		// The first is the most recent, so it is the one the window opens on.
		projects.push({ id: name, name, path, pinned: false, lastOpenedAt: NAMES.length - index });
	}
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projects[0].path });
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1, providers: [], mcpServers: [], projects,
			appearance: { theme: "light" }, permissionMode: "full",
			hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		}),
	);
}

interface Sample { t: number; top: number | null; height?: number }

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// The user's own ~/.claude is not this window's business, and must not end up on film.
const claudeHome = await mkdtemp(join(tmpdir(), "plume-claude-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const app = await startApp({ port: PORT, seed });
const film: Frame[] = [];
let stopFilm: (() => Promise<void>) | undefined;

const CHIP = "main button";
const CHIP_NAME = "quantum";
const CHIP_FIND = `[...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "quantum")`;

try {
	await until(app, `Boolean(${CHIP_FIND})`, 1200);
	await pause(1500);
	const view = await app.evaluate<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);
	console.log(`窗口 ${view.width}×${view.height}（${label}）`);

	stopFilm = await startRecording(PORT, film);
	await pause(1000);

	const firsts: { at: number; open: number }[] = [];
	for (let open = 1; open <= OPENS; open++) {
		const chip = await app.evaluate<{ top: number; bottom: number }>(
			`(() => { const r = ${CHIP_FIND}.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`,
		);

		// Started before the press, so the first frame with the card in it is the first one painted.
		await app.evaluate(`(() => {
			window.__probe = { open: ${open}, samples: [], on: true, pressAt: 0 };
			// The wall clock, which the screencast's frames are stamped with too.
			window.addEventListener("mousedown", () => { window.__probe.pressAt = Date.now(); }, { capture: true, once: true });
			const tick = (t) => {
				const probe = window.__probe;
				if (!probe.on) return;
				const card = document.querySelector("[data-ly-popover]");
				if (card && !card.dataset.probeOpen) card.dataset.probeOpen = String(probe.open);
				if (card && card.dataset.probeOpen === String(probe.open)) {
					probe.samples.push({ t: Math.round(t), top: card.offsetTop, height: card.offsetHeight });
				} else probe.samples.push({ t: Math.round(t), top: null });
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		})()`);
		await click(app, CHIP, CHIP_NAME);
		await pause(900);
		firsts.push({ at: await app.evaluate<number>("window.__probe.pressAt"), open });

		const samples = await app.evaluate<Sample[]>(`(() => { window.__probe.on = false; return window.__probe.samples; })()`);
		const shown = samples.filter((s) => s.top !== null);
		// Offsets, not the client rect: the entrance scales the card about the corner nearest the chip.
		const tops = [...new Set(shown.map((s) => s.top))];
		const clear = (s: Sample | undefined) => s?.top != null && (s.top + (s.height ?? 0) <= chip.top || s.top >= chip.bottom);
		const first = shown[0];
		const last = shown.at(-1);
		const trail = shown.slice(0, 8).map((s) => `${s.top}(${s.height})`).join(" → ");
		console.log(`第 ${open} 次：按钮 ${Math.round(chip.top)}–${Math.round(chip.bottom)}，菜单前 8 帧 top(高) = ${trail}，共 ${shown.length} 帧`);
		check(
			`第 ${open} 次打开：第一帧就没压住按钮，之后 ${shown.length - 1} 帧没挪过`,
			Boolean(first && last) && tops.length === 1 && clear(first),
			`第一帧 top=${first?.top}、高 ${first?.height}；最后 top=${last?.top}、高 ${last?.height}；出现过的位置 ${tops.join("、")}`,
		);

		// Close it the way the report did — the chip again — and wait out the exit.
		await click(app, CHIP, CHIP_NAME);
		await until(app, `!document.querySelector("[data-ly-popover]") && !document.querySelector("[data-ly-popover-ghost]")`);
		await frames(app, 30);
	}

	await stopFilm();
	stopFilm = undefined;
	await mkdir(out, { recursive: true });
	const passed = checks.filter((c) => c.ok).length;
	const name = `${stamp}_${label}_项目菜单连开${OPENS}次_${passed}of${checks.length}`;
	await encode(film, join(out, `${name}.mp4`), 60);

	/*
	 * The first open again at a tenth of the speed: a jump that lasts one frame is gone before the
	 * eye finds it at full speed. Each frame is held ten times as long as it really was.
	 */
	const at = firsts[0].at;
	const around = film.filter((f) => f.at >= at - 300 && f.at <= at + 900);
	await encode(around.map((f) => ({ at: at + (f.at - at) * 10, data: f.data })), join(out, `${name}_第1次慢放10倍.mp4`), 60);

	/*
	 * The first frames with the menu in them, as stills: the jump, if there is one, is among them.
	 * Screencast frames are stamped when they arrive, which trails the paint, so the menu's first frame
	 * is found by the picture changing rather than by the clock — a menu over the page moves the JPEG's
	 * size by far more than the chip's hover does.
	 */
	const pressed = film.findIndex((f) => f.at >= firsts[0].at);
	const base = pressed > 0 ? film[pressed - 1].data.length : 0;
	const appears = film.findIndex((f, i) => i >= pressed && Math.abs(f.data.length - base) > base * 0.03);
	const after = appears === -1 ? [] : film.slice(appears, appears + 4);
	for (const [index, frame] of after.entries()) {
		await writeFile(join(out, `${stamp}_${label}_项目菜单第1次打开_第${String(index + 1).padStart(2, "0")}帧.jpg`), frame.data);
	}
	console.log(`\n${passed}/${checks.length} 通过；录像 ${film.length} 帧，放在 ${out}`);
	process.exitCode = passed === checks.length ? 0 : 1;
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 2;
} finally {
	await stopFilm?.().catch(() => {});
	await app.stop();
	await rm(claudeHome, { recursive: true, force: true });
}
