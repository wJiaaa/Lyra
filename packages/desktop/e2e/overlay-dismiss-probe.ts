/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Whether the capture overlay can come back from the dead and take the mouse with it.
 *
 * The report was that clicking Plume's dock icon killed every mouse click on the machine, and that
 * only Escape gave it back. `~/.plume/screenshot-debug.log` had the loop in it: a capture ending in
 * `app.hide()`, then `did-become-active` when the dock icon was clicked, then — thirty-four seconds
 * later — `close: entered {covering: true}`, a capture the user had finished minutes earlier still
 * being closed by a key they had no reason to press. Four more rounds after that, because the close
 * hid the application again and left the same window behind again.
 *
 * The cause is one line and one platform fact that contradict each other:
 *
 *   - `settleOverlayHidden` took the overlay off screen with `if (win.isVisible()) win.hide()`.
 *   - On macOS every window of a *hidden application* reports itself invisible — and the branch
 *     that reaches that line is the one that just called `app.hide()`.
 *
 * So the guard was false precisely where the hide was needed, the window stayed ordered in, and
 * macOS restored it along with the application. What came back covers the display at `screen-saver`
 * level on every workspace, was left opaque to the mouse by the capture that set it so, and shows
 * nothing at all — `screenshot:hidden` told the page to drop its picture. Invisible, in front of
 * everything, eating every click.
 *
 * This asks Electron directly rather than reasoning about it, and asks it twice: once with the old
 * guard, which must fail, and once with what replaced it, which must not. A probe that only proved
 * the fix works would not prove it was fixing anything.
 *
 * No screen recording permission needed: the overlay's *window* is what is on trial, so the window
 * is built with the same options `ensureOverlay` uses and never given a picture.
 *
 * Run: `node --experimental-strip-types e2e/overlay-dismiss-probe.ts`
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/**
 * The two closes, run inside a real Electron process.
 *
 * `old` is the shipped guard and `fixed` is what replaced it; everything either side of that one
 * line is identical, which is the point. Each round ends with `app.show()` — the dock icon, as far
 * as an application is concerned — and reports whether the window came back with it.
 *
 * The window options are `ensureOverlay`'s, down to the level and the workspace behaviour, because
 * a window that is merely full-screen behaves differently from one that outranks the menu bar.
 */
const MAIN = `
const { app, BrowserWindow, screen } = require("electron");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

// Each round destroys its window, and the last window closing quits an Electron app by default —
// which ended this probe silently after round one, before it had printed anything.
app.on("window-all-closed", () => {});

async function round(name, close) {
	const bounds = screen.getPrimaryDisplay().bounds;
	const win = new BrowserWindow({
		x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
		frame: false, transparent: true, show: false, alwaysOnTop: true,
		skipTaskbar: process.platform !== "darwin",
		resizable: false, movable: false, fullscreenable: false, hasShadow: false,
		acceptFirstMouse: true, backgroundColor: "#00000000", enableLargerThanScreen: true,
	});
	win.setAlwaysOnTop(true, "screen-saver");
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
	await win.loadURL("data:text/html,<body style='background:transparent'></body>");

	// What a capture does on its way in: the overlay is meant to be drawn on, so it takes the mouse.
	win.setIgnoreMouseEvents(false);
	win.showInactive();
	await pause(300);
	const shown = win.isVisible();

	// The 'stepping back' close: hide the whole application, overlay and all.
	app.hide();
	await pause(250);
	const duringSettle = win.isVisible();
	close(win);

	// The dock icon.
	app.show();
	await pause(800);
	const afterDock = win.isVisible();

	results.push({ name, shown, duringSettle, afterDock });
	win.destroy();
	await pause(200);
}

app.whenReady().then(async () => {
	await round("old  (if (win.isVisible()) win.hide())", (win) => {
		if (win.isVisible()) win.hide();
	});
	await round("fixed (win.hide() + setIgnoreMouseEvents(true))", (win) => {
		win.hide();
		win.setIgnoreMouseEvents(true);
	});
	// Written with a callback rather than logged: \`app.exit\` does not flush, and a pipe is block
	// buffered where a terminal is not — which is why this printed nothing the first time it was run
	// from a parent process and everything when run by hand.
	process.stdout.write("PROBE_JSON " + JSON.stringify(results) + "\\n", () => app.exit(0));
});
`;

interface Round {
	name: string;
	/** The overlay was on screen to begin with — otherwise the round proves nothing. */
	shown: boolean;
	/** What `settleOverlayHidden` sees 250ms after `app.hide()`. The whole bug is this being false. */
	duringSettle: boolean;
	/** Whether the window came back when the application did. Must be false. */
	afterDock: boolean;
}

async function run(): Promise<Round[]> {
	const dir = await mkdtemp(join(tmpdir(), "plume-overlay-probe-"));
	const script = join(dir, "main.cjs");
	await writeFile(script, MAIN, "utf8");
	try {
		const electron = join(ROOT, "node_modules", ".bin", "electron");
		const child = spawn(electron, [script], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
		// Kept rather than dropped: a main process that dies before it reports says why in here, and
		// the alternative is an empty failure that looks like the probe itself being broken.
		child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
		const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
		const line = out.split("\n").find((l) => l.startsWith("PROBE_JSON "));
		if (!line) throw new Error(`the probe printed no result (exit ${code}):\n${out}\n${err}`);
		return JSON.parse(line.slice("PROBE_JSON ".length)) as Round[];
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

if (process.platform !== "darwin") {
	console.log("skipped — the bug is macOS's window restoration, and so is the fix");
	process.exit(0);
}

const rounds = await run();
const problems: string[] = [];

for (const r of rounds) {
	console.log(`\n${r.name}`);
	console.log(`  on screen before the close        ${r.shown}`);
	console.log(`  isVisible() 250ms after app.hide()  ${r.duringSettle}`);
	console.log(`  back on screen after the dock icon  ${r.afterDock}`);
	if (!r.shown) problems.push(`${r.name}: the overlay was never up, so the round proves nothing`);
}

const [old, fixed] = rounds;

/*
 * The platform fact the bug rests on. If this ever stops being true the old code was not wrong for
 * the reason claimed above, and this probe is measuring something else.
 */
if (old && old.duringSettle) {
	problems.push("expected a hidden application's window to report invisible — it did not, so the guard was not what broke this");
}
if (old && !old.afterDock) {
	problems.push("expected the old guard to leave a window macOS restores — it did not reproduce");
}
if (fixed && fixed.afterDock) {
	problems.push("the overlay came back with the application: the machine is one dock click from eating every mouse press");
}

console.log("");
if (problems.length > 0) {
	for (const p of problems) console.log(`FAIL ${p}`);
	process.exit(1);
}
console.log("OK — the old guard restores the overlay, the fix does not");
