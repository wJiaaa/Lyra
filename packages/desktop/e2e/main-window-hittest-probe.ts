/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Whether the main window is still catching clicks while a capture is up.
 *
 * Activating the overlay activates Plume, and macOS raises every window of an application it
 * activates — so the main window ends up above whatever is being screenshotted, hidden only by the
 * frozen picture on top of it. It is made to "step aside" for the duration, and the question this
 * answers is whether stepping aside is enough: a window made transparent is invisible, but macOS
 * still hits it. During a colour pick the overlay is deliberately click-through, so anything the
 * main window still catches is a click that lands nowhere the user can see.
 *
 * Asked of the window server rather than of Electron, through `CGWindowListCopyWindowInfo`:
 * `kCGWindowAlpha` says how transparent a window is, and its position in the list says how far
 * forward. A window at alpha 0 that is still in the on-screen list is exactly the failure — present
 * to the hit test, absent to the eye.
 *
 * Run: node --experimental-strip-types e2e/main-window-hittest-probe.ts
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every on-screen window belonging to this app, front to back, with its transparency. */
const LIST = `
ObjC.import("CoreGraphics");
ObjC.import("Foundation");
const ref = $.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
  $.kCGNullWindowID,
);
const all = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
JSON.stringify(
  all
    .map((w, i) => ({
      order: i,
      app: String(w.kCGWindowOwnerName || ""),
      pid: w.kCGWindowOwnerPID,
      layer: w.kCGWindowLayer,
      alpha: w.kCGWindowAlpha,
      w: w.kCGWindowBounds ? Math.round(w.kCGWindowBounds.Width) : 0,
      h: w.kCGWindowBounds ? Math.round(w.kCGWindowBounds.Height) : 0,
    }))
    .filter((w) => w.w > 200 && w.h > 200),
);
`;

interface Win { order: number; app: string; pid: number; layer: number; alpha: number; w: number; h: number }

async function windows(): Promise<Win[]> {
	const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", LIST]);
	return JSON.parse(stdout.trim()) as Win[];
}

const app = await startApp({ port: 9420 });
const problems: string[] = [];
const note = (s: string) => console.log(s);

try {
	await pause(6000);

	/*
	 * Started from somewhere else, which is the case that matters.
	 *
	 * A capture begun from inside Plume is expected to come back to Plume, and the main window is left
	 * where it is. It is the global-shortcut case — screenshotting another application — where the
	 * main window has no business being in front.
	 */
	await execFileAsync("osascript", ["-e", 'tell application "Finder" to activate']).catch(() => {});
	await pause(1200);

	const ours = (list: Win[]) => list.filter((w) => w.app === "Electron" || w.app.includes("Plume"));
	const before = await windows();
	note(`截图前  Plume 的窗口：${JSON.stringify(ours(before).map((w) => ({ 序: w.order, 尺寸: `${w.w}×${w.h}`, 透明度: w.alpha })))}`);

	await app.evaluate(`window.plume.screenshot.start()`);
	await pause(1500);

	const during = await windows();
	const mine = ours(during);
	note(`截图中  Plume 的窗口：${JSON.stringify(mine.map((w) => ({ 序: w.order, 尺寸: `${w.w}×${w.h}`, 透明度: w.alpha })))}`);

	/*
	 * A window at alpha 0 that the window server still lists is the whole problem: it is not drawn,
	 * and it is hit. During a colour pick the overlay above it is click-through by design, so every
	 * press in that second lands on a window the user cannot see and gets nothing back — which is
	 * what "Plume froze" was.
	 */
	const ghosts = mine.filter((w) => w.alpha === 0);
	if (ghosts.length > 0) {
		problems.push(
			`截图期间有 ${ghosts.length} 个 Plume 窗口透明度为 0 却仍在屏幕窗口列表里（${ghosts.map((g) => `${g.w}×${g.h} 第 ${g.order} 层`).join("、")}）——看不见，但照样接住点击`,
		);
	}

	await app.evaluate(`window.plume.screenshot.cancel()`).catch(() => {});
	await pause(1200);
	const after = await windows();
	note(`截图后  Plume 的窗口：${JSON.stringify(ours(after).map((w) => ({ 序: w.order, 尺寸: `${w.w}×${w.h}`, 透明度: w.alpha })))}`);
	const stuck = ours(after).filter((w) => w.alpha === 0);
	if (stuck.length > 0) problems.push(`截图结束后还有 ${stuck.length} 个 Plume 窗口停在透明度 0`);
} finally {
	await app.stop();
}

console.log("");
if (problems.length === 0) {
	console.log("✅ 全部通过");
} else {
	console.log(`❌ ${problems.length} 个问题：`);
	for (const p of problems) console.log(`   - ${p}`);
	process.exitCode = 1;
}
