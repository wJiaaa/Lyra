/**
 * Web access, as the settings page drives it. The work is in `web-access.ts`; these are its handles.
 */

import { ipcMain } from "electron";
import { rotateWebAccessToken, startWebAccess, stopWebAccess, webAccessStatus } from "../web-access.ts";

export function registerWebIpc(): void {
	ipcMain.handle("web:status", () => webAccessStatus());
	ipcMain.handle("web:start", () => startWebAccess());
	ipcMain.handle("web:stop", () => stopWebAccess());
	ipcMain.handle("web:rotateToken", () => rotateWebAccessToken());
}
