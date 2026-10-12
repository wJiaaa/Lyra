import { translate } from "../../i18n/translate.ts";
import { builtinCommandsFor, type CommandAction } from "@plume/core/commands-builtin";
import { parseInvocation, promptArgumentHint, resolveCommand, skillCommandName, type McpPromptEntry, type SlashCommand } from "@plume/core/commands-view";
import type { SkillEntry } from "../../../electron/ipc-types.ts";
import { DESKTOP_COMMAND_ACTIONS } from "../../../shared/command-actions.ts";

export interface CommandEntry {
	name: string;
	description: string;
	argumentHint?: string;
	origin: string;
	kind: "builtin" | "command" | "skill" | "prompt";
	action?: CommandAction;
}

export function commandEntries(commands: SlashCommand[], skills: SkillEntry[], prompts: McpPromptEntry[] = []): CommandEntry[] {
	const entries: CommandEntry[] = [
		...builtinCommandsFor(DESKTOP_COMMAND_ACTIONS).map((command): CommandEntry => ({ ...command, kind: "builtin", origin: translate("common.builtin") })),
		...commands.map((command): CommandEntry => ({ ...command, kind: "command", origin: translate(
				command.origin === "claude"
					? command.scope === "workspace"
						? "command.claudeProject"
						: "command.claudePersonal"
					: command.scope === "workspace"
						? "common.project"
						: "common.personal",
			) })),
		...skills.map((skill): CommandEntry => ({ name: skillCommandName(skill), description: skill.description, kind: "skill",
			origin: skill.pluginId ?? translate(skill.source === "workspace" ? "common.project" : "common.personal"),
			argumentHint: translate("command.optionalTask") })),
		// 最后一组：名字是 `mcp__<服务器>__<prompt>`，右边那栏写服务器在设置里的名字。
		...prompts.map((prompt): CommandEntry => {
			const hint = promptArgumentHint(prompt);
			return { name: prompt.name, description: prompt.description, kind: "prompt", origin: prompt.serverName, ...(hint ? { argumentHint: hint } : {}) };
		}),
	];
	const seen = new Set<string>();
	return entries.filter((entry) => {
		const name = entry.name.toLowerCase();
		if (seen.has(name)) return false;
		seen.add(name); return true;
	});
}

export interface CommandDecoration { start: number; end: number; hint?: string }

/** Only executable leading commands receive command styling; prose references remain ordinary text. */
export function commandDecoration(text: string, entries: CommandEntry[]): CommandDecoration | undefined {
	const start = text.length - text.trimStart().length;
	const invocation = parseInvocation(text.trimStart());
	if (!invocation) return;
	const entry = resolveCommand(entries, invocation.name) ?? (invocation.name.startsWith("skill:") ? resolveCommand(entries.filter((entry) => entry.kind === "skill"), invocation.name.slice(6)) : undefined);
	if (!entry) return;
	return { start, end: start + invocation.name.length + 1, hint: invocation.rest ? undefined : entry.argumentHint };
}

/** UTF-16 offsets match the native textarea selection API, including text before emoji and CJK. */
export function commandCompletion(text: string, start: number, end: number) {
	if (start !== end || (start < text.length && !/\s/.test(text[start]))) return null;
	const match = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/.exec(text.slice(0, start));
	if (!match) return null;
	// A backtick/fenced quote is documentation, not a completion request.
	if ((text.slice(0, start).match(/`/g)?.length ?? 0) % 2) return null;
	return { term: match[1], start: start - match[1].length - 1, end };
}
