/**
 * 从会话里总结出来的技能候选：列出、批准、否决。
 *
 * 铁律只有一条：**人不点头就不生效**。一个会自己给自己加技能的 agent，只有在那些技能每一条都
 * 经过人点头时才是能用的。
 */

import { ipcMain } from "electron";
import { approveSkill, pendingSkills, rejectSkill } from "@plume/core";
import { sessions } from "../session-hub.ts";

export function registerSkillsIpc(): void {
	ipcMain.handle("skills:pending", async (_event, cwd: string) => (cwd ? pendingSkills(cwd) : []));

	ipcMain.handle("skills:approve", async (_event, cwd: string, name: string, content?: string) => {
		const path = await approveSkill(cwd, name, content);
		// 批准之后立刻能用：一个要重启才生效的批准，跟没批准分不出来。
		if (path) for (const session of sessions.values()) await session.initialize().catch(() => {});
		return path;
	});

	ipcMain.handle("skills:reject", async (_event, cwd: string, name: string) => rejectSkill(cwd, name));
}
