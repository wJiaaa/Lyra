/**
 * Pictures left on the desktop, above everything, until they are dismissed.
 *
 * A capture is usually taken to be looked at while doing something else — a design to copy from, a
 * number to type into another window, an error message to read while editing the file that caused
 * it. Every one of those is worse through the clipboard: paste it somewhere to see it, and now the
 * thing you wanted beside your work is on top of it in a document you did not want.
 *
 * So the region becomes a small window of its own: frameless, transparent, always on top, showing
 * nothing but the picture. It is dragged by the picture itself and closed by the button that
 * appears when the pointer is over it. That is the whole of it — no menu, no chrome, no state.
 *
 * Separate from `screenshot.ts` because the lifetimes have nothing in common. The capture overlay
 * is one window built once and shown for a few seconds at a time; these are many windows, each
 * built when a capture ends and destroyed when its own button is pressed, and each one outlives
 * every capture that follows it.
 */

import { join } from "node:path";
import { BrowserWindow, nativeImage, screen } from "electron";

/**
 * Every pinned picture currently on screen.
 *
 * Kept so quitting can let go of them: they are `alwaysOnTop` windows that nothing else counts, so
 * a process holding one would neither quit nor show anything the user could close.
 */
const pinned = new Set<BrowserWindow>();

/**
 * Each pinned window's picture, until its page asks for it.
 *
 * Keyed on `webContents.id`, so a page identifies itself by sending the message and cannot ask for
 * another window's picture. Kept after it has been read: a page that reloads — which nothing does
 * on purpose, but a crashed renderer does — has to be able to ask again, and the alternative is a
 * window that comes back empty. Dropped when the window closes, along with everything else.
 */
const waiting = new Map<number, PinnedImage>();

interface PinnedImage {
	dataUrl: string;
	width: number;
	height: number;
}

/** Whether this is a pinned picture rather than a window the app is otherwise responsible for. */
export function isPinnedShot(win: BrowserWindow): boolean {
	return pinned.has(win);
}

/** Let go of every pinned picture — the app is quitting. */
export function destroyPinnedShots(): void {
	// Emptied before anything is destroyed: each `destroy` fires the window's own `closed` handler,
	// which reaches back into this set.
	const all = [...pinned];
	pinned.clear();
	dragOrigins.clear();
	for (const win of all) {
		if (!win.isDestroyed()) win.destroy();
	}
}

export interface PinRequest {
	/** The picture, as a PNG data URL. */
	dataUrl: string;
	/**
	 * Where the region was on screen, in the display's own coordinates.
	 *
	 * The window opens exactly there, which is what makes it read as the capture staying behind
	 * rather than a new thing appearing: the frozen picture is replaced, pixel for pixel, by a real
	 * window showing the same thing. Omitted, it is centred on the display holding the pointer.
	 */
	at?: { x: number; y: number; width: number; height: number };
}

/**
 * Put a picture on screen and keep it there.
 *
 * The size is the image's own, in logical points — a Retina capture is twice as many pixels as the
 * region it came from, and a window sized in those would be twice the size of the thing it is
 * standing in for. `nativeImage` is asked rather than the renderer because the window has to exist
 * at the right size before it loads anything: a window that resizes after its first frame is a
 * visible jump, and this one appears directly over the region it replaces.
 */
export function pinScreenshot(request: PinRequest): { ok: boolean } {
	const image = nativeImage.createFromDataURL(request.dataUrl);
	if (image.isEmpty()) return { ok: false };

	const display = request.at
		? screen.getDisplayNearestPoint({ x: Math.round(request.at.x), y: Math.round(request.at.y) })
		: screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	const scale = display.scaleFactor || 1;
	const size = image.getSize();
	/*
	 * The picture's size in points, and the region's when there is one.
	 *
	 * They agree in the ordinary case, and the region wins where they do not: a selection dragged
	 * past the edge of the screen is clamped before it is cut out, so the bitmap can be a pixel or
	 * two short of what was framed. Standing the window on the frame keeps it under the pointer that
	 * just released it.
	 */
	const width = Math.max(1, Math.round(request.at?.width ?? size.width / scale));
	const height = Math.max(1, Math.round(request.at?.height ?? size.height / scale));

	/*
	 * Exactly the picture's size, with the close button drawn inside it.
	 *
	 * A margin around the image for the button to sit in would be transparent and still solid to the
	 * mouse: Electron hit-tests a transparent window by its frame, not by what it painted, so a
	 * fourteen-point border of nothing would swallow every click aimed at whatever is behind it.
	 * That is the same fault the capture overlay spent a release on, and there is no reason to
	 * reintroduce it here for a button that can perfectly well overlap the corner of the picture.
	 */
	const win = new BrowserWindow({
		x: request.at ? Math.round(request.at.x) : undefined,
		y: request.at ? Math.round(request.at.y) : undefined,
		width,
		height,
		frame: false,
		transparent: true,
		/*
		 * Shown once the picture is in it — see `pin:ready`.
		 *
		 * A transparent window that is up before its contents have painted is a rectangle of desktop
		 * with a shadow round it, for as long as loading a page takes. These are created at the
		 * moment a capture ends, which is already the busiest frame in the whole feature.
		 */
		show: false,
		alwaysOnTop: true,
		resizable: false,
		/*
		 * Not movable, minimizable or resizable by the system: the page owns all of it.
		 *
		 * Dragging is implemented in `PinnedShot` — it has to be, because a drag region would take
		 * the pointer away from the page and with it the hover that reveals the close button — so
		 * system-managed movement would be a second, invisible way to move the same window. There is
		 * nothing to minimise it back to either: it has no dock tile of its own and no window menu.
		 */
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: process.platform !== "darwin",
		/*
		 * The system's own shadow, which is what separates the picture from whatever it is lying on.
		 *
		 * It costs nothing here — a shadow is drawn outside the window and is not part of its hit
		 * area — and without it a screenshot of a white document pinned over a white document is
		 * invisible as a distinct thing. The capture overlay turns this off for the opposite reason:
		 * it is the whole screen, so its shadow would have nowhere to fall but off the edge.
		 */
		hasShadow: true,
		acceptFirstMouse: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			/*
			 * Never throttled, because this window's whole job happens while Plume is in the background.
			 *
			 * Chromium slows a renderer it believes nobody is looking at — timers drop to a crawl,
			 * animation frames stop. For an ordinary window that is right. For a picture pinned over
			 * somebody else's application it is the opposite of what is wanted: the pointer arriving
			 * over it has to reveal the close button, and the drag that follows has to keep up with
			 * the hand.
			 *
			 * Verified rather than assumed: `screenshot-toolbar-probe.ts` warps the *real* pointer onto
			 * a pinned shot while Finder is frontmost, and the close button appears.
			 */
			backgroundThrottling: false,
		},
	});

	/*
	 * Above ordinary windows, and deliberately not above everything.
	 *
	 * `floating` is the level for a utility window that belongs to the desktop; `screen-saver` — what
	 * the capture overlay uses — sits above the menu bar and above other applications' fullscreen
	 * spaces, which is right for a few seconds of capture and wrong for a picture that stays. A note
	 * pinned to the desktop should not cover a fullscreen video.
	 *
	 * The level argument is read on macOS and ignored elsewhere, where `alwaysOnTop` is one thing a
	 * window either is or is not — which is the behaviour wanted on all three.
	 */
	win.setAlwaysOnTop(true, "floating");
	/*
	 * Present on every desktop, so it stays put when the user switches to another one.
	 *
	 * macOS and Linux only — Electron does not implement it on Windows, where there are no workspaces
	 * to be visible on and a window is simply on the desktop. Guarded rather than left to no-op
	 * because both option names below are macOS's, and calling a method with an options bag the
	 * platform has never heard of is the kind of thing that starts throwing after an upgrade.
	 *
	 * `visibleOnFullScreen: false` is the counterpart of the level above: a picture pinned to the
	 * desktop should not follow the user into somebody else's fullscreen app.
	 * `skipTransformProcessType` keeps this from switching the whole process to a UIElement — which
	 * is what took the dock icon away for the capture overlay, permanently, and took an experiment
	 * against LaunchServices to find.
	 */
	if (process.platform !== "win32") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });
	}

	const pageId = win.webContents.id;
	win.on("closed", () => {
		pinned.delete(win);
		dragOrigins.delete(pageId);
		waiting.delete(pageId);
	});
	pinned.add(win);

	const devServer = process.env.ELECTRON_RENDERER_URL;
	const load = devServer
		? win.loadURL(`${devServer}#/pinned-shot`)
		: win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash: "/pinned-shot" });

	/*
	 * The picture waits here to be asked for, rather than being pushed at the page.
	 *
	 * Pushing it on `did-finish-load` looks right and loses the race. `did-finish-load` means the
	 * *document* has loaded; the component that listens for the image is behind a dynamic import,
	 * so its `ipcRenderer.on` is registered a chunk-load later — and an IPC message sent in between
	 * has no listener and is dropped without a trace. The window then sat there, correctly sized,
	 * correctly positioned, and empty. Nothing about that is visible from the main process, which is
	 * why it survived until a probe read `data-pinned` out of the page.
	 *
	 * Asking cannot race: whenever the page gets round to it, the answer is here.
	 */
	waiting.set(pageId, { dataUrl: request.dataUrl, width, height });
	/*
	 * A window whose page never asks is destroyed, not shown.
	 *
	 * The alternative — showing it anyway — puts a transparent, always-on-top window on the desktop
	 * with nothing in it: invisible, and solid to the mouse, because Electron hit-tests a window by
	 * its frame rather than by what it painted. That is the same failure the capture overlay spent a
	 * release on, and there it was at least dismissible with Escape. Here there would be nothing to
	 * aim at at all.
	 */
	setTimeout(() => {
		if (win.isDestroyed() || win.isVisible()) return;
		console.error("[screenshot] 置顶窗口三秒内没有画出图片，已关掉它");
		closePinnedShot(pageId);
	}, 3_000);

	load.catch((err: unknown) => {
		console.error("[screenshot] 无法打开置顶图片窗口:", err);
		pinned.delete(win);
		if (!win.isDestroyed()) win.destroy();
	});

	return { ok: true };
}

/** The picture this page is for, asked for by the page itself. Null for anything that is not one. */
export function pinnedImageFor(webContentsId: number): PinnedImage | null {
	return waiting.get(webContentsId) ?? null;
}

/**
 * The picture has painted: let its window be seen.
 *
 * Identified by the page that sent the message rather than by an id it chose, so one pinned window
 * cannot ask anything about another.
 */
export function revealPinnedShot(webContentsId: number): void {
	const win = shotFor(webContentsId);
	if (!win) return;
	// `showInactive`, because pinning happens as a capture ends: taking the foreground here would
	// pull it away from whatever the user turned back to.
	win.showInactive();
}

/** Close one pinned picture, identified by the page that asked. */
export function closePinnedShot(webContentsId: number): void {
	const win = shotFor(webContentsId);
	if (!win) return;
	pinned.delete(win);
	dragOrigins.delete(webContentsId);
	win.destroy();
}

/** How many pictures are pinned right now. Read by the probes; nothing in the app depends on it. */
export function pinnedShotCount(): number {
	return [...pinned].filter((win) => !win.isDestroyed()).length;
}

/**
 * Where each window was when its drag began.
 *
 * The page sends a delta rather than a position, and this is what the delta is measured from. Kept
 * per window because more than one picture can be on screen, and cleared by the window's own
 * `closed` handler along with everything else about it.
 */
const dragOrigins = new Map<number, { x: number; y: number }>();

/** A drag is starting on this picture: remember where it is. */
export function beginPinnedDrag(webContentsId: number): void {
	const win = shotFor(webContentsId);
	if (!win) return;
	const [x, y] = win.getPosition();
	dragOrigins.set(webContentsId, { x, y });
}

/**
 * Move a picture to its origin plus the pointer's travel.
 *
 * Against the *origin*, never against where the window is now. Adding each delta to the current
 * position compounds every rounding error and, worse, races the moves already in flight — the
 * window slides away from the pointer, faster the further it is dragged.
 */
export function dragPinnedShot(webContentsId: number, dx: number, dy: number): void {
	const origin = dragOrigins.get(webContentsId);
	const win = shotFor(webContentsId);
	if (!origin || !win) return;
	win.setPosition(Math.round(origin.x + dx), Math.round(origin.y + dy));
}

function shotFor(webContentsId: number): BrowserWindow | null {
	return [...pinned].find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === webContentsId) ?? null;
}
