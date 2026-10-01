import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { listSessionServices, readSessionServiceOutput, stopSessionService } from "../session-services.ts";
import { isAppWindowContents } from "../window.ts";
export function registerRunningServicesIpc(): void {
	const trusted = (event: IpcMainInvokeEvent, sessionId: unknown) => {
		if (!isAppWindowContents(event.sender) || event.senderFrame !== event.sender.mainFrame || typeof sessionId !== "string") throw new Error("无效的会话服务请求");
	};
	ipcMain.handle("services:list", (event, sessionId: string) => { trusted(event, sessionId); return listSessionServices(sessionId); });
	ipcMain.handle("services:stop", (event, sessionId: string, id: string, force: boolean) => {
		trusted(event, sessionId);
		if (typeof id !== "string" || typeof force !== "boolean") throw new Error("无效的停止请求");
		return stopSessionService(sessionId, id, force);
	});
	ipcMain.handle("services:output", (event, sessionId: string, id: string, from: number) => {
		trusted(event, sessionId);
		if (typeof id !== "string" || !Number.isSafeInteger(from) || from < -1) throw new Error("Invalid services:output request");
		return readSessionServiceOutput(sessionId, id, from);
	});
}
