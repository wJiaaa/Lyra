/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * What the screen actually does when a capture starts and ends.
 *
 * "It jumps going in" and "the app flashes coming out" are claims about pixels over time, and no
 * amount of reading the window code settles them — the window server, the menu bar and the Dock are
 * all involved and none of them are in this repository. So this records the screen with ffmpeg,
 * drives a capture in the middle of the recording, and reports where the frames changed.
 *
 * The application is started and left to settle *before* recording begins. Getting that wrong the
 * first time recorded the app launching and called it a capture.
 *
 * Run: node --experimental-strip-types e2e/capture-motion-probe.ts
 * Frames land in /tmp/plume-motion/ for looking at.
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const PORT = 9415;
const OUT = "/tmp/plume-motion";
const CLIP = "/tmp/plume-motion.mp4";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({ port: PORT });

try {
	console.log("• 应用已启动，等它安顿下来…");
	await pause(6000);

	console.log("• 开始录屏");
	const rec = spawn(
		"ffmpeg",
		["-f", "avfoundation", "-capture_cursor", "1", "-framerate", "30", "-i", "4", "-t", "14", "-vf", "scale=1470:-1", "-y", CLIP],
		{ stdio: "ignore", detached: false },
	);
	await pause(3000);

	console.log("• 触发截图（录屏第 3 秒）");
	await app.evaluate(`window.plume.screenshot.start()`);
	await pause(5000);

	console.log("• 取消截图（录屏第 8 秒）");
	await app.evaluate(`window.plume.screenshot.cancel?.()`).catch(() => {});
	await pause(4000);

	rec.kill("SIGINT");
	await new Promise((r) => rec.once("exit", r));
	console.log(`• 录屏完成 → ${CLIP}`);
} finally {
	await app.stop();
}

/*
 * Where the picture changed, and by how much.
 *
 * `scene` is ffmpeg's own measure of how different a frame is from the one before it. A capture
 * that arrives smoothly produces a couple of small steps; one that jumps produces a spike, and the
 * timestamp of that spike says which moment to go and look at.
 */
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await execFileAsync("ffmpeg", ["-i", CLIP, "-vf", "fps=30", "-q:v", "3", `${OUT}/f%03d.jpg`]);
const frames = (await readdir(OUT)).filter((f) => f.endsWith(".jpg")).length;

const { stderr } = await execFileAsync("ffmpeg", ["-i", CLIP, "-vf", "select='gt(scene,0.008)',showinfo", "-f", "null", "-"], {
	maxBuffer: 32 * 1024 * 1024,
});
const moments = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number(m[1]));

console.log("");
console.log(`共 ${frames} 帧（30fps，第 n 帧 ≈ n/30 秒）`);
console.log(`画面发生明显变化的时刻：${moments.map((t) => t.toFixed(2)).join(", ") || "(没有)"}`);
console.log("");
console.log("参考：截图在第 3 秒触发，第 8 秒取消。");
console.log(`进入前后看 ${OUT}/f0${Math.round(2.8 * 30)}.jpg … f0${Math.round(3.6 * 30)}.jpg`);
console.log(`退出前后看 ${OUT}/f${Math.round(7.8 * 30)}.jpg … f${Math.round(8.6 * 30)}.jpg`);
