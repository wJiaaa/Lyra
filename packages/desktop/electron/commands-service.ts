/** Read-only command catalogue for the composer. */

import {
	builtinCommandsFor,
	collectAgents,
	collectSkills,
	commandSources,
	loadCommands,
	loadPlugins,
	lyraHome,
	type BuiltinCommand,
	type Settings,
	type SlashCommand,
} from "@lyra/core";
import { join } from "node:path";

export interface CommandsList {
	commands: SlashCommand[];
	builtins: BuiltinCommand[];
	diagnostics: { path: string; message: string }[];
	skills: SkillEntry[];
	agents: Array<{ id: string; name: string; description: string }>;
}

export interface SkillEntry {
	name: string;
	description: string;
	source: "workspace" | "user" | "builtin";
	pluginId?: string;
	path?: string;
}

export async function listCommands(cwd: string, settings: Settings): Promise<CommandsList> {
	const home = lyraHome();
	const { commands, diagnostics } = await loadCommands(commandSources(cwd || null, home));
	const bundles = await loadPlugins(
		[
			{ dir: join(cwd || home, ".lyra", "plugins"), source: "workspace" as const },
			{ dir: join(home, "plugins"), source: "user" as const },
		],
		[],
	).catch(() => ({ plugins: [] }));
	const { skills } = await collectSkills(cwd || home, bundles.plugins, settings).catch(() => ({ skills: [] }));
	const agents = await collectAgents(cwd || home, settings);
	return {
		agents: agents.map(agent => ({ id: agent.name, name: agent.name, description: agent.description })),
		commands,
		diagnostics,
		builtins: builtinCommandsFor(["compact", "clear", "manage-commands"]),
		skills: skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			source: skill.source,
			path: skill.path,
			...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
		})),
	};
}
