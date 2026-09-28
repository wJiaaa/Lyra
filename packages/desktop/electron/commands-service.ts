/** Read-only command catalogue for the composer. */

import { listCommands as listCatalogue, type CommandsList, type Settings } from "@plume/core";

export type { CommandsList, SkillEntry } from "@plume/core";

export function listCommands(cwd: string, settings: Settings): Promise<CommandsList> {
	return listCatalogue(cwd, settings, ["compact", "clear", "manage-commands"]);
}
