import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { parseBrowserCommand } from "../../shared/browser.ts";
import { BrowserTabClosed, browserCommand, browserState, configureBrowser, attachBrowser } from "../browser-workspace.ts";
import { cancelBrowserInspect, inspectBrowser } from "../browser-inspect.ts";
import { isAppWindowContents } from "../window.ts";

export function registerBrowserIpc(window: () => BrowserWindow | null, settings: () => { defaultZoom?: number }): void {
	configureBrowser(window, settings);
	const trusted = (event: IpcMainInvokeEvent) => {
		if (!isAppWindowContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("浏览器控制只允许来自 Plume 应用窗口");
	};
	ipcMain.handle("browser:state", (event) => { trusted(event); return browserState(); });
	ipcMain.handle("browser:command", async (event, command: unknown) => {
		trusted(event);
		try {
			return await browserCommand(parseBrowserCommand(command));
		} catch (error) {
			/*
			 * 人这一下点在了刚关掉的标签上：页面还在加载就关了它、agent 用 browser_tabs 关了它、会话被删时
			 * 它还没就绪。标签没了就是关标签想要的结果，再弹一条「浏览器标签已关闭」只是把时间差报给人。
			 * 交回现状，面板据此把那一格撤下。agent 不走这里，它照样收到这个错误。
			 */
			if (error instanceof BrowserTabClosed) return browserState();
			throw error;
		}
	});
	ipcMain.handle("browser:attach", (event, id: string, contentsId: number) => { trusted(event); attachBrowser(id, contentsId, event.sender); });
	ipcMain.handle("browser:inspect", async (event, id: string, mode: "element" | "region") => {
		trusted(event);
		if (mode !== "element" && mode !== "region") throw new Error("未知检查方式");
		return inspectBrowser(id, mode);
	});
	ipcMain.handle("browser:cancelInspect", async (event, id: string) => { trusted(event); await cancelBrowserInspect(id); });
}
