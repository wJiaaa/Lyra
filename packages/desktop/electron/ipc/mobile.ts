import { ipcMain } from "electron";
import { mobileAccessStatus, rotateMobileToken, setMobileRelay, startMobileAccess, stopMobileAccess } from "../mobile-access.ts";

export function registerMobileIpc(): void {
	ipcMain.handle("mobile:status", () => mobileAccessStatus());
	ipcMain.handle("mobile:start", (_event, port: number) => startMobileAccess(port));
	ipcMain.handle("mobile:stop", () => stopMobileAccess());
	ipcMain.handle("mobile:rotateToken", () => rotateMobileToken());
	ipcMain.handle("mobile:setRelay", (_event, url: string) => setMobileRelay(typeof url === "string" ? url : ""));
}
