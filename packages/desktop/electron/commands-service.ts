/** Read-only command catalogue for the composer. */

import { listCommands as listCatalogue, type CommandsList, type Settings } from "@lyra/core";

export type { CommandsList, SkillEntry } from "@lyra/core";

export function listCommands(cwd: string, settings: Settings): Promise<CommandsList> {
	return listCatalogue(cwd, settings, ["compact", "clear", "manage-commands"]);
}
