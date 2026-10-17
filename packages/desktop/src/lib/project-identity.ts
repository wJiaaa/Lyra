/**
 * A project is its id; a folder is somewhere it works. The questions that follow from that.
 *
 * One folder can be in several projects, so a folder cannot say which project anything is in. A
 * conversation records the project it was started in (`SessionMeta.project`), and that is the only
 * answer: one that records none — started on a folder opened on its own — belongs to no project,
 * whatever folder it runs in. Pure, so it can be tested without a window.
 */

import type { ProjectEntry, SessionMeta } from "@plume/core";
import { baseName, dirName } from "./paths.ts";

/**
 * What to show beside a name another project also has, so a list can tell the two apart.
 *
 * The end of the parent path, as few folders as it takes: `~/work/a/app` and `~/work/b/app` read
 * `a` and `b`. The whole path was tried first, and in a sidebar or a menu both rows read
 * `~/work/…`, cut off right where they differ. Names nobody else has get nothing — a list where
 * every row carried its folder would be a list of paths.
 *
 * Only the folders that differ are compared. Two projects on one folder under one name are something
 * a path cannot tell apart: comparing them read back to the root and hung the same whole parent path
 * on both rows. They get nothing, and the folder they share reads once beside the others. Folders
 * whose own names differ (`~/x/a`, `~/x/b`) are told apart by those names, not by the parent they share.
 */
export function pathHints<T extends Pick<ProjectEntry, "id" | "name" | "path">>(projects: readonly T[]): Map<string, string> {
	const byName = new Map<string, T[]>();
	for (const project of projects) byName.set(project.name, [...(byName.get(project.name) ?? []), project]);
	const hints = new Map<string, string>();
	for (const same of byName.values()) {
		const paths = [...new Set(same.map((project) => project.path))];
		if (paths.length < 2) continue;
		const sameBase = new Set(paths.map(baseName)).size === 1;
		const segments = paths.map((path) => (sameBase ? dirName(path) : path).split(/[/\\]/).filter(Boolean));
		const longest = Math.max(...segments.map((parts) => parts.length));
		for (let depth = 1; depth <= Math.max(longest, 1); depth++) {
			const tails = segments.map((parts) => parts.slice(-depth).join("/") || "/");
			if (new Set(tails).size < tails.length && depth < longest) continue;
			const byPath = new Map(paths.map((path, index) => [path, tails[index]]));
			for (const project of same) hints.set(project.id, byPath.get(project.path) ?? "");
			break;
		}
	}
	return hints;
}

/** The project a conversation records, while that project is still on the list. */
export function sessionProject<T extends Pick<ProjectEntry, "id">>(projects: readonly T[], session: Pick<SessionMeta, "project">): T | undefined {
	return session.project ? projects.find((project) => project.id === session.project) : undefined;
}

/**
 * What to call a conversation's project: the project's name now, not the folder name it was given
 * when it started — a renamed project, or two checkouts both called `app`, read the same way here as
 * on their own row. A conversation in no project is called by its folder.
 */
export function projectLabel(projects: readonly Pick<ProjectEntry, "id" | "name">[], session: Pick<SessionMeta, "project" | "projectName">): string {
	return sessionProject(projects, session)?.name ?? session.projectName;
}

/** The conversations filed under project `id`: the ones that record it. */
export function projectSessions<S extends Pick<SessionMeta, "project">>(sessions: readonly S[], id: string): S[] {
	return sessions.filter((session) => session.project === id);
}

/**
 * One project per main folder, for choices that are really about the folder — its
 * `.plume/config.json`, its index. Two projects on one checkout share those, and listing the
 * checkout twice offers the same thing under two names. The first in the list stands for it.
 */
export function onePerFolder<T extends Pick<ProjectEntry, "path">>(projects: readonly T[]): T[] {
	return projects.filter((project, index) => projects.findIndex((other) => other.path === project.path) === index);
}

/**
 * What a choice made per folder is called: every project on that folder, joined the way the
 * language joins a list — `codex和B`, `codex and B`. Those projects share what is set there, and a
 * list showing one of their names would let someone believe they were changing only that one.
 */
export function folderChoiceName(projects: readonly Pick<ProjectEntry, "name" | "path">[], path: string, locale: string): string {
	const names = projects.filter((project) => project.path === path).map((project) => project.name);
	return new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
}
