/**
 * Carrying the old home over when the app was renamed.
 *
 * Everything a person has done with this application lives in one directory: every session log,
 * the settings, the API keys, the scratch files a run left behind. Renaming the app moved that
 * directory's name, and to anyone who had been using it that is indistinguishable from the app
 * having thrown all of it away.
 *
 * So it is moved once, on the first start that finds the old name and not the new one. A move
 * rather than a copy: two homes that both look valid is a worse state than either, because the
 * next question — which one is real — has no answer.
 */

import { rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** What the directory used to be called, before the app became Plume. */
const PREVIOUS = ".deepwise";

export interface MigrationResult {
	/** Whether anything was moved. False is the normal case, forever after the first run. */
	moved: boolean;
	from?: string;
	to?: string;
	/** Why it could not be moved, when it could not. Never thrown: a failed move is not fatal. */
	error?: string;
}

/**
 * Move `~/.deepwise` to `~/.plume`, if and only if that is unambiguous.
 *
 * Skipped when the new home already exists — someone has used the renamed app, and merging two
 * histories is not something to attempt without being asked. Skipped when `PLUME_HOME` is set,
 * because then the caller has already said where the data lives.
 */
export async function migratePreviousHome(home: string): Promise<MigrationResult> {
	if (process.env.PLUME_HOME) return { moved: false };

	const previous = join(homedir(), PREVIOUS);
	if (previous === home) return { moved: false };

	const [oldExists, newExists] = await Promise.all([isDirectory(previous), isDirectory(home)]);
	if (!oldExists || newExists) return { moved: false };

	try {
		await rename(previous, home);
		return { moved: true, from: previous, to: home };
	} catch (cause) {
		// A cross-device rename, or a permission problem. The app still starts; it simply starts
		// empty, and saying so is more use than crashing on the way up.
		return { moved: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

async function isDirectory(path: string): Promise<boolean> {
	return stat(path)
		.then((s) => s.isDirectory())
		.catch(() => false);
}
