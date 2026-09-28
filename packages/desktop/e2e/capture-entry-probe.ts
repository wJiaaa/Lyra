/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Filming the first captures of a session, because that is where the report is.
 *
 * "The first few screenshots make the whole screen scale for an instant" has survived three
 * explanations — a slow capture, a window built at the work area's size, a surface released while
 * hidden — and the capture log has disproved all three: the first capture is now as quick as the
 * rest, the window is built at the full display size, and the first frame after a minute's pause
 * arrives in four milliseconds.
 *
 * So this stops explaining and looks. It records the screen at 60fps, takes four captures a few
 * seconds apart, and writes out every frame around each entry. Whatever is different about the first
 * one is in those frames, or it is not happening.
 *
 * Run: node --experimental-strip-types e2e/capture-entry-probe.ts
 * Frames land in /tmp/plume-entry/.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const OUT = "/tmp/plume-entry";
const CLIP = "/tmp/plume-entry.mp4";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({ port: 9418 });

try {
	console.log("• 应用已启动，等预热跑完…");
	await pause(7000);

	await rm(OUT, { recursive: true, force: true }).catch(() => {});
	await rm(CLIP, { force: true }).catch(() => {});
	await mkdir(OUT, { recursive: true });

	console.log("• 开始录屏");
	const rec = spawn("ffmpeg", ["-y", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", "60", "-i", "1", "-t", "26", CLIP], {
		stdio: "ignore",
	});
	await pause(2500);

	/** When each capture was asked for, measured from the start of the recording. */
	const marks: number[] = [];
	const startedAt = Date.now();
	for (let i = 1; i <= 4; i++) {
		marks.push((Date.now() - startedAt) / 1000 + 2.5);
		console.log(`• 第 ${i} 次截图（录屏第 ${marks[i - 1]!.toFixed(1)} 秒）`);
		await app.evaluate(`window.plume.screenshot.start()`);
		await pause(2200);
		await app.evaluate(`window.plume.screenshot.cancel()`);
		await pause(2800);
	}

	await new Promise((r) => rec.on("close", r));
	console.log(`• 录屏完成 → ${CLIP}`);

	/*
	 * Every frame from just before each capture was asked for to just after it landed.
	 *
	 * Half a second at 60fps is thirty frames, which is enough to hold the whole entry — the overlay
	 * is up within about 150ms of the shortcut — with room either side for whatever precedes it.
	 */
	for (const [i, at] of marks.entries()) {
		const from = Math.max(0, at - 0.15);
		await execFileAsync("ffmpeg", ["-v", "error", "-ss", String(from), "-to", String(at + 0.6), "-i", CLIP, "-vf", "fps=60", "-q:v", "2", `${OUT}/c${i + 1}_%02d.jpg`]);
	}
	console.log(`\n每次进入前后的帧写在 ${OUT}/ ：c1_* 是第一次，c4_* 是第四次`);
	console.log("对比 c1 与 c4 的同序号帧，第一次特有的东西就在里面。");
} finally {
	await app.stop();
}
