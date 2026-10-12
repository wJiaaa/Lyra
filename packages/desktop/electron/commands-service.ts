/** Read-only command catalogue for the composer. */

import { listCommands as listCatalogue, type CommandsList, type Settings } from "@plume/core";
import { DESKTOP_COMMAND_ACTIONS } from "../shared/command-actions.ts";

export type { CommandsList, SkillEntry } from "@plume/core";

export function listCommands(cwd: string, settings: Settings): Promise<CommandsList> {
	return listCatalogue(cwd, settings, DESKTOP_COMMAND_ACTIONS);
}
