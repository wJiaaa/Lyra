/**
 * Reading a unified diff into the shape the diff viewer already renders.
 *
 * The workspace panel builds its hunks by diffing two file contents it has in hand. A pull request
 * has no such thing — the changes live on a branch nobody has checked out, and `gh pr diff` hands
 * back the patch as text. Parsing it here means one viewer draws both, so a review reads exactly
 * like looking at your own uncommitted work.
 *
 * Deliberately tolerant. A diff is generated output, but not all of it is about lines: binary
 * files, renames, mode changes and "\ No newline at end of file" all appear in the same stream,
 * and a parser that throws on the first one it does not recognise is a viewer that shows nothing
 * because one file in forty was a PNG.
 */

import type { DiffHunk } from "@plume/core";
import type { WorkspaceDiffFile } from "./ipc-shapes.ts";

/** Past this a diff is not being read, it is being scrolled. */
const MAX_FILES = 300;

/** Per file, for the same reason. The viewer caps what it draws; this caps what it holds. */
const MAX_LINES_PER_FILE = 4000;

export function parseUnifiedDiff(patch: string): WorkspaceDiffFile[] {
	const files: WorkspaceDiffFile[] = [];
	let current: WorkspaceDiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	let lineCount = 0;

	const closeHunk = () => {
		if (current && hunk && hunk.lines.length > 0) current.hunks.push(hunk);
		hunk = null;
	};
	const closeFile = () => {
		closeHunk();
		if (current) files.push(current);
		current = null;
	};

	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			closeFile();
			if (files.length >= MAX_FILES) break;
			current = { path: pathFromHeader(line), status: "modified", added: 0, removed: 0, hunks: [] };
			lineCount = 0;
			continue;
		}
		if (!current) continue;

		// `new file` / `deleted file` come before the hunks and are the only reliable signal:
		// a rename with no edits has no hunks at all, and a new file's "old" side is /dev/null.
		if (line.startsWith("new file mode")) {
			current.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			current.status = "deleted";
			continue;
		}
		if (line.startsWith("rename to ")) {
			current.status = "renamed";
			current.path = line.slice("rename to ".length).trim();
			continue;
		}
		if (line.startsWith("Binary files ")) {
			// Nothing to show, but the file did change and belongs in the list.
			closeHunk();
			continue;
		}

		if (line.startsWith("@@")) {
			closeHunk();
			const range = parseRange(line);
			if (!range) continue;
			oldLine = range.oldStart;
			newLine = range.newStart;
			hunk = { oldStart: range.oldStart, newStart: range.newStart, lines: [] };
			continue;
		}

		if (!hunk || lineCount >= MAX_LINES_PER_FILE) continue;

		// `---` / `+++` are headers, not content; they only appear before the first `@@`.
		if (line.startsWith("\\")) continue;

		const marker = line[0];
		const text = line.slice(1);
		if (marker === "+") {
			hunk.lines.push({ type: "add", text, newLine });
			newLine++;
			current.added++;
		} else if (marker === "-") {
			hunk.lines.push({ type: "remove", text, oldLine });
			oldLine++;
			current.removed++;
		} else if (marker === " " || line === "") {
			hunk.lines.push({ type: "context", text, oldLine, newLine });
			oldLine++;
			newLine++;
		} else {
			continue;
		}
		lineCount++;
	}

	closeFile();
	return files;
}

/**
 * The path, taken from the `b/` side.
 *
 * Both sides are prefixed, and a rename makes them differ; the new name is what the reviewer is
 * looking for. Git quotes *both* sides when either contains a space or a non-ASCII byte, which is
 * why the quoted form is matched first — splitting on " b/" finds nothing in `"a/x y" "b/x y"`.
 */
function pathFromHeader(line: string): string {
	const rest = line.slice("diff --git ".length).trim();

	const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(rest);
	if (quoted) return unescapeQuoted(quoted[2]);

	const bIndex = rest.lastIndexOf(" b/");
	if (bIndex === -1) return rest;
	return rest.slice(bIndex + 3);
}

/** Git's quoting is C-style, which JSON's parser handles for the cases that actually occur. */
function unescapeQuoted(inner: string): string {
	try {
		return JSON.parse(`"${inner}"`) as string;
	} catch {
		return inner;
	}
}

/** `@@ -12,7 +12,9 @@ context` → where the two sides start. */
function parseRange(line: string): { oldStart: number; newStart: number } | null {
	const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
	if (!match) return null;
	return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}
