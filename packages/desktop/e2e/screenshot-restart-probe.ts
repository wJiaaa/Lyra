/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * Two captures back to back, and what the second one photographed.
 *
 * Starting a capture while one is already up is a supported thing to do — a second press of the
 * shortcut — and the overlay is deliberately left on screen while the new snapshot is taken, because
 * hiding it would uncover the desktop for the length of a capture and one window that is never
 * hidden between captures is the arrangement the whole of `screenshot.ts` is built on. What that
 * overlooked is that `desktopCapturer` photographs the screen *as composited*: the second snapshot
 * contained the first capture's blue selection frame, its eight round grips and its toolbar. Drag out
 * the same region again and pin it, and they were in the picture.
 *
 * It is not a thing a unit test can see, and it is not a thing a screenshot of the screen can settle
 * either — a blue frame drawn *over* a pinned picture by an overlay that outlived its capture looks
 * exactly the same as one baked into the image. So the pixels are read from two places that cannot
 * be confused:
 *
 *   - **The snapshot itself**, out of the overlay's backdrop canvas. That bitmap is what every
 *     capture is cropped from, so anything in it is in the picture by construction.
 *   - **The pinned picture**, out of the `<img>` in the pinned window, which is the delivered
 *     article — and it is written to the desktop so it can be looked at.
 *
 * The first selection is drawn *inside* the second one on purpose, sixty points in from each edge.
 * That puts its frame and grips at positions this file can compute, so what is counted is the accent
 * colour exactly where the leftover overlay would have put it — and the same count is taken on a
 * ring twenty-five points further in, where nothing was ever drawn, as the control. A desktop that
 * happens to contain blue pixels shows up in both; a photographed overlay shows up in one.
 *
 * Run: `node --experimental-strip-types e2e/screenshot-restart-probe.ts`
 */

import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startApp } from "./app.ts";

const execFileAsync = promisify(execFile);

const PORT = 9429;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target {
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

async function targets(): Promise<Target[]> {
	return (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as Target[];
}

/** One call, one socket — the same arrangement `app.ts` uses, for the same reason. */
async function call<T>(target: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
	const socket = new WebSocket(target);
	try {
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		const answer = new Promise<T>((resolve, reject) => {
			socket.addEventListener("message", (event) => {
				const message = JSON.parse(String(event.data));
				if (message.id !== 1) return;
				if (message.error) reject(new Error(`${method}: ${message.error.message}`));
				else resolve(message.result as T);
			});
			setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
		});
		socket.send(JSON.stringify({ id: 1, method, params }));
		return await answer;
	} finally {
		socket.close();
	}
}

function evaluator(socket: string) {
	return async <T>(expression: string): Promise<T> => {
		const result = (await call(socket, "Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
			userGesture: true,
		})) as { exceptionDetails?: { text: string }; result?: { value: T } };
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
		return result.result?.value as T;
	};
}

/** See the note in `screenshot-toolbar-probe.ts`: a synthesised move can go unacknowledged. */
async function mouse(socket: string, type: string, x: number, y: number, buttons = 1): Promise<unknown> {
	const send = (timeoutMs: number) =>
		call(
			socket,
			"Input.dispatchMouseEvent",
			{
				type,
				x: Math.round(x),
				y: Math.round(y),
				button: "left",
				buttons: type === "mouseReleased" ? 0 : buttons,
				clickCount: type === "mouseMoved" ? 0 : 1,
			},
			timeoutMs,
		);
	if (type !== "mouseMoved") return send(30_000);
	return send(6_000).catch(() => send(6_000).catch(() => undefined));
}

async function drag(socket: string, from: [number, number], to: [number, number], steps = 12) {
	await mouse(socket, "mousePressed", from[0], from[1]);
	for (let i = 1; i <= steps; i++) {
		await mouse(socket, "mouseMoved", from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
		await pause(25);
	}
	await mouse(socket, "mouseReleased", to[0], to[1], 0);
}

async function click(socket: string, x: number, y: number) {
	await mouse(socket, "mousePressed", x, y);
	await pause(30);
	await mouse(socket, "mouseReleased", x, y, 0);
}

async function pressTip(socket: string, run: <T>(expression: string) => Promise<T>, tip: string): Promise<boolean> {
	const at = await run<{ x: number; y: number } | null>(`(() => {
		const b = [...document.querySelectorAll("[data-ly-tip]")].find(b => b.dataset.lyTip.startsWith(${JSON.stringify(tip)}));
		if (!b) return null;
		const r = b.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
	})()`);
	if (!at) return false;
	await click(socket, at.x, at.y);
	return true;
}

/**
 * Move the *real* pointer out of the way — see `screenshot-toolbar-probe.ts` for why.
 *
 * It matters less here than there, since `desktopCapturer` does not photograph the cursor, but a
 * system pointer resting over the app under test still produces hover states that do get
 * photographed.
 */
async function parkCursor(x: number, y: number): Promise<void> {
	if (process.platform !== "darwin") return;
	await execFileAsync("python3", [
		"-c",
		[
			"import ctypes, ctypes.util",
			"lib = ctypes.cdll.LoadLibrary(ctypes.util.find_library('ApplicationServices'))",
			"class P(ctypes.Structure): _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]",
			"lib.CGWarpMouseCursorPosition.argtypes = [P]",
			`lib.CGWarpMouseCursorPosition(P(${x}.0, ${y}.0))`,
		].join("\n"),
	]).catch(() => {});
}

async function overlayPage(): Promise<string> {
	for (let i = 0; i < 40; i++) {
		await pause(250);
		const found = (await targets()).find((t) => t.type === "page" && t.url.includes("screenshot-overlay"));
		if (found?.webSocketDebuggerUrl) return found.webSocketDebuggerUrl;
	}
	throw new Error("截图浮层窗口没有出现");
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Count accent-coloured pixels where the leftover overlay would have drawn, and where it would not.
 *
 * `frame` is the first capture's selection in the overlay's own coordinates; the ring one pixel
 * outside it is where its border sat, and its eight grips are centred on the corners and the middle
 * of each edge. `inset` is the same outline pulled twenty-five points inwards — the control, over a
 * part of the desktop nothing was ever drawn on.
 *
 * The tolerance is around `#339CFF` with room for the border's own antialiasing and for the 30%
 * black dimming that lies over everything outside a selection. It is loose enough that a blue
 * desktop can trip it, which is exactly what the control is for.
 */
const COUNT_ACCENT = (frame: Rect, band: number) => `(() => {
	const canvas = document.querySelector("[data-screenshot-backdrop]");
	if (!canvas || !canvas.width) return { error: "浮层里没有背景画布，或者它还没画" };
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const scale = canvas.width / window.innerWidth;
	const frame = ${JSON.stringify(frame)};
	const band = ${band};

	const accent = (d, i) => Math.abs(d[i] - 51) <= 48 && Math.abs(d[i + 1] - 156) <= 52 && d[i + 2] >= 200;
	/* Every pixel in a box given in overlay points, counted in the snapshot's own pixels. */
	const box = (x, y, w, h) => {
		const px = Math.max(0, Math.round(x * scale));
		const py = Math.max(0, Math.round(y * scale));
		const pw = Math.min(canvas.width - px, Math.round(w * scale));
		const ph = Math.min(canvas.height - py, Math.round(h * scale));
		if (pw <= 0 || ph <= 0) return 0;
		const d = ctx.getImageData(px, py, pw, ph).data;
		let hits = 0;
		for (let i = 0; i < d.length; i += 4) if (accent(d, i)) hits++;
		return hits;
	};
	/* The four sides of a rectangle, each a strip \`band\` points thick straddling the line. */
	const outline = (r) =>
		box(r.x - band, r.y - band, r.width + band * 2, band * 2) +
		box(r.x - band, r.y + r.height - band, r.width + band * 2, band * 2) +
		box(r.x - band, r.y - band, band * 2, r.height + band * 2) +
		box(r.x + r.width - band, r.y - band, band * 2, r.height + band * 2);
	/* The eight grips: four corners and the middle of each edge. */
	const grips = [
		[frame.x, frame.y], [frame.x + frame.width / 2, frame.y], [frame.x + frame.width, frame.y],
		[frame.x, frame.y + frame.height / 2], [frame.x + frame.width, frame.y + frame.height / 2],
		[frame.x, frame.y + frame.height], [frame.x + frame.width / 2, frame.y + frame.height], [frame.x + frame.width, frame.y + frame.height],
	];
	const inset = { x: frame.x + 25, y: frame.y + 25, width: frame.width - 50, height: frame.height - 50 };
	/*
	 * How much accent there is anywhere, as a check on the check.
	 *
	 * Zero on the frame line and zero here mean two different things: the first is the fix working,
	 * the second is a canvas that has nothing in it — a stale bitmap, a failed decode, a selector
	 * that found the wrong element. The desktop under this capture is Plume's own window and its
	 * accent is this very colour, so a live snapshot always has some.
	 */
	let anywhere = 0;
	const whole = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	for (let i = 0; i < whole.length; i += 4) if (accent(whole, i)) anywhere++;
	return {
		scale,
		canvas: { w: canvas.width, h: canvas.height },
		border: outline(frame),
		grips: grips.reduce((sum, [x, y]) => sum + box(x - 7, y - 7, 14, 14), 0),
		control: outline(inset),
		anywhere,
	};
})()`;

interface AccentReading {
	error?: string;
	scale?: number;
	canvas?: { w: number; h: number };
	border?: number;
	grips?: number;
	control?: number;
	anywhere?: number;
}

/** The backdrop, cropped to the second capture's region, so it can be compared with the delivered PNG. */
const CROP_BACKDROP = (region: Rect) => `(() => {
	const src = document.querySelector("[data-screenshot-backdrop]");
	if (!src || !src.width) return "";
	const scale = src.width / window.innerWidth;
	const out = document.createElement("canvas");
	out.width = Math.round(${region.width} * scale);
	out.height = Math.round(${region.height} * scale);
	out.getContext("2d").drawImage(src, Math.round(${region.x} * scale), Math.round(${region.y} * scale), out.width, out.height, 0, 0, out.width, out.height);
	return out.toDataURL("image/png");
})()`;

// ---------------------------------------------------------------------------------------------

const problems: string[] = [];
const note = (line: string) => console.log(line);
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

const app = await startApp({
	port: PORT,
	seed: async (dir) => {
		const { writeFile } = await import("node:fs/promises");
		await mkdir(join(dir, "downloads"), { recursive: true });
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ screenshot: { downloadLocation: join(dir, "downloads"), saveLocation: "", copyToClipboard: false, openEditor: false } }, null, 2),
		);
	},
});

try {
	// The warm-up — the overlay window and one thrown-away capture — runs three seconds after launch.
	await pause(4_500);
	await parkCursor(8, 8);

	// ---- 1. 第一次截图，把选区框和手柄留在屏幕上 -------------------------
	note("\n【1】第一次截图：拉出选区，让蓝框和 8 个圆手柄留在屏幕上");
	await app.evaluate(`window.plume.screenshot.start()`);
	const socket = await overlayPage();
	const run = evaluator(socket);
	for (let i = 0; i < 60; i++) {
		if (await run<boolean>(`document.querySelector('[data-capture="active"]') !== null`)) break;
		await pause(100);
	}
	await pause(500);

	const screenSize = await run<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
	/*
	 * The inner region is the one that gets left on screen; the outer is what the second capture
	 * frames. Sixty points of margin all round, so the first capture's border and grips fall well
	 * inside the second one's picture rather than on its edge, where a crop is ambiguous.
	 */
	const inner: Rect = {
		x: Math.round(screenSize.w * 0.3),
		y: Math.round(screenSize.h * 0.3),
		width: Math.round(screenSize.w * 0.35),
		height: Math.round(screenSize.h * 0.3),
	};
	const outer: Rect = { x: inner.x - 60, y: inner.y - 60, width: inner.width + 120, height: inner.height + 120 };

	await drag(socket, [inner.x, inner.y], [inner.x + inner.width, inner.y + inner.height]);
	await pause(500);

	const drawn = await run<Rect | null>(`(() => {
		const el = document.querySelector("[data-selection]");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
	})()`);
	note(`  选区 → ${drawn ? `${drawn.width}×${drawn.height} @ (${drawn.x}, ${drawn.y})` : "没有出现"}`);
	if (!drawn) {
		problems.push("第一次截图没有拉出选区，后面的检查都无从谈起");
		throw new Error("第一次截图没有拉出选区");
	}
	const handles = await run<number>(`document.querySelectorAll("[data-selection] [class*='rounded-full']").length`);
	note(`  圆手柄 → ${handles} 个（这些就是会被拍进下一张的东西）`);
	if (handles < 8) problems.push(`选区上只有 ${handles} 个圆手柄，本该有 8 个——这一步没把该复现的东西摆上屏幕`);

	// ---- 2. 不取消，直接再截一次 -----------------------------------------
	note("\n【2】不取消，直接再触发一次截图");
	await parkCursor(8, 8);
	await app.evaluate(`window.plume.screenshot.start()`);
	/*
	 * Long enough for the new snapshot to be decoded, painted and reported. The window is up
	 * throughout — that is the case under test — so there is nothing to wait for appearing; what is
	 * waited for is the backdrop holding *this* capture's picture.
	 */
	await pause(2_000);

	const second = await run<{ capture: string; selection: string; count: number }>(`({
		capture: document.querySelector("[data-capture]") ? document.querySelector("[data-capture]").dataset.capture : "没有",
		selection: document.querySelector("[data-selection]") ? "还在" : "已清空",
		count: Number(document.querySelector("[data-capture]") ? document.querySelector("[data-capture]").dataset.windowCount : -1),
	})`);
	note(`  第二次浮层 → capture=${second.capture}，上一次的选区${second.selection}`);
	if (second.capture !== "active") problems.push(`第二次截图没有进入捕获状态：capture=${second.capture}`);
	if (second.selection === "还在") problems.push("第二次截图开始了，页面上还留着上一次的选区");

	// ---- 3. 读第二张快照本身 ---------------------------------------------
	note("\n【3】第二张快照里，上一次的框和手柄还在不在");
	const reading = await run<AccentReading>(COUNT_ACCENT(drawn, 3));
	if (reading.error) {
		problems.push(`读不到第二张快照：${reading.error}`);
	} else {
		note(`  快照 ${reading.canvas?.w}×${reading.canvas?.h}（缩放 ${reading.scale}），整张图共 ${reading.anywhere} 个 accent 像素`);
		note(`  上一次选区框那一圈的 accent 像素 → ${reading.border}`);
		note(`  上一次 8 个手柄位置的 accent 像素 → ${reading.grips}`);
		note(`  对照（同一张图，往内缩 25pt 的一圈，那里从来没画过东西）→ ${reading.control}`);
		const crop = await run<string>(CROP_BACKDROP(outer)).catch(() => "");
		if (crop.startsWith("data:image")) {
			const { writeFile } = await import("node:fs/promises");
			const out = join(homedir(), "Desktop", `plume-连拍第二张快照-${stamp}.png`);
			await writeFile(out, Buffer.from(crop.split(",")[1]!, "base64"));
			note(`  这一块快照已写到 ${out}（和下面置顶出来的那张是同一块区域）`);
		}
		/*
		 * Against the control rather than against zero.
		 *
		 * The desktop under the capture is Plume's own window, whose accent colour is this same
		 * `#339CFF` — so a handful of hits anywhere is the wallpaper, not the overlay. What the fault
		 * looks like is hundreds of them on the frame line and none twenty-five points away.
		 */
		const border = reading.border ?? 0;
		const grips = reading.grips ?? 0;
		const control = reading.control ?? 0;
		const floor = Math.max(40, control * 3);
		if ((reading.anywhere ?? 0) < 100) {
			problems.push(`背景画布上几乎没有 accent 像素（整张 ${reading.anywhere} 个）——这张图多半是空的，下面的读数说明不了什么`);
		}
		if (border > floor) problems.push(`浮层给用户看的那张里还带着上一次的选区框：框线上 ${border} 个 accent 像素，对照只有 ${control} 个`);
		if (grips > floor) problems.push(`浮层给用户看的那张里还带着上一次的 8 个圆手柄：手柄位置 ${grips} 个 accent 像素，对照只有 ${control} 个`);
		if (border <= floor && grips <= floor) note("  → 干净：框线和手柄位置都没比对照多出东西");
	}

	// ---- 4. 交付出去的那张图 ---------------------------------------------
	note("\n【4】把第二次的选区置顶到桌面，看交付出去的那张图");
	await drag(socket, [outer.x, outer.y], [outer.x + outer.width, outer.y + outer.height]);
	await pause(500);
	const framed = await run<{ w: number; h: number } | null>(`(() => {
		const el = document.querySelector("[data-selection]");
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) };
	})()`);
	note(`  第二次选区 → ${framed ? `${framed.w}×${framed.h}` : "没有出现"}（比第一次每边大 60pt，所以上一次的框整个在里面）`);
	const pinned = await pressTip(socket, run, "置顶在桌面");
	if (!pinned) problems.push("工具栏上没有「置顶在桌面」按钮");

	let pinSocket = "";
	for (let i = 0; i < 40 && !pinSocket; i++) {
		await pause(250);
		pinSocket = (await targets()).find((t) => t.type === "page" && t.url.includes("pinned-shot"))?.webSocketDebuggerUrl ?? "";
	}
	note(`  置顶窗口 → ${pinSocket ? "已出现" : "没有出现"}`);
	if (!pinSocket) {
		problems.push("按了置顶之后没有出现置顶窗口");
	} else {
		const pin = evaluator(pinSocket);
		await pause(800);
		/*
		 * The delivered image, measured in its own pixels.
		 *
		 * The first capture's frame sat sixty points in from this crop's edge, so its outline is at
		 * `60 * scale` and its grips are on that outline's corners and edge midpoints. Read off the
		 * `<img>` rather than off the canvas above, because these are two different surfaces and only
		 * one of them is what the user ends up with.
		 */
		const delivered = await pin<AccentReading & { natural?: { w: number; h: number } }>(`(async () => {
			const img = document.querySelector("img");
			if (!img) return { error: "置顶窗口里没有 img" };
			if (!img.complete) await img.decode().catch(() => {});
			const canvas = document.createElement("canvas");
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			if (!canvas.width) return { error: "置顶窗口里的图片是空的" };
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			ctx.drawImage(img, 0, 0);
			const scale = canvas.width / ${outer.width};
			const band = Math.max(2, Math.round(3 * scale));
			const accent = (d, i) => Math.abs(d[i] - 51) <= 48 && Math.abs(d[i + 1] - 156) <= 52 && d[i + 2] >= 200;
			const box = (x, y, w, h) => {
				const px = Math.max(0, Math.round(x));
				const py = Math.max(0, Math.round(y));
				const pw = Math.min(canvas.width - px, Math.round(w));
				const ph = Math.min(canvas.height - py, Math.round(h));
				if (pw <= 0 || ph <= 0) return 0;
				const d = ctx.getImageData(px, py, pw, ph).data;
				let hits = 0;
				for (let i = 0; i < d.length; i += 4) if (accent(d, i)) hits++;
				return hits;
			};
			const outline = (r) =>
				box(r.x - band, r.y - band, r.width + band * 2, band * 2) +
				box(r.x - band, r.y + r.height - band, r.width + band * 2, band * 2) +
				box(r.x - band, r.y - band, band * 2, r.height + band * 2) +
				box(r.x + r.width - band, r.y - band, band * 2, r.height + band * 2);
			/* Where the first capture's selection lands inside this crop: 60pt in from every edge. */
			const frame = { x: 60 * scale, y: 60 * scale, width: canvas.width - 120 * scale, height: canvas.height - 120 * scale };
			const grips = [
				[frame.x, frame.y], [frame.x + frame.width / 2, frame.y], [frame.x + frame.width, frame.y],
				[frame.x, frame.y + frame.height / 2], [frame.x + frame.width, frame.y + frame.height / 2],
				[frame.x, frame.y + frame.height], [frame.x + frame.width / 2, frame.y + frame.height], [frame.x + frame.width, frame.y + frame.height],
			];
			const inset = { x: frame.x + 25 * scale, y: frame.y + 25 * scale, width: frame.width - 50 * scale, height: frame.height - 50 * scale };
			return {
				scale,
				natural: { w: canvas.width, h: canvas.height },
				border: outline(frame),
				grips: grips.reduce((sum, [x, y]) => sum + box(x - 7 * scale, y - 7 * scale, 14 * scale, 14 * scale), 0),
				control: outline(inset),
			};
		})()`);

		if (delivered.error) {
			problems.push(`读不到置顶出来的图：${delivered.error}`);
		} else {
			note(`  置顶图 ${delivered.natural?.w}×${delivered.natural?.h}（缩放 ${delivered.scale}）`);
			note(`  上一次选区框那一圈 → ${delivered.border} 个 accent 像素`);
			note(`  上一次 8 个手柄位置 → ${delivered.grips} 个 accent 像素`);
			note(`  对照（往内缩 25pt 的一圈）→ ${delivered.control} 个`);
			const border = delivered.border ?? 0;
			const grips = delivered.grips ?? 0;
			const control = delivered.control ?? 0;
			const floor = Math.max(40, control * 3);
			if (border > floor) problems.push(`置顶出来的图上带着上一次截图的蓝框：框线 ${border} 个 accent 像素，对照 ${control} 个`);
			if (grips > floor) problems.push(`置顶出来的图上带着上一次截图的圆手柄：手柄位置 ${grips} 个 accent 像素，对照 ${control} 个`);
			if (border <= floor && grips <= floor) note("  → 干净：交付出去的图里没有上一次浮层的痕迹");
		}

		/*
		 * And the picture on disk, so a person can look at it.
		 *
		 * The counts above say whether the accent colour is where the leftover overlay would have put
		 * it; this is the thing itself, for the case where the numbers and the eye disagree.
		 */
		const dataUrl = await pin<string>(`document.querySelector("img") ? document.querySelector("img").src : ""`);
		if (dataUrl.startsWith("data:image")) {
			const { writeFile } = await import("node:fs/promises");
			const out = join(homedir(), "Desktop", `plume-连拍第二张-${stamp}.png`);
			await writeFile(out, Buffer.from(dataUrl.split(",")[1]!, "base64"));
			note(`  第二张的原图已写到 ${out}`);
		}

		await app.evaluate(`window.plume.screenshot.cancel()`).catch(() => {});
		await pause(600);
	}

	// ---- 5. 主进程自己怎么说的 -------------------------------------------
	note("\n【5】捕获日志");
	const log = await readFile(join(app.home, "screenshot-debug.log"), "utf8").catch(() => "");
	/*
	 * Split per capture, because the question is about the second one specifically.
	 *
	 * `beginCaptureLog` writes a `===== capture #N =====` banner and resets the sequence number, so
	 * the last section is this probe's second capture and nothing else.
	 */
	const captures = log.split(/^={5} capture /m).slice(1);
	const secondCapture = captures.at(-1) ?? "";
	note(`  日志里一共 ${captures.length} 次捕获`);
	for (const line of secondCapture.split("\n").filter((l) => /cleared|already on screen|painted/.test(l))) {
		note(`  ${line.trim()}`);
	}
	if (!secondCapture.includes("overlay cleared out of the picture")) {
		problems.push("捕获日志里没有 `overlay cleared out of the picture`——第二次截图没有走清空快照的那条路");
	}
	if (!secondCapture.includes("reveal: painted")) {
		problems.push("第二次截图没有等到渲染进程报告画好——窗口是被 250ms 的兜底计时器变回不透明的，不是被这一帧");
	}
	/*
	 * And whether the page ever redrew its backdrop for this capture.
	 *
	 * Separate from everything above, and it is what the baseline run of this probe turned up: the
	 * second capture's picture never reached the canvas, so the overlay went on showing the *first*
	 * capture's frozen desktop while cropping out of the second one's. Read from the log rather than
	 * from the pixels because two captures of a still screen are identical everywhere it matters —
	 * the only place they differed was the leftover overlay, which is the thing being removed here.
	 */
	if (!secondCapture.includes("renderer: backdrop painted")) {
		problems.push(
			"第二次截图没有重画背景画布——浮层上给用户看的还是上一次那张冻结的桌面，" +
				"而裁出来的是这一次的快照。两次之间屏幕变过，框选就会框错地方",
		);
	}
} finally {
	await app.stop();
}

console.log("\n────────────────────────────────");
if (problems.length === 0) {
	console.log("✅ 全部通过");
} else {
	console.log(`❌ ${problems.length} 个问题：`);
	for (const line of problems) console.log(`   • ${line}`);
}
process.exit(problems.length === 0 ? 0 : 1);
