/** Electron IPC bindings for the shared side-chat service. */

import { ipcMain } from "electron";
import type { SideAskOptions, UserContent } from "@plume/core";
import {
	sideChatAbort,
	sideChatAsk,
	sideChatClose,
	sideChatEditAndResend,
	sideChatReset,
	sideChatState,
	sideChatSetModel,
	tasksCancel,
	tasksDismiss,
	tasksList,
	tasksResume,
} from "../side-chat-service.ts";

export function registerSideChatIpc(): void {
	ipcMain.handle("sidechat:setModel", (_event, sessionId: string, sideId: string, modelId: string | null) => sideChatSetModel(sessionId, sideId, modelId));
	ipcMain.handle("sidechat:state", (_event, sessionId: string, sideId: string) => sideChatState(sessionId, sideId));
	ipcMain.handle("sidechat:ask", (_event, sessionId: string, sideId: string, content: UserContent[], options?: SideAskOptions) => sideChatAsk(sessionId, sideId, content, options));
	ipcMain.handle("sidechat:editAndResend", (_event, sessionId: string, sideId: string, index: number, content: UserContent[], options?: SideAskOptions) =>
		sideChatEditAndResend(sessionId, sideId, index, content, options));
	ipcMain.handle("sidechat:abort", (_event, sessionId: string, sideId: string) => sideChatAbort(sessionId, sideId));
	ipcMain.handle("sidechat:reset", (_event, sessionId: string, sideId: string) => sideChatReset(sessionId, sideId));
	ipcMain.handle("sidechat:close", (_event, sessionId: string, sideId: string) => sideChatClose(sessionId, sideId));
	ipcMain.handle("tasks:list", (_event, sessionId: string) => tasksList(sessionId));
	ipcMain.handle("tasks:cancel", (_event, sessionId: string, taskId: string) => tasksCancel(sessionId, taskId));
	ipcMain.handle("tasks:dismiss", (_event, sessionId: string, taskId: string) => tasksDismiss(sessionId, taskId));
	ipcMain.handle("tasks:resume", (_event, sessionId: string, taskId: string) => tasksResume(sessionId, taskId));
}
