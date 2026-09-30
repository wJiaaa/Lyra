import { ipcMain, shell } from "electron";
import { AgentDefinitionStore, builtinTools, plumeHome, type AgentDefinitionSave } from "@plume/core";
import { settings } from "../app-settings.ts";
import { sessions } from "../session-hub.ts";

export function registerAgentDefinitionsIpc(): void {
	const store = new AgentDefinitionStore(plumeHome());
	const cwd = (projectId: string | null) => {
		if (projectId === null) return null;
		if (typeof projectId !== "string") throw new Error("项目标识无效");
		const project = settings().projects.find(item => item.id === projectId);
		if (!project) throw new Error("项目不存在，请重新选择");
		return project.path;
	};
	const toolNames = async (path: string | null) => {
		const tools = new Set(builtinTools().map(tool => tool.name));
		for (const session of sessions.values()) {
			if (session.cwd !== path) continue;
			for (const name of (await session.status()).toolNames) tools.add(name);
		}
		return [...tools].sort();
	};
	const reload = async (path: string | null): Promise<{ warning?: string }> => {
		const results = await Promise.allSettled([...sessions.values()].filter(session => !path || session.cwd === path).map(session => session.reloadCapabilities()));
		const failed = results.filter(result => result.status === "rejected");
		return failed.length ? { warning: "已保存，部分会话刷新失败；重新加载后生效" } : {};
	};
	ipcMain.handle("agentdefs:list", async (_event, projectId: string | null) => {
		const path = cwd(projectId);
		return { records: await store.list(path, settings()), tools: await toolNames(path) };
	});
	ipcMain.handle("agentdefs:read", (_event, projectId: string | null, id: string) => store.read(cwd(projectId), id, settings()));
	ipcMain.handle("agentdefs:save", async (_event, projectId: string | null, input: AgentDefinitionSave) => {
		const path = cwd(projectId);
		await store.save(path, input, await toolNames(path), settings());
		return reload(input.scope === "user" ? null : path);
	});
	ipcMain.handle("agentdefs:remove", async (_event, projectId: string | null, id: string, revision: string) => {
		const path = cwd(projectId);
		const record = await store.read(path, id, settings());
		// The system trash, like commands and skills: recoverable there, nothing left behind here.
		await store.remove(path, id, revision, (file) => shell.trashItem(file), settings());
		return reload(record.scope === "user" ? null : path);
	});
}
