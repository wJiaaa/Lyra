/**
 * Where an unsent message in a blank conversation is kept: in a project, under the project, so two
 * projects on one folder each keep their own; on a folder opened on its own, under the folder; with
 * neither, under the scratch directory it will run in. Folders get a prefix of their own: an older
 * project's id is its path, and that project and its folder opened alone are still two places.
 */
export function blankDraftKey(workspace: { path: string; projectId?: string } | null, scratchCwd: string | null): string {
	if (workspace) return workspace.projectId ? `new:project:${workspace.projectId}` : `new:folder:${workspace.path}`;
	return `new:scratch:${scratchCwd ?? "general"}`;
}
