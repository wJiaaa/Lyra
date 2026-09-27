/**
 * 设置页的钩子：用户级的在设置文件里，项目级的在 `<cwd>/.lyra/config.json` 里。
 *
 * 每个写操作都回一份新的完整列表，因为 `id` 是位置——删掉一条，后面的全都挪了。项目钩子另带
 * 一个 `trusted`：没被信任的在会话里不会运行，设置页据此给出「信任」按钮。
 */

import { ipcMain } from "electron";
import {
	addHook,
	hookEntries,
	readProjectHooks,
	removeHook,
	setHookEnabled,
	trustedHookDigests,
	trustHookDigests,
	updateHook,
	writeProjectHooks,
	type HookDraft,
	type HookEntry,
	type HookScope,
	type HooksConfig,
} from "@lyra/core";
import { applySettings, settings } from "../app-settings.ts";
import type { HookView, HooksView } from "../ipc-types.ts";

const KNOWN = new Set(["type", "command", "args", "async", "shell", "statusMessage", "timeout", "timeoutMs", "enabled"]);

function view(entry: HookEntry, trusted?: Set<string>): HookView {
	const { definition } = entry;
	const custom = Object.fromEntries(Object.entries(definition).filter(([key]) => !KNOWN.has(key)));
	const timeoutMs = definition.timeoutMs ?? (definition.type === "command" && definition.timeout !== undefined ? definition.timeout * 1000 : undefined);
	return {
		id: entry.id,
		scope: entry.scope,
		event: entry.event,
		...(entry.matcher ? { matcher: entry.matcher } : {}),
		type: definition.type,
		command: definition.command,
		...(definition.type === "process" && definition.args ? { args: definition.args } : {}),
		...(definition.type === "command" && definition.async ? { async: true } : {}),
		...(definition.type === "command" && definition.shell ? { shell: definition.shell } : {}),
		...(definition.statusMessage ? { statusMessage: definition.statusMessage } : {}),
		...(timeoutMs !== undefined ? { timeout: Math.round(timeoutMs / 1000) } : {}),
		enabled: definition.enabled !== false,
		...(Object.keys(custom).length > 0 ? { custom } : {}),
		...(trusted ? { trusted: trusted.has(entry.digest) } : {}),
	};
}

async function list(cwd: string | null): Promise<HooksView> {
	const user = hookEntries(settings().hooks, "user").map((entry) => view(entry));
	if (!cwd) return { user, project: null };
	const project = await readProjectHooks(cwd);
	const entries = hookEntries(project.config, "project");
	const trusted = entries.length > 0 ? await trustedHookDigests(cwd) : new Set<string>();
	return {
		user,
		project: entries.map((entry) => view(entry, trusted)),
		projectPath: project.path,
		...(project.error ? { projectError: project.error } : {}),
	};
}

async function change(scope: HookScope, cwd: string | null, edit: (config: HooksConfig) => HooksConfig): Promise<HooksView> {
	if (scope === "user") {
		await applySettings({ ...settings(), hooks: edit(settings().hooks) });
		return list(cwd);
	}
	if (!cwd) throw new Error("没有打开项目，无法修改项目钩子。");
	const project = await readProjectHooks(cwd);
	if (project.error) throw new Error(project.error);
	const before = new Set(hookEntries(project.config, "project").map((entry) => entry.digest));
	const next = edit(project.config);
	await writeProjectHooks(cwd, next);
	/*
	 * 在这台机器上、从设置页亲手写下的项目钩子，就是这台机器的主人写的——不该转头再让他审一遍自己
	 * 刚打的字。只有这次改动新出现的指纹算进来；从别处（拉下来的提交）来的那些照旧要审。
	 */
	const entries = hookEntries(next, "project");
	const fresh = entries.filter((entry) => !before.has(entry.digest)).map((entry) => entry.digest);
	if (fresh.length > 0) await trustHookDigests(cwd, fresh, entries.map((entry) => entry.digest));
	return list(cwd);
}

export function registerHooksIpc(): void {
	ipcMain.handle("hooks:list", async (_event, cwd: string | null) => list(cwd));
	ipcMain.handle("hooks:save", async (_event, scope: HookScope, cwd: string | null, id: string | null, draft: HookDraft) =>
		change(scope, cwd, (config) => (id ? updateHook(config, id, draft) : addHook(config, draft))),
	);
	ipcMain.handle("hooks:remove", async (_event, scope: HookScope, cwd: string | null, id: string) => change(scope, cwd, (config) => removeHook(config, id)));
	ipcMain.handle("hooks:setEnabled", async (_event, scope: HookScope, cwd: string | null, id: string, enabled: boolean) =>
		change(scope, cwd, (config) => setHookEnabled(config, id, enabled)),
	);
	ipcMain.handle("hooks:trust", async (_event, cwd: string, ids: string[]) => {
		const project = await readProjectHooks(cwd);
		const entries = hookEntries(project.config, "project");
		const wanted = new Set(ids);
		await trustHookDigests(cwd, entries.filter((entry) => wanted.has(entry.id)).map((entry) => entry.digest), entries.map((entry) => entry.digest));
		return list(cwd);
	});
}
