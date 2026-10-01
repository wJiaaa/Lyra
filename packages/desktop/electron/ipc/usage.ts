/**
 * Usage, over IPC.
 *
 * One handler, and it is deliberately dumb: it hands back the whole day-by-model table and lets
 * the page decide what a range or a ranking is. The alternative — a handler per question — would
 * put the arithmetic on the far side of a process boundary where it cannot be tested without
 * booting Electron.
 *
 * In flight at most once. The first scan reads every billed call ever made, and opening the page
 * twice while it runs should wait for the answer rather than start a second read.
 *
 * 另外两条是关于这些日志本身的：它们占了多少地方，以及怎么删掉一段时间的。删除放在这一组而不是
 * `sessions` 那一组，因为按时间成片地删是从「这一页上的数字」出发的动作，而不是从某一条对话出发
 * 的动作——见 `session-cleanup.ts` 开头那段。
 */

import { ipcMain } from "electron";
import type { SessionStorage } from "@plume/core";
import { settings } from "../app-settings.ts";
import { deleteIdleSessions } from "../session-hub.ts";
import { clearSessions, storageUse, type ClearRange } from "../session-cleanup.ts";
import { scanUsage, type UsageScan } from "../usage-scan.ts";

let inFlight: Promise<UsageScan> | null = null;

export interface UsageIpcDeps {
	store(): SessionStorage;
}

export function registerUsageIpc({ store: readStore }: UsageIpcDeps): void {
	ipcMain.handle("usage:scan", async () => {
		if (!inFlight) {
			inFlight = scanUsage(readStore(), undefined, settings().providers).finally(() => {
				inFlight = null;
			});
		}
		return inFlight;
	});

	ipcMain.handle("usage:storage", () => storageUse(readStore()));

	ipcMain.handle("usage:clear", async (_event, range: ClearRange) => {
		// 「在跑」不只是回合本身：刚提交、正在启动、侧边聊天、后台子代理都算，见 `sessionBusy`。
		const result = await clearSessions(readStore(), range, deleteIdleSessions);
		/*
		 * 丢掉在飞的那次扫描：它可能在删除开始之前就已出发，每天有几个活跃会话还是删之前的数。
		 * 花销不受影响——删会话不删 `spend` 表。
		 */
		inFlight = null;
		return result;
	});
}
