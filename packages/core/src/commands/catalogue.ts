/**
 * Everything a `/` menu offers: commands on disk, the host's built-ins, skills and sub-agents.
 *
 * Read fresh on every call — the list is what a person is about to pick from, and a definition
 * edited in another editor has to show up without a restart.
 */

import { join } from "node:path";
import type { Settings } from "../config/settings.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { collectAgents, collectSkills, withoutDisabledSkills } from "../runtime/session-setup.ts";
import { plumeHome } from "../session/store.ts";
import { builtinCommandsFor, type BuiltinCommand, type CommandAction } from "./builtin.ts";
import { commandSources, loadCommands, type SlashCommand } from "./loader.ts";

export interface CommandsList {
	commands: SlashCommand[];
	builtins: BuiltinCommand[];
	diagnostics: { path: string; message: string }[];
	skills: SkillEntry[];
	agents: Array<{ id: string; name: string; description: string; avatar?: string }>;
}

export interface SkillEntry {
	name: string;
	description: string;
	source: "workspace" | "user" | "builtin";
	pluginId?: string;
	path?: string;
}

/** `actions` is what this host implements; built-ins it cannot run are left out of the list. */
export async function listCommands(cwd: string, settings: Settings, actions: readonly CommandAction[]): Promise<CommandsList> {
	const home = plumeHome();
	const { commands, diagnostics } = await loadCommands(commandSources(cwd || null, home));
	/*
	 * The switched-off list, not `[]`. With nothing disabled every plugin counted as on, so a plugin
	 * somebody had switched off in settings still offered its skills in the `/` menu — skills the
	 * session would then not have.
	 */
	const bundles = await loadPlugins(
		[
			{ dir: join(cwd || home, ".plume", "plugins"), source: "workspace" as const },
			{ dir: join(home, "plugins"), source: "user" as const },
		],
		settings.disabledPlugins,
	).catch(() => ({ plugins: [] }));
	const collected = await collectSkills(cwd || home, bundles.plugins, settings).catch(() => ({ skills: [] }));
	// 关掉的技能会话里没有，菜单里也不能有。
	const skills = await withoutDisabledSkills(collected.skills, settings);
	const agents = await collectAgents(cwd || home, settings);
	return {
		agents: agents.map(agent => ({ id: agent.name, name: agent.name, description: agent.description, ...(agent.avatar ? { avatar: agent.avatar } : {}) })),
		commands,
		diagnostics,
		builtins: builtinCommandsFor(actions),
		skills: skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			source: skill.source,
			path: skill.path,
			...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
		})),
	};
}
