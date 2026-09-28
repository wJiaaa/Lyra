/**
 * IPC handlers for screenshot capabilities.
 */

import { app, dialog, ipcMain } from "electron";
import type { ScreenshotSettings, Settings } from "@plume/core";
import { captureLog } from "../screenshot-debug.ts";
import {
	closeScreenshotOverlay,
	downloadScreenshot,
	finishScreenshot,
	overlayPainted,
	overlayPassedThrough,
	revealScreenshotOverlay,
	startScreenshotSession,
} from "../screenshot.ts";
import { beginPinnedDrag, closePinnedShot, dragPinnedShot, pinScreenshot, pinnedImageFor, pinnedShotCount, revealPinnedShot } from "../screenshot-pin.ts";
import { nativeTranslator } from "../i18n.ts";

export interface ScreenshotIpcDeps {
	settings: () => Settings;
	saveSettings: (next: Settings) => Promise<void>;
}

export function registerScreenshotIpc(deps: ScreenshotIpcDeps): void {
	// Callers surface the failure; resolving here would report a disabled or failed capture as started.
	ipcMain.handle("screenshot:start", async (_event, customSettings?: ScreenshotSettings): Promise<void> => {
		const current = customSettings ?? deps.settings().screenshot;
		try {
			await startScreenshotSession(current);
		} catch (err) {
			console.error("[screenshot] 无法开始截图:", err);
			throw err;
		}
	});

	ipcMain.handle("screenshot:finish", async (_event, dataUrl: string, customSettings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string }> => {
		const current = customSettings ?? deps.settings().screenshot;
		return finishScreenshot(dataUrl, current);
	});

	/*
	 * Cancelling produces nothing, so it moves nothing.
	 *
	 * `foreground: false` is the difference between this and finishing. A capture that produced an
	 * image has somewhere to send it and Plume comes forward to receive it; pressing Escape means
	 * "never mind", and answering that by throwing the application in front of whatever the user
	 * was reading is the opposite of never mind.
	 */
	ipcMain.handle("screenshot:cancel", async (): Promise<void> => {
		closeScreenshotOverlay({ foreground: false });
	});

	/*
	 * The overlay reporting that its snapshot is drawn.
	 *
	 * `on`, not `handle`: the renderer is telling, not asking, and it must not be made to wait for
	 * the window to be shown before it can carry on drawing. The sender identifies which overlay.
	 */
	/*
	 * What the overlay measures about itself, into the same log as the main process's own steps.
	 *
	 * The question these answer is whether the frozen picture is the same shape as the screen it is
	 * covering. If it is not, it is stretched to fill — and everything in it shifts, which from the
	 * outside looks like the whole desktop scaling for an instant.
	 */
	ipcMain.on("screenshot:debug", (_event, what: string, detail: Record<string, unknown>) => {
		captureLog(`renderer: ${what}`, detail);
	});

	/*
	 * The capture is over on screen, and the confirmation is not.
	 *
	 * `on`, not `handle`, and not a close. The window is still up for another moment holding nothing
	 * but 「已复制色值」 or 「已保存到…」 over the real desktop, and this is what stops it behaving
	 * like a capture while it does — presses go through to whatever is underneath. The renderer sends
	 * `screenshot:cancel` on its own clock once the message has faded.
	 */
	ipcMain.on("screenshot:passThrough", () => {
		overlayPassedThrough();
	});

	/*
	 * The overlay has produced a frame.
	 *
	 * Distinct from `ready`, and the distinction is the point: `ready` means the snapshot is in the
	 * canvas's bitmap, which is CPU-side and says nothing about whether the window has a composited
	 * surface to show it with. This is sent from inside an animation frame, so a frame provably
	 * exists — and only then is the window made opaque. See `reveal` in `screenshot.ts`.
	 */
	ipcMain.on("screenshot:painted", () => {
		overlayPainted();
	});

	ipcMain.on("screenshot:ready", (event) => {
		if (event.sender && !event.sender.isDestroyed()) {
			revealScreenshotOverlay(event.sender.id);
		}
	});

	ipcMain.handle("screenshot:pickDirectory", async (): Promise<string | null> => {
		const current = deps.settings();
		const res = await dialog.showOpenDialog({
			title: nativeTranslator(current.uiLocale, app.getLocale())("dialog.screenshotDirectory"),
			properties: ["openDirectory", "createDirectory"],
		});
		if (res.canceled || res.filePaths.length === 0) return null;
		return res.filePaths[0];
	});

	/*
	 * 下载：the file goes somewhere the user can find, and the capture ends.
	 *
	 * Distinct from `finish`, which is the capture being *delivered* — to the clipboard, to the
	 * composer, and only incidentally to disk if a save location happens to be configured. This is
	 * the button that says the file is the point, so an unconfigured destination means the desktop
	 * rather than nothing at all: a download that silently goes nowhere is the worst of both.
	 */
	ipcMain.handle("screenshot:download", async (_event, dataUrl: string, customSettings?: ScreenshotSettings): Promise<{ ok: boolean; filePath?: string; error?: string }> => {
		const current = customSettings ?? deps.settings().screenshot;
		return downloadScreenshot(dataUrl, current);
	});

	/*
	 * 置顶在桌面: the region stays on screen as a window of its own.
	 *
	 * The overlay is closed first and by the same call, because the two are one movement to the eye
	 * — the frozen picture is replaced, in place, by a real window showing the same pixels.
	 *
	 * `stepAside: false` is what keeps it there. Ending a capture that came from the shortcut
	 * ordinarily hides the whole application to hand the foreground back, and `app.hide()` does not
	 * distinguish between the overlay and a window created two lines later: the pinned picture
	 * would appear and be hidden again in the same frame, with nothing left on screen to reach it.
	 */
	ipcMain.handle("screenshot:pin", async (_event, dataUrl: string, at?: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean }> => {
		closeScreenshotOverlay({ foreground: false, stepAside: false });
		return pinScreenshot({ dataUrl, at });
	});

	/*
	 * A pinned window asking for its own picture.
	 *
	 * Pulled rather than pushed, because pushing it loses a race that leaves the window empty: the
	 * page's component is behind a dynamic import, so it registers its listener a chunk-load after
	 * `did-finish-load` — and a message sent in that gap is dropped with no error anywhere.
	 */
	ipcMain.handle("pin:request", async (event) => {
		if (!event.sender || event.sender.isDestroyed()) return null;
		return pinnedImageFor(event.sender.id);
	});

	/** A pinned picture has painted and may be shown. `on`, because the page is telling, not asking. */
	ipcMain.on("pin:ready", (event) => {
		if (event.sender && !event.sender.isDestroyed()) revealPinnedShot(event.sender.id);
	});

	/** Its own close button. The sender identifies which picture, so the page sends nothing else. */
	ipcMain.on("pin:close", (event) => {
		if (event.sender && !event.sender.isDestroyed()) closePinnedShot(event.sender.id);
	});

	/*
	 * Dragging a pinned picture around, done here rather than with a drag region.
	 *
	 * `-webkit-app-region: drag` would be less code and would cost the close button: a drag region is
	 * handled by the window server, so the page inside it is never told about the pointer — no
	 * `pointermove`, no `:hover`, and nothing to reveal the button with.
	 */
	ipcMain.on("pin:dragStart", (event) => {
		if (event.sender && !event.sender.isDestroyed()) beginPinnedDrag(event.sender.id);
	});
	ipcMain.on("pin:dragMove", (event, dx: number, dy: number) => {
		if (event.sender && !event.sender.isDestroyed()) dragPinnedShot(event.sender.id, dx, dy);
	});

	/** How many are on screen. Nothing in the app reads this; the e2e probes do. */
	ipcMain.handle("screenshot:pinnedCount", async (): Promise<number> => pinnedShotCount());
}
