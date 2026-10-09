/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 按住缝上的把手拖：把手要一路跟着指针沿缝走，而不是停在按下的那个高度。
 *
 * 三条缝里量两条：会话列表和会话之间（`ResizeHandle`）、会话和右侧面板之间（dock 的 `Splitter`）；
 * 分屏的 `Splitter` 和 dock 的是同一份写法。每一步先横着拖、再顺着缝拖，读把手的中心和指针差多少。
 *
 * Usage: build first (`pnpm --filter @plume/desktop build`), then
 * `node --experimental-strip-types packages/desktop/e2e/seam-grip-drag-demo.ts [before|after] [outDir]`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp } from "./app.ts";
import { hover, openPane, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const MODE = process.argv[2] === "before" ? "before" : "after";
const OUT = process.argv[3] ?? join(homedir(), "Desktop", "Plume侧栏毛玻璃测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9884;

const checks: boolean[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push(ok);
	console.log(`   ${ok ? "✅" : "❌"} ${what}  ${JSON.stringify(saw)}`);
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const app = await startApp({ port: PORT, seed: async (home) => {
	await mkdir(join(home, "alpha"), { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820, x: 40, y: 40 }));
	const at = Date.now() - 60_000;
	seedSessions(home, [{ meta: { id: "alpha-0", title: "alpha 会话", cwd: join(home, "alpha"), projectId: "alpha", projectName: "alpha", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage, seq: 1 }, records: [] }] as Parameters<typeof seedSessions>[1]);
	await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, appearance: { theme: "light" }, providers: [], mcpServers: [], projects: [{ id: "alpha", name: "alpha", path: join(home, "alpha"), pinned: false, lastOpenedAt: 1 }], hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [] }));
} });

try {
	await until(app, `document.querySelectorAll("[data-ly-row]").length >= 1`);
	await openSession(app, "alpha-0");
	await openPane(app, "终端");
	await pause(1200);
	const recorded: Frame[] = [];
	const stop = await startRecording(PORT, recorded);
	console.log(`\n== ${MODE}`);
	for (const [name, seam, dx] of [["会话列表和会话之间", '[role="separator"][aria-label="调整侧边栏宽度"]', 8], ["会话和面板之间", "[data-ly-pane-dock] .ly-splitter", -8]] as const) {
		const find = `[...document.querySelectorAll(${JSON.stringify(seam)})].find((e) => e.checkVisibility())`;
		await hover(app, seam);
		await pause(600);
		const start = await app.evaluate<{ x: number; y: number }>(`(() => { const r = ${find}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 220 }; })()`);
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
		await pause(400);
		await app.send("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
		const seen: { pointer: number[]; grip: number | null; seam: number }[] = [];
		for (let i = 1; i <= 15; i++) {
			// Across first, and wait for the seam to catch up; then straight along it. The second move
			// stays inside the strip, so no `pointerenter` comes to move the grip on its behalf — which
			// is what a real hand does, and what a drag of diagonal steps alone never shows.
			await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + dx * i, y: start.y + 20 * (i - 1), button: "left", buttons: 1 });
			await pause(90);
			const at = { x: start.x + dx * i, y: start.y + 20 * i };
			await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at, button: "left", buttons: 1 });
			await pause(90);
			const now = await app.evaluate<{ grip: number | null; seam: number }>(`(() => { const s = ${find}, m = s.querySelector('span'), r = m?.getBoundingClientRect(); return { grip: r ? Math.round((r.top + r.height / 2) * 10) / 10 : null, seam: Math.round(s.getBoundingClientRect().left) }; })()`);
			seen.push({ pointer: [at.x, at.y], ...now });
		}
		await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: start.x + dx * 15, y: start.y + 300, button: "left", buttons: 0, clickCount: 1 });
		await pause(600);
		const off = seen.map((s) => (s.grip === null ? null : Math.round((s.grip - s.pointer[1]) * 10) / 10));
		console.log(`   · ${name}：把手中心减指针高度`, JSON.stringify(off), "缝的位置", JSON.stringify([seen[0].seam, seen.at(-1)!.seam]));
		check(`${name}：拖动时缝跟着指针横着走`, Math.abs(seen.at(-1)!.seam - seen[0].seam) >= 100, [seen[0].seam, seen.at(-1)!.seam]);
		check(`${name}：拖动时把手一直在，每一步都在指针高度上（±1px）`, off.every((d) => d !== null && Math.abs(d) <= 1), off);
	}
	await pause(600);
	await stop();
	const passed = checks.filter(Boolean).length;
	await mkdir(OUT, { recursive: true });
	await encode(recorded, join(OUT, `${STAMP}_${MODE}_按住拖动把手跟着指针_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} passed · ${OUT}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app.stop();
}
