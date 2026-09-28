/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * The reported bug, end to end, in the real app: capture from elsewhere, cancel, click the dock.
 *
 * "Clicking Plume in the dock kills every mouse click on the machine, and only Escape gives it back."
 * What was behind it was the capture overlay — full-screen, above the menu bar, opaque to the mouse
 * and showing nothing — being left ordered in by a close that hid the application, and restored by
 * macOS along with it. `overlay-dismiss-probe.ts` proves the window-level mechanism in isolation and
 * runs in seconds; this one is the whole path, in the real app, with a real capture in it.
 *
 * Three things here were each wrong on the first try, and each looked right:
 *
 *   - `document.visibilityState`, as the way to ask whether the overlay is on screen. This app runs
 *     with `disable-backgrounding-occluded-windows` and the overlay with `backgroundThrottling:
 *     false`, so the page says `visible` no matter what the window is doing. It reported `visible`
 *     immediately after an Escape that had certainly closed the capture. The window server is asked
 *     instead — see `overlayWindows`.
 *   - `NSRunningApplication.unhide`, as the way to click the dock icon. It restores the windows
 *     without the activation notification, so the app never learns it was activated and every net
 *     that hangs off `did-become-active` sleeps through it. The bug reproduced and the fix could not
 *     be seen to work, which is the worst of both.
 *   - `open -a`, as the same thing done differently. It did nothing at all to a hidden app: no
 *     restore, no notification, and a green run that proved nothing.
 *
 * AppleScript's `activate` does both halves, which the capture log confirms — the run has
 * `did-become-active` where the user's own log has it.
 *
 * Needs screen recording permission, since it takes a real capture.
 *
 * Run: node --experimental-strip-types e2e/overlay-dock-revive-probe.ts
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const PORT = 9422;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function targets(): Promise<{ type: string; url: string; webSocketDebuggerUrl?: string }[]> {
	return (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as never;
}

async function overlayTarget() {
	for (let i = 0; i < 40; i++) {
		const found = (await targets()).find((t) => t.type === "page" && t.url.includes("screenshot-overlay"));
		if (found?.webSocketDebuggerUrl) return found;
		await pause(250);
	}
	return null;
}

async function send(socket: string, method: string, params: Record<string, unknown> = {}) {
	const ws = new WebSocket(socket);
	try {
		await new Promise((res, rej) => {
			ws.addEventListener("open", res, { once: true });
			ws.addEventListener("error", rej, { once: true });
		});
		const answer = new Promise((res, rej) => {
			ws.addEventListener("message", (e) => {
				const m = JSON.parse(String(e.data));
				if (m.id !== 1) return;
				if (m.error) rej(new Error(m.error.message));
				else res(m.result);
			});
			setTimeout(() => rej(new Error(`${method} timed out`)), 20_000);
		});
		ws.send(JSON.stringify({ id: 1, method, params }));
		return await answer;
	} finally {
		ws.close();
	}
}

/**
 * The overlay's window, asked of the window server.
 *
 * `document.visibilityState` was the obvious way and it is useless here: this app runs with
 * `disable-backgrounding-occluded-windows` and the overlay with `backgroundThrottling: false`, so
 * its page reports `visible` whether the window is on screen or not — it said `visible` immediately
 * after an Escape that had definitely closed the capture.
 *
 * `CGWindowListCopyWindowInfo` with `OnScreenOnly` is the actual question: a window that has been
 * hidden is not in that list, and a window macOS restored with the application is. Filtered to this
 * process and to the `screen-saver` level, which is the overlay's and nothing else's — the main
 * window is at 0 and the status item at 25.
 */
interface Win { layer: number; alpha: number; w: number; h: number }

async function overlayWindows(pid: number): Promise<Win[]> {
	const { stdout } = await execFileAsync("osascript", [
		"-l",
		"JavaScript",
		"-e",
		`ObjC.import("CoreGraphics");
		 ObjC.import("Foundation");
		 const ref = $.CGWindowListCopyWindowInfo(
		   $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
		   $.kCGNullWindowID,
		 );
		 const all = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
		 JSON.stringify(all
		   .filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer >= 1000)
		   .map((w) => ({
		     layer: w.kCGWindowLayer,
		     alpha: w.kCGWindowAlpha,
		     w: w.kCGWindowBounds ? Math.round(w.kCGWindowBounds.Width) : 0,
		     h: w.kCGWindowBounds ? Math.round(w.kCGWindowBounds.Height) : 0,
		   })))`,
	]);
	return JSON.parse(stdout.trim()) as Win[];
}

function describe(wins: Win[]): string {
	if (wins.length === 0) return "不在屏幕上";
	return wins.map((w) => `${w.w}×${w.h} layer=${w.layer} alpha=${w.alpha}`).join(", ");
}

/**
 * Click the dock icon.
 *
 * `open -a` on a bundle that is already running is what the dock does: unhide, activate, and — the
 * part that matters — the `NSApplicationDidBecomeActive` that Electron surfaces as
 * `did-become-active`. Driving `NSRunningApplication` directly instead looked equivalent and was
 * not: it restored the windows without the notification, so the app never learned it had been
 * activated. The capture log made that visible — the real user's log has `did-become-active` right
 * before the overlay came back, and the probe's log had nothing there at all.
 */
async function clickDockIcon(bundle: string): Promise<void> {
	const name = bundle.split("/").pop()!.replace(/\.app$/, "");
	// AppleScript's `activate` on a hidden application unhides it *and* makes it frontmost, which is
	// the pair the dock icon does. `open -a` did neither to a hidden app, and driving
	// `NSRunningApplication.unhide` did the first without the second.
	await execFileAsync("osascript", ["-e", `tell application "${name}" to activate`]);
}

/**
 * The GUI process, which is not the first thing `pgrep` finds.
 *
 * `electron-vite preview` passes the debugger flag down a chain of node processes that all carry it
 * in their command line, and a node process is not an application — `NSRunningApplication` returns
 * null for it, which is what "a.unhide is not a function" meant. The one wanted is the app bundle's
 * own executable, and not one of its `--type=` renderer helpers.
 */
async function electronApp(): Promise<{ pid: number; bundle: string }> {
	const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,command="], { maxBuffer: 32 * 1024 * 1024 });
	for (const line of stdout.split("\n")) {
		if (!line.includes(`remote-debugging-port=${PORT}`)) continue;
		if (line.includes("--type=")) continue;
		const bundle = /(\/.*?\.app)\/Contents\/MacOS\//.exec(line)?.[1];
		if (!bundle) continue;
		const pid = Number(line.trim().split(/\s+/)[0]);
		if (pid) return { pid, bundle };
	}
	throw new Error("找不到 Electron 主进程");
}

/** The app's own directory for this run, so its capture log can be read before it is deleted. */
let home = "";
const app = await startApp({
	port: PORT,
	seed: async (dir) => {
		home = dir;
	},
});
const problems: string[] = [];
const note = (s: string) => console.log(s);

try {
	await pause(4000);
	const { pid, bundle } = await electronApp();
	note(`• Electron 主进程 pid=${pid}  bundle=${bundle}`);

	// The case the complaint is about: the capture is started while another app is in front, so
	// `cameFromApp` is false and closing takes the `app.hide()` branch.
	await execFileAsync("osascript", ["-e", 'tell application "Finder" to activate']);
	await pause(1200);
	note("• 前台切到 Finder，从外部发起截图");

	await app.evaluate(`window.plume.screenshot.start()`);
	const overlay = await overlayTarget();
	if (!overlay?.webSocketDebuggerUrl) throw new Error("截图浮层没有出现——多半是没有屏幕录制权限");
	const socket = overlay.webSocketDebuggerUrl;
	await pause(1200);
	/*
	 * The check that the check works.
	 *
	 * A probe that reports "no overlay on screen" at every step passes whether the bug is fixed or
	 * not, so the one moment it must find a window is while the capture is up. If this is empty the
	 * rest means nothing.
	 */
	const during = await overlayWindows(pid);
	note(`• 浮层已出现 → ${describe(during)}`);
	if (during.length === 0) problems.push("截图浮层开着的时候都没在窗口列表里找到它，这个探针测不出东西");

	// Escape: the close that hides the whole application.
	await send(socket, "Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
	await pause(1500);
	note(`• 按 Esc 关闭后 → ${describe(await overlayWindows(pid))}`);

	// ---- The dock click ------------------------------------------------------
	await clickDockIcon(bundle);
	await pause(2000);
	const afterDock = await overlayWindows(pid);
	note(`• 点 Dock 激活之后 → ${describe(afterDock)}`);
	if (afterDock.length > 0) {
		problems.push(`点 Dock 之后浮层又回到屏幕上了（${describe(afterDock)}）——整块屏幕的点击都会被它吃掉`);
	}

	// And once more, because the bug re-armed itself on every round: the close that got rid of the
	// window hid the application again and left the same one behind.
	await execFileAsync("osascript", ["-e", 'tell application "Finder" to activate']);
	await pause(1000);
	await clickDockIcon(bundle);
	await pause(1500);
	const secondRound = await overlayWindows(pid);
	note(`• 再切走再点 Dock → ${describe(secondRound)}`);
	if (secondRound.length > 0) problems.push(`第二轮点 Dock 浮层又出现了（${describe(secondRound)}）`);

	// ---- The same, but finishing rather than cancelling ----------------------
	/*
	 * Which is what the report actually described — "take a screenshot, and afterwards the clicks
	 * stop" — and it is a different branch only in intent. `finishScreenshot` calls
	 * `closeScreenshotOverlay()` with no options at all, and with `cameFromApp` false every term of
	 * `stepBack` is satisfied: a finished capture started from elsewhere hides the application
	 * exactly as a cancelled one does, and leaves the same window behind.
	 *
	 * `copyToClipboard: false` because a probe has no business overwriting what someone had copied.
	 */
	await execFileAsync("osascript", ["-e", 'tell application "Finder" to activate']);
	await pause(1200);
	note("• 再来一次，这回走「完成截图」");
	await app.evaluate(`window.plume.screenshot.start()`);
	await pause(1500);
	const duringFinish = await overlayWindows(pid);
	note(`• 浮层已出现 → ${describe(duringFinish)}`);
	if (duringFinish.length === 0) problems.push("第二次截图浮层没出现，「完成」这一段没测到");

	const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	await send(socket, "Runtime.evaluate", {
		expression: `window.plume.screenshot.finish(${JSON.stringify(pixel)}, { copyToClipboard: false })`,
		awaitPromise: true,
	});
	await pause(1500);
	note(`• 完成截图后 → ${describe(await overlayWindows(pid))}`);

	await clickDockIcon(bundle);
	await pause(2000);
	const afterFinishDock = await overlayWindows(pid);
	note(`• 完成截图后点 Dock → ${describe(afterFinishDock)}`);
	if (afterFinishDock.length > 0) {
		problems.push(`「完成截图」之后点 Dock，浮层回到了屏幕上（${describe(afterFinishDock)}）`);
	}
} finally {
	// Read before `stop`, which removes the profile directory the log lives in.
	const log = await readFile(join(home, "screenshot-debug.log"), "utf8").catch(() => "");
	console.log("\n--- 主进程记的账 ---");
	console.log(log.trim().split("\n").slice(-40).join("\n") || "(没有日志)");
	await app.stop();
}

console.log("");
if (problems.length > 0) {
	for (const p of problems) console.log(`FAIL ${p}`);
	process.exit(1);
}
console.log("OK — 截图结束后点 Dock，浮层没有回到屏幕上");
