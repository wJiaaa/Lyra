/**
 * Dropping files on the terminal types their paths, quoted for the shell — what Terminal.app,
 * iTerm2 and Windows Terminal all do, and the quickest way to hand a command a file.
 *
 * Both kinds of drag count: files from Finder or Explorer, and rows from Plume's own file tree,
 * which carry their absolute paths under `DRAGGED_PATHS`.
 */

import { DRAGGED_PATHS } from "../../lib/paths.ts";
import { bridge } from "../../services/index.ts";

/** Whether a drag is one this pane takes, judged from its types — the only thing readable mid-drag. */
export function carriesPaths(transfer: DataTransfer): boolean {
	return transfer.types.includes(DRAGGED_PATHS) || transfer.types.includes("Files");
}

/**
 * The dropped paths, read synchronously: the `DataTransfer` is emptied the moment the drop handler
 * returns, so nothing here can wait.
 */
export function droppedPaths(transfer: DataTransfer): string[] {
	const tree = transfer.getData(DRAGGED_PATHS);
	if (tree) {
		try {
			return (JSON.parse(tree) as unknown[]).filter((path): path is string => typeof path === "string" && path.length > 0);
		} catch {
			return [];
		}
	}
	if (typeof bridge.files?.pathForDrop !== "function") return [];
	return Array.from(transfer.files).flatMap((file) => {
		try {
			const path = bridge.files.pathForDrop(file);
			return path ? [path] : [];
		} catch {
			return [];
		}
	});
}

/**
 * One path as a shell word.
 *
 * POSIX: bare when every character is one no shell treats specially, otherwise single-quoted —
 * the one quoting where nothing inside is interpreted, so `$HOME` or a backtick in a file name stays
 * a file name. Windows: double quotes, which cmd, PowerShell and Git Bash all read as one word; the
 * single quotes PowerShell prefers mean nothing to cmd.
 */
export function shellWord(path: string, platform: string): string {
	if (platform === "win32") return /[\s&()^;,'`$%!@{}[\]]/.test(path) ? `"${path}"` : path;
	return /^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** What is typed for a drop: the words, space-separated, with a space after to keep typing. */
export function dropText(paths: string[], platform: string): string {
	return paths.length === 0 ? "" : `${paths.map((path) => shellWord(path, platform)).join(" ")} `;
}
