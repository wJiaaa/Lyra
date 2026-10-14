/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 文件面板里的视频能拖：`ly-media` 按 Range 回 206，Chromium 认它可跳（`ranged-file.ts`）。
 *
 * 量的是真窗口里那个 `<video>`：`seekable` 的范围、跳到 2.5 秒之后 `currentTime` 落在哪。改前
 * `net.fetch(file://)` 一律回 200 整个文件，`seekable` 是 [0, 0]，一跳就回到第一帧；非音视频仍走
 * 那条路，所以同一段视频换成 `.bin` 就是改前的样子，在同一个构建里拿来对照。
 *
 *   node --experimental-strip-types e2e/media-seek-probe.ts      # 录进 ~/Desktop/Plume上游同步测试
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, openPane, until } from "./drive.ts";
import { relaySettings } from "./fake-image-relay.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9481;
const OUT = join(homedir(), "Desktop", "Plume上游同步测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}\n     ${detail}`);
}

let app: RunningApp;
async function shot(name: string) {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	const file = join(OUT, `${stamp}_${name}.png`);
	await writeFile(file, Buffer.from(data, "base64"));
	console.log(`   📸 ${file}`);
}

const VIDEO = '[data-dock-pane="file"] video';

async function main() {
	await mkdir(OUT, { recursive: true });
	const project = await mkdtemp(join(tmpdir(), "plume-media-seek-"));
	// Five seconds with a keyframe every half second, so a seek lands where it was asked rather than on the nearest keyframe.
	execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=30", "-g", "15", "-pix_fmt", "yuv420p", join(project, "clip.mp4")]);
	// The same bytes under a name that is not audio or video: served the old way, for comparison in the same build.
	execFileSync("cp", [join(project, "clip.mp4"), join(project, "clip.bin")]);

	app = await startApp({
		port: PORT,
		scaleFactor: 2,
		seed: async (dir) => {
			await writeFile(join(dir, "window.json"), JSON.stringify({ width: 1280, height: 820, x: 0, y: 0 }));
			await writeFile(join(dir, "settings.json"), relaySettings(1, project, { projects: [{ path: project, name: "媒体演示", pinned: true, lastOpenedAt: Date.now() }] }));
		},
	});
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	try {
		await until(app, `document.querySelector("main textarea")`, 1200);
		await pause(1000);
		console.log("① 打开文件面板，点 clip.mp4");
		await openPane(app, "文件");
		await click(app, '[role=treeitem][data-path$="clip.mp4"]');
		await until(app, `document.querySelector(${JSON.stringify(VIDEO)})?.readyState >= 1`, 1200);
		await pause(800);
		const before = await app.evaluate<{ seekable: number[]; duration: number }>(`(() => {
			const v = document.querySelector(${JSON.stringify(VIDEO)});
			return { seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : [], duration: v.duration };
		})()`);
		check("视频可跳：seekable 覆盖整段", before.seekable.length === 2 && before.seekable[1] > 4.5, `seekable=${JSON.stringify(before.seekable)} duration=${before.duration}`);
		await shot("01_文件面板里的视频");

		console.log("② 跳到 2.5 秒、再跳到 4 秒，和拖进度条是同一个请求");
		for (const target of [2.5, 4]) {
			const landed = await app.evaluate<number>(`new Promise((resolve) => {
				const v = document.querySelector(${JSON.stringify(VIDEO)});
				v.addEventListener("seeked", () => resolve(v.currentTime), { once: true });
				v.currentTime = ${target};
			})`);
			check(`跳到 ${target} 秒，落在 ${target} 秒`, Math.abs(landed - target) < 0.1, `currentTime=${landed}`);
			await pause(1000);
			await shot(`02_跳到${target}秒`);
		}

		console.log("③ 对照：同一段视频换成 .bin，走的是没改的那条 net.fetch(file://)——改前的视频就是这样");
		const old = await app.evaluate<{ seekable: number[]; landed: number | null }>(`new Promise((resolve) => {
			const v = document.createElement("video");
			v.muted = true;
			v.style.cssText = "position:fixed;right:24px;bottom:24px;width:320px;z-index:99999;border:2px solid red";
			document.body.append(v);
			v.addEventListener("error", () => resolve({ seekable: [], landed: null }), { once: true });
			v.addEventListener("loadedmetadata", () => {
				const seekable = v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : [];
				const done = () => resolve({ seekable, landed: v.currentTime });
				v.addEventListener("seeked", done, { once: true });
				setTimeout(done, 3000);
				v.currentTime = 2.5;
			}, { once: true });
			v.src = window.plume.files.mediaUrl(${JSON.stringify(join(project, "clip.bin"))});
		})`);
		check("对照组不可跳：seekable 不覆盖 2.5 秒，跳了回不到 2.5", old.landed === null || old.seekable.length === 0 || old.seekable[1] < 2.5 || Math.abs((old.landed ?? 0) - 2.5) > 0.1, JSON.stringify(old));
		await pause(800);
		await shot("03_对照_未按Range回答的源");
	} finally {
		await stop();
		const passed = results.filter((result) => result.ok).length;
		if (frames.length) {
			const file = join(OUT, `${stamp}_文件面板视频拖动_${passed}of${results.length}.mp4`);
			await encode(frames, file, 30, 1500);
			console.log(`🎬 ${file}`);
		}
		await app.stop();
		await rm(project, { recursive: true, force: true });
		console.log(`\n${passed}/${results.length} 通过`);
		if (passed !== results.length) process.exitCode = 1;
	}
}

void main();
