/**
 * What a `/name rest` line turns into before it is sent: a command's expansion, or the ask for a
 * skill.
 *
 * Shared by every host with a composer — the window and the terminal — so the same line means the
 * same prompt in both. Browser-safe like the rest of `commands-view`: the catalogue is handed in,
 * and nothing here touches the filesystem.
 */

import { expandCommand, resolveCommand, skillNameOf, type Invocation } from "./expand.ts";
import type { SlashCommand } from "./loader.ts";

/** The parts of a skill listing the resolver needs. */
export interface SkillCommandTarget {
	name: string;
	pluginId?: string;
	path?: string;
}

export interface ResolvedInvocation {
	/** What the model is given. */
	outgoing: string;
	/** What the person sees in their own bubble, when that differs from `outgoing`. */
	displayText?: string;
	skillRef?: { name: string; path?: string; pluginId?: string };
	/** The delivery a command declared for itself — see `SlashCommand.deliver`. */
	deliver?: "steer" | "followUp";
}

/** How a skill is typed after the slash. Plugin-qualified so two bundles cannot select each other's skill. */
export function skillCommandName(skill: { name: string; pluginId?: string }): string {
	return skill.pluginId ? `${skill.pluginId}:${skill.name}` : skill.name;
}

/**
 * A command first, then a skill by name; `null` when neither exists.
 *
 * `null` is not an error: an unknown name goes out as typed, because `/` is also how people write
 * paths and a composer that rejected them would be wrong far more often than right.
 */
export function resolveInvocation(
	invocation: Invocation,
	catalogue: { commands: SlashCommand[]; skills?: SkillCommandTarget[] },
): ResolvedInvocation | null {
	/*
	 * 精确命中优先，否则唯一的末段匹配——`/commit` 找到 `git:commit`。
	 *
	 * 菜单那边早就这么匹配了（`rankCommands` 的 rank 2），而这里一直是精确匹配：
	 * 列表里看得见、回车却找不到。
	 */
	const command = resolveCommand(catalogue.commands, invocation.name);
	if (command) {
		/*
		 * 命令自己说了怎么送，就按它说的送。
		 *
		 * `followUp` 是这里唯一真正改变行为的一个：会话正忙时不插话，排到这一轮后面。
		 * 空闲时三种都一样，都是开一个新回合。
		 */
		const deliver = command.deliver === "followUp" || command.deliver === "steer" ? command.deliver : undefined;
		return { outgoing: expandCommand(command, invocation.rest), ...(deliver ? { deliver } : {}) };
	}
	/*
	 * A skill, asked for by name.
	 *
	 * Expanded into an instruction rather than into the skill's own body: the body can run to
	 * several thousand words and belongs in a tool result, which is where the `skill` tool puts
	 * it. What goes in the transcript is the ask — short, and exactly what the model is being told.
	 *
	 * Works for skills the model cannot see on its own, and that is the point of them:
	 * `disableModelInvocation` means "do not choose this yourself", not "never run this" — the
	 * tool looks skills up by name and has never filtered on that flag.
	 */
	const target = skillNameOf(invocation).toLowerCase();
	const skill = catalogue.skills?.find((entry) => skillCommandName(entry).toLowerCase() === target);
	if (!skill) return null;
	const rest = invocation.rest.trim();
	return {
		// Written for the model, so it stays in English whatever the interface language is.
		outgoing: [`Use the \`${skill.name}\` skill${skill.pluginId ? ` (from the ${skill.pluginId} plugin)` : ""}.`, rest].filter(Boolean).join("\n\n"),
		displayText: rest,
		skillRef: { name: skill.name, path: skill.path, pluginId: skill.pluginId },
	};
}
