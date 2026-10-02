/**
 * 同名冲突的两个动作：看差异，改用那个。
 *
 * 设置页能列出谁盖了谁，但「差在哪」和「怎么换」以前都要去开文件。这里补上：diff 由主进程算
 * （它能读任意路径），偏好写进本机的 settings.json——写完把路径交回去，页面要把它显示出来，
 * 不然下次找不到自己改了什么。
 */

import { ipcMain, shell } from "electron";
import { readFile } from "node:fs/promises";
import { computeDiff, settingsPath } from "@plume/core";
import { applySettings, settings } from "../app-settings.ts";
import { definitionTrashTarget } from "../definition-trash.ts";

type Kind = "skill";

export function registerCapabilitiesIpc(): void {
	ipcMain.handle("capabilities:trash", async (_event, kind: unknown, cwd: unknown, path: unknown) => {
		const target = await definitionTrashTarget(kind, cwd, path, settings());
		// Use the OS trash and let the existing capability watcher reload at a safe turn boundary.
		await shell.trashItem(target);
	});

	/** 赢家在前、输家在后：hunk 里的「+」是输家多出来的，也就是改用它会多出什么。 */
	ipcMain.handle("capabilities:diff", async (_event, _kind: Kind, winner: string, loser: string) => {
		const [before, after] = await Promise.all([readFile(winner, "utf8"), readFile(loser, "utf8")]);
		const diff = computeDiff(before, after);
		return { hunks: diff.hunks, added: diff.added, removed: diff.removed };
	});

	ipcMain.handle("capabilities:prefer", async (_event, kind: Kind, name: string, path: string) => {
		const current = settings();
		await applySettings({ ...current, capabilityPreferences: { ...current.capabilityPreferences, [`${kind}:${name}`]: path } });
		return { wroteTo: settingsPath() };
	});
}
