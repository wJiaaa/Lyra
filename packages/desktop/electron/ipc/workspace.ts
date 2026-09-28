/**
 * Settings and the open workspace.
 *
 * Both are answers to "what is this app pointed at right now", and both are read far more often
 * than they are written — which is why the writing side is one call into `app-settings` rather than
 * a list of things to remember to update.
 */

import { app, ipcMain, dialog, shell } from "electron";
import type { Settings } from "@plume/core";
import type { WorkspaceInfo } from "../ipc-types.ts";
import { applySettings, settings } from "../app-settings.ts";
import { getWindow } from "../window.ts";
import { nativeTranslator } from "../i18n.ts";

export interface WorkspaceIpcDeps {
	/** Reading a directory as a project: its name, whether it is a repo, which repos are inside. */
	workspaceInfo(path: string): Promise<WorkspaceInfo | null>;
}

export function registerWorkspaceIpc({ workspaceInfo }: WorkspaceIpcDeps): void {
	ipcMain.handle("settings:get", async () => settings());

	ipcMain.handle("settings:save", async (_event, next: Settings) => applySettings(next));

	ipcMain.handle("workspace:pick", async (): Promise<WorkspaceInfo | null> => {
		const window = getWindow();
		if (!window) return null;
		const result = await dialog.showOpenDialog(window, {
			properties: ["openDirectory", "createDirectory"],
			title: nativeTranslator(settings().uiLocale, app.getLocale())("dialog.projectDirectory"),
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return workspaceInfo(result.filePaths[0]);
	});

	ipcMain.handle("workspace:info", async (_event, path: string) => workspaceInfo(path));

	ipcMain.handle("workspace:reveal", async (_event, path: string) => {
		shell.showItemInFolder(path);
	});
}
