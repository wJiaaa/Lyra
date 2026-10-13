/* oxlint-disable no-console -- probe CLI plumbing that prints what it measured and where the film went */
/**
 * Whether a popover plays its exit however it is closed — read on every painted frame.
 *
 * `node --experimental-strip-types e2e/popover-exit-probe.ts <label> [output dir]`
 *
 * Four ways out, the first three being the ones that used to vanish in a single frame:
 *
 * 1. pressing the trigger again (the project chip: `usePopover().toggle` sets the anchor to null),
 * 2. choosing a row (the model menu: the row calls `onClose` itself),
 * 3. leaving a delivery card's hover preview (`setHover(null)` unmounts it),
 * 4. Escape — the one path that always had an exit, kept as the reference.
 *
 * Each frame records the opacity of every floating card on screen (the real one and any copy left to
 * fade). "Played" means painted frames strictly between opaque and gone after the close, and the last
 * one before nothing is drawn being near zero; "no flash" means the opacity never climbs back up on
 * the way out; "no residue" means nothing of it is left in the document half a second later.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9472;
const label = process.argv[2] ?? "run";
const now = new Date();
const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
	.map((part) => String(part).padStart(2, "0"))
	.join("-");
const out = process.argv[3] ?? join(homedir(), "Desktop", "Plume浮层退场测试");

interface Sample { t: number; cards: { o: number; ghost: boolean }[] }
interface Reading { closeAt: number; samples: Sample[]; residue: number }

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

let app: RunningApp | undefined;
let server: Server | undefined;
let turns = 0;

function written(index: number): string {
	const lines = [`export const value${index} = ${index};`];
	for (let i = 0; i < 30; i++) lines.push(`export const field_${index}_${i} = ${JSON.stringify("内容行")};`);
	return `${lines.join("\n")}\n`;
}

function running(): RunningApp {
	if (!app) throw new Error("app 还没起来");
	return app;
}

async function mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) {
	await running().send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
}

/**
 * Starts a per-frame log of every floating card, and of when the closing input arrived.
 *
 * The close time is taken from the input event itself, in the capture phase, so it is the moment the
 * app heard it rather than the moment this script asked for it.
 */
async function watch(): Promise<void> {
	await running().evaluate(`(() => {
		const probe = { samples: [], on: true, closeAt: 0 };
		window.__exit = probe;
		const heard = () => { if (!probe.closeAt) probe.closeAt = performance.now(); };
		probe.heard = heard;
		window.addEventListener("mousedown", heard, true);
		window.addEventListener("keydown", heard, true);
		const tick = (t) => {
			if (!probe.on) return;
			const cards = [...document.querySelectorAll(".ly-menu-card:is([data-ly-popover], [data-ly-popover-ghost])")].map((card) => ({
				o: Math.round(Number(getComputedStyle(card).opacity) * 1000) / 1000,
				ghost: card.hasAttribute("data-ly-popover-ghost"),
			}));
			probe.samples.push({ t: Math.round(t * 10) / 10, cards });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	})()`);
}

/** Stops the log; a close with no input event (the hover preview) is dated by its first fading frame. */
async function read(fallbackClose: "first-change" | "event" = "event"): Promise<Reading> {
	await pause(700);
	return running().evaluate<Reading>(`(() => {
		const probe = window.__exit;
		probe.on = false;
		window.removeEventListener("mousedown", probe.heard, true);
		window.removeEventListener("keydown", probe.heard, true);
		let closeAt = probe.closeAt;
		if (${JSON.stringify(fallbackClose)} === "first-change" || !closeAt) {
			const first = probe.samples.find((s) => s.cards.length === 0 || s.cards.some((c) => c.ghost || c.o < 0.98));
			closeAt = first ? first.t - 0.1 : 0;
		}
		return { closeAt, samples: probe.samples, residue: document.querySelectorAll("[data-ly-popover], [data-ly-popover-ghost]").length };
	})()`);
}

function judge(name: string, reading: Reading) {
	const after = reading.samples.filter((s) => s.t >= reading.closeAt);
	const opacities = after.map((s) => (s.cards.length ? Math.max(...s.cards.map((c) => c.o)) : null));
	const goneAt = opacities.findIndex((o) => o === null);
	const visible = (goneAt === -1 ? opacities : opacities.slice(0, goneAt)) as number[];
	const between = visible.filter((o) => o > 0.02 && o < 0.98).length;
	const last = visible.at(-1);
	let climbs = 0;
	for (let i = 1; i < visible.length; i++) if (visible[i] > visible[i - 1] + 0.01) climbs++;
	const ms = goneAt === -1 ? null : Math.round(after[goneAt].t - reading.closeAt);
	const trail = visible.map((o) => o.toFixed(2)).join(" → ") || "（第一帧就没了）";
	console.log(`\n${name}：关之后逐帧不透明度 ${trail}${goneAt === -1 ? "" : " → 无"}；${ms === null ? "一直没消失" : `${ms}ms 后不再画`}；${between} 帧在中间态；残留 ${reading.residue}`);
	check(`${name}：退场播出来了（中间态 ≥ 4 帧）`, between >= 4, `${between} 帧`);
	check(`${name}：播完才消失（最后一帧不透明度 ≤ 0.15）`, last !== undefined && last <= 0.15, `最后一帧 ${last}`);
	check(`${name}：一路往下，没有跳回去再淡（不闪）`, climbs === 0, `往回跳 ${climbs} 次：${trail}`);
	check(`${name}：半秒后不留任何东西`, reading.residue === 0, `${reading.residue} 个节点`);
	return { between, last, ms, trail };
}

// The project chip (it reads as the folder's name) and the model button in the conversation's composer.
const CHIP = '[data-dock-pane="conversation"] button';
const CHIP_NAME = "project";
const PROJECT_MENU = '[role="menu"][aria-label="切换项目"]';
const MODEL = '[data-dock-pane="conversation"] button[aria-label="选择模型"]';
const MODEL_ROW = '[data-model="qa/model"] [role="menuitem"]';

async function main() {
	server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			const index = turns++;
			const tool = index < 3 ? { name: "write", input: { path: `exit-${index}.ts`, content: written(index) } } : null;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const emit = (kind: string, data: object) => response.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
			emit("message_start", { message: { id: `probe-${index}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `write-${index}`, name: tool.name, input: {} } : { type: "text", text: "" } });
			emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "三个文件写好了。" } });
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
			emit("message_stop", {});
			response.end();
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const modelPort = address.port;

	app = await startApp({
		port: PORT,
		seed: async (home) => {
			await seedInteractions(home, modelPort);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off" }));
		},
	});

	await click(app, '[data-ly-row="qa-short"] > button');
	await type(app, '[data-dock-pane="conversation"] textarea', "写三个文件，用来看浮层的退场");
	await press(app, "Enter", 13);
	await until(app, `document.querySelector('[data-turn-delivery]')?.textContent.includes('已编辑 3 个文件')`, 1800);
	await frames(app, 30);

	const film: Frame[] = [];
	const marks: { name: string; at: number }[] = [];
	const stopFilm = await startRecording(PORT, film);
	await pause(800);
	const results: Record<string, ReturnType<typeof judge>> = {};

	// 1. The trigger again.
	await click(app, CHIP, CHIP_NAME);
	await until(app, `document.querySelector('${PROJECT_MENU}')`);
	await pause(500);
	await watch();
	marks.push({ name: "再点触发按钮", at: Date.now() });
	await click(app, CHIP, CHIP_NAME);
	results.toggle = judge("再点一次触发按钮", await read());
	await pause(600);

	// 2. A row that closes its menu.
	await click(app, MODEL);
	await until(app, `document.querySelector('${MODEL_ROW}')`);
	await pause(500);
	await watch();
	marks.push({ name: "点菜单项", at: Date.now() });
	await click(app, MODEL_ROW);
	results.item = judge("点菜单项", await read());
	await pause(600);

	// 3. The hover preview, left for empty space.
	await app.evaluate(`document.querySelector('[data-turn-delivery]').scrollIntoView({block:'end',behavior:'instant'})`);
	await frames(app);
	await hover(app, "[data-turn-delivery] [data-delivery-file]");
	await until(app, `document.querySelector('[aria-label="文件变更预览"]')?.textContent.includes('export const')`, 1200);
	await pause(500);
	await watch();
	marks.push({ name: "移开悬停预览", at: Date.now() });
	// The sidebar's empty strip at the top: outside the card, outside the preview.
	await mouse("mouseMoved", 15, 75);
	results.hover = judge("交付卡片悬停预览移开", await read("first-change"));
	await pause(600);

	// 4. Escape, the reference.
	await click(app, CHIP, CHIP_NAME);
	await until(app, `document.querySelector('${PROJECT_MENU}')`);
	await pause(500);
	await watch();
	marks.push({ name: "按 Esc", at: Date.now() });
	await press(app, "Escape", 27);
	results.escape = judge("按 Esc（原本就有退场的那条）", await read());
	await pause(600);

	/*
	 * 5. Three presses in a row: open, close, open — it must end open, and only once.
	 *
	 * Raw presses rather than `drive.click`: that one waits for the target to stop animating, and the
	 * point here is to press again while the menu is still arriving and leaving.
	 */
	const chip = await app.evaluate<{ x: number; y: number }>(
		`(()=>{const e=[...document.querySelectorAll('${CHIP}')].find((b)=>b.textContent.trim()===${JSON.stringify(CHIP_NAME)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
	);
	marks.push({ name: "连点三下", at: Date.now() });
	await mouse("mouseMoved", chip.x, chip.y);
	for (let i = 0; i < 3; i++) {
		await mouse("mousePressed", chip.x, chip.y);
		await mouse("mouseReleased", chip.x, chip.y);
		await pause(45);
	}
	await pause(500);
	const rapid = await app.evaluate<{ real: number; ghosts: number; opacity: number | null }>(`(() => {
		const real = document.querySelectorAll('${PROJECT_MENU}');
		return { real: real.length, ghosts: document.querySelectorAll("[data-ly-popover-ghost]").length, opacity: real[0] ? Number(getComputedStyle(real[0]).opacity) : null };
	})()`);
	console.log(`\n连点三下（开、关、开）之后：真菜单 ${rapid.real} 个，不透明度 ${rapid.opacity}，克隆层 ${rapid.ghosts} 个`);
	check("连点三下：最后是开着的，只有一个，完全不透明", rapid.real === 1 && rapid.opacity === 1 && rapid.ghosts === 0, JSON.stringify(rapid));
	await press(app, "Escape", 27);
	await pause(600);

	await stopFilm();
	await mkdir(out, { recursive: true });
	const passed = checks.filter((c) => c.ok).length;
	const name = `${stamp}_${label}_浮层退场四条路_${passed}of${checks.length}`;
	await encode(film, join(out, `${name}.mp4`), 60);
	// Each close again at a tenth of the speed: 120ms is seven frames, gone before the eye finds them.
	const slow: Frame[] = [];
	let offset = 0;
	for (const mark of marks.slice(0, 3)) {
		const around = film.filter((f) => f.at >= mark.at - 200 && f.at <= mark.at + 900);
		if (!around.length) continue;
		const base = around[0].at;
		for (const frame of around) slow.push({ at: offset + (frame.at - base) * 10, data: frame.data });
		offset += (around.at(-1)!.at - base) * 10 + 1500;
	}
	if (slow.length) await encode(slow, join(out, `${name}_前三条慢放10倍.mp4`), 60);
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
	await closeListeningServer(server);
	await rm(claudeHome, { recursive: true, force: true });
}
