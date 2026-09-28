/**
 * The folders a project is made of, as one answer several panes can share.
 *
 * The file tree, the tree that drops out of the open file's name, and the `@` menu all need the
 * same list, and each of them used to reach for `workspace.path` — which is one folder, the one
 * sessions run in. Working them out separately is how a project ends up listed with two source
 * folders while every pane that browses it shows one.
 *
 * The project is named by the caller: a split shows one per screen, and each of those panes lists
 * its own screen's (`useScopedWorkspace`). Read from the live slot here, every screen's tree and `@`
 * menu listed the focused conversation's project.
 *
 * Falls back to the working directory for a project that is not on the list at all (a scratch
 * workspace, a directory opened before it was ever saved), which is exactly what those panes
 * showed before this existed.
 */

import { useMemo } from "react";

import { projectFolders } from "@plume/core/project-folders";
import { useApp } from "./index.ts";

/** `scoped` is a screen's own project (see `useScopedWorkspace`); without it, the live slot's. */
export function useProjectFolders(scoped?: { path: string } | null): string[] {
	const live = useApp((s) => s.workspace);
	const path = (scoped === undefined ? live : scoped)?.path ?? null;
	const projects = useApp((s) => s.settings?.projects);
	// Keyed on the path: a screen away from the live slot rebuilds its project object on every render.
	return useMemo(() => {
		if (!path) return [];
		const entry = projects?.find((project) => project.path === path);
		return entry ? projectFolders(entry) : [path];
	}, [path, projects]);
}
