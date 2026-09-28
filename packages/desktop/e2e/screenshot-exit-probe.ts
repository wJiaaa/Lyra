/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * The two ways out of a capture, which are not the same way.
 *
 * Finishing produces an image that is going somewhere — the clipboard, and the composer — so Plume
 * comes forward to receive it. Cancelling produces nothing: Escape means "never mind", and
 * answering that by throwing the whole application in front of whatever the user was reading is
 * the opposite of never mind. Both were reported broken from the installed app, and neither is
 * visible to a test that only checks the overlay's own DOM.
 *
 * Run against the built bundle:
 *   PLUME_E2E_APP=/Applications/Plume.app node --experimental-strip-types e2e/screenshot-exit-probe.ts
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);
const PORT = 9414;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The main process's account of what it did, read out before the run's directory is deleted. */
let timeline = "";

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

/**
 * Whether a capture is still up, asked of the overlay page rather than of the debugger.
 *
 * The overlay window is not destroyed between captures any more — it is built once and shown and
 * hidden, because building one per capture cost 147ms and PNG-encoding the screen for it cost
 * another 133ms, and the picture a capture shows is taken *before* that wait. So its debugger
 * target is listed whether a capture is running or not, and "is the target gone?" reported every
 * capture as still open no matter what the app did.
 */
async function captureOver(socket: string): Promise<boolean> {
	const result = (await send(socket, "Runtime.evaluate", {
		expression: `document.querySelector('[data-capture="active"]') === null`,
		returnByValue: true,
	}).catch(() => null)) as { result?: { value?: boolean } } | null;
	return result?.result?.value !== false;
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

/** What macOS says is on the clipboard right now. */
async function clipboardKinds(): Promise<string> {
	const { stdout } = await execFileAsync("osascript", ["-e", "clipboard info"]);
	return stdout.trim();
}

async function frontmost(): Promise<string | null> {
	try {
		const { stdout: asn } = await execFileAsync("lsappinfo", ["front"]);
		const { stdout } = await execFileAsync("lsappinfo", ["info", "-only", "name", asn.trim()]);
		return /"LSDisplayName"="(.*)"/.exec(stdout.trim())?.[1] ?? null;
	} catch {
		return null;
	}
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
	// ---- 1. Escape closes it, and takes nothing to the front ------------------
	/*
	 * Started from somewhere else, which is the case the complaint is about.
	 *
	 * Triggered from inside Plume the foreground is already Plume, so "did cancelling steal it" has
	 * no answer — everything looks correct whatever the code does. The global shortcut fires while
	 * you are reading something else, and *that* is where pressing Escape must leave you where you
	 * were. `app.evaluate` drives the window over the debugger without activating the application,
	 * so this stays true while the capture is set up.
	 */
	await execFileAsync("osascript", ["-e", 'tell application "Finder" to activate']);
	await pause(1200);
	const before = await frontmost();
	note(`• 从「${before ?? "?"}」里发起截图`);

	await app.evaluate(`window.plume.screenshot.start()`);
	const first = await overlayTarget();
	if (!first?.webSocketDebuggerUrl) throw new Error("截图浮层没有出现");
	await pause(900);

	await send(first.webSocketDebuggerUrl, "Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
		nativeVirtualKeyCode: 27,
	});
	await pause(1200);

	const goneAfterEscape = await captureOver(first.webSocketDebuggerUrl);
	note(`• 按 Esc → 浮层${goneAfterEscape ? "已关闭" : "还开着"}`);
	if (!goneAfterEscape) problems.push("按 Esc 之后浮层没有关闭");

	const afterEscape = await frontmost();
	note(`  取消之后的前台应用 → ${afterEscape ?? "(读不到)"}（发起前是「${before ?? "?"}」）`);
	if (afterEscape === "Plume" && before !== "Plume") {
		problems.push(`按 Esc 取消之后 Plume 抢到了最前，而发起截图时前台是「${before}」——取消什么都没产出，不该动前台`);
	}

	// ---- 2. Finishing puts the picture on the clipboard -----------------------
	await execFileAsync("osascript", ["-e", 'set the clipboard to "plume-probe-placeholder"']);
	note(`• 清空后的剪贴板 → ${await clipboardKinds()}`);

	await app.evaluate(`window.plume.screenshot.start()`);
	const second = await overlayTarget();
	if (!second?.webSocketDebuggerUrl) throw new Error("第二次截图浮层没有出现");
	const socket = second.webSocketDebuggerUrl;
	await pause(900);

	const drag = async (from: [number, number], to: [number, number]) => {
		await send(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x: from[0], y: from[1], button: "left", buttons: 1, clickCount: 1 });
		for (let i = 1; i <= 6; i++) {
			await send(socket, "Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: from[0] + ((to[0] - from[0]) * i) / 6,
				y: from[1] + ((to[1] - from[1]) * i) / 6,
				button: "left",
				buttons: 1,
			});
		}
		await send(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to[0], y: to[1], button: "left", buttons: 0, clickCount: 1 });
	};
	await drag([320, 240], [820, 560]);
	await pause(400);

	// Press 完成 where it actually is, with a real pointer.
	const at = (await send(socket, "Runtime.evaluate", {
		expression: `(() => {
			const b = [...document.querySelectorAll("button[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith("完成"));
			if (!b) return null;
			const r = b.getBoundingClientRect();
			return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
		})()`,
		returnByValue: true,
	})) as { result?: { value: { x: number; y: number } | null } };
	const button = at.result?.value;
	if (!button) {
		problems.push("工具条上找不到「完成」按钮");
	} else {
		await send(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", buttons: 1, clickCount: 1 });
		await send(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", buttons: 0, clickCount: 1 });
	}
	await pause(1500);

	const goneAfterFinish = await captureOver(socket);
	note(`• 点完成 → 浮层${goneAfterFinish ? "已关闭" : "还开着"}`);
	if (!goneAfterFinish) problems.push("点了完成之后浮层没有关闭——还停在截图状态");

	const kinds = await clipboardKinds();
	note(`  完成之后的剪贴板 → ${kinds}`);
	if (!/TIFF|PNG|«class PNGf»|picture/i.test(kinds)) {
		problems.push(`完成之后剪贴板里没有图片，只有：${kinds}`);
	}
} finally {
	// Before `stop`, which deletes the directory it lives in.
	timeline = await readFile(join(home, "screenshot-debug.log"), "utf8").catch(() => "");
	await app.stop();
}

/*
 * The main window has to get out of the way for the duration of a capture.
 *
 * Activating the overlay activates Plume, and macOS raises *every* window of an application it
 * activates — so the main window ends up above whatever was being screenshotted, invisible under
 * the frozen picture, and revealed the moment that picture goes. A recording caught it: a colour
 * pick ended with the Plume window in front of the page the colour came from.
 *
 * Only for captures that did not start from Plume, which is what this probe drives.
 */
if (timeline) {
	if (!timeline.includes("reveal: main window stepped aside")) {
		problems.push("从别的应用截图时主窗口没有让开——截图结束时它会挡在被截的窗口前面");
	}
} else {
	problems.push("没有读到主进程时序日志，主窗口是否让开无法验证");
}

console.log("");
if (problems.length === 0) {
	console.log("✅ 全部通过");
} else {
	console.log(`❌ ${problems.length} 个问题：`);
	for (const p of problems) console.log(`   - ${p}`);
	process.exitCode = 1;
}
