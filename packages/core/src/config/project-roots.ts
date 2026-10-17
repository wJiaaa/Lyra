/**
 * Which folders a session is allowed to treat as "this project".
 *
 * A project may name more than one source folder (see `ProjectEntry.folders`), and the session only
 * ever runs in one of them. Everything downstream that asks "is this path inside the project" —
 * today the read boundary, see `tools/read-access.ts` — has to ask it about all of them, or adding
 * a second folder buys a row in a dialog and an approval prompt per file.
 *
 * Derived from settings at the point of use rather than carried alongside the cwd: the project list
 * is already in every session's settings, and a second copy of the same fact is a second thing to
 * keep in step. It is read once per turn.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

import { projectFolders } from "./project-folders.ts";
import type { ProjectEntry } from "./settings.ts";

/** The same containment rule `read-access.ts` uses: strict about the separator, so `p-old` ⊄ `p`. */
export function within(root: string, path: string): boolean {
	const rel = relative(resolve(root), resolve(path));
	return rel === "" || !(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel));
}

/**
 * The source folders of the project a session records (`SessionMeta.project`), or nothing.
 *
 * Only the recorded project answers. The folder used to be asked as well — "which project lists the
 * folder this runs in" — and one folder can be in several projects, so that answer was a guess. A
 * session started outside any project reads its own `cwd` and nothing more.
 *
 * The project must still cover `cwd`: a worktree session runs outside every folder of its project
 * and does not reach back into the checkout it branched from.
 *
 * Returns the whole set including the folder that matched. The caller already allows its own cwd,
 * so the overlap is free.
 */
export function projectRootsFor(
	projects: readonly Pick<ProjectEntry, "id" | "path" | "folders">[] | undefined,
	cwd: string,
	project: string | undefined,
): string[] {
	const own = project ? projects?.find((entry) => entry.id === project) : undefined;
	return own && projectFolders(own).some((folder) => within(folder, cwd)) ? projectFolders(own) : [];
}
