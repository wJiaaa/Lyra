/** Electron IPC bindings for the shared side-chat service. */

import { ipcMain } from "electron";
import { sideChatClose, sideChatList, sideChatOpen, tasksCancel, tasksDismiss, tasksList, tasksResume } from "../side-chat-service.ts";

export function registerSideChatIpc(): void {
	ipcMain.handle("sidechat:list", (_event, sessionId: string) => sideChatList(sessionId));
	ipcMain.handle("sidechat:open", (_event, sessionId: string, sideId: string) => sideChatOpen(sessionId, sideId));
	ipcMain.handle("sidechat:close", (_event, sessionId: string, sideId: string) => sideChatClose(sessionId, sideId));
	ipcMain.handle("tasks:list", (_event, sessionId: string) => tasksList(sessionId));
	ipcMain.handle("tasks:cancel", (_event, sessionId: string, taskId: string) => tasksCancel(sessionId, taskId));
	ipcMain.handle("tasks:dismiss", (_event, sessionId: string, taskId: string) => tasksDismiss(sessionId, taskId));
	ipcMain.handle("tasks:resume", (_event, sessionId: string, taskId: string) => tasksResume(sessionId, taskId));
}
