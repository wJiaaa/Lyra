/**
 * Line diff used for edit previews and approval prompts.
 *
 * Implements Myers' shortest-edit-script over lines. The UI needs hunks with context
 * (not just counts) to render a proper side-by-side view. Search is bounded for large rewrites.
 */

export interface DiffLine {
	type: "context" | "add" | "remove";
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
}

export interface FileDiff {
	added: number;
	removed: number;
	hunks: DiffHunk[];
}

const CONTEXT_LINES = 3;

export function computeDiff(before: string, after: string, contextLines = CONTEXT_LINES): FileDiff {
	const oldLines = splitLines(before);
	const newLines = splitLines(after);
	const ops = diffLines(oldLines, newLines);

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === "add") added++;
		else if (op.type === "remove") removed++;
	}

	return { added, removed, hunks: groupHunks(ops, contextLines) };
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Myers searches by edit distance, so two distant changes do not allocate a whole-file matrix. */
function diffLines(a: string[], b: string[]): DiffLine[] {
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const midA = a.slice(prefix, a.length - suffix), midB = b.slice(prefix, b.length - suffix);
	const middle = shortestEdits(midA, midB) ?? [
		...midA.map((text): DiffLine => ({ type: "remove", text })),
		...midB.map((text): DiffLine => ({ type: "add", text })),
	];
	const ops: DiffLine[] = [
		...a.slice(0, prefix).map((text): DiffLine => ({ type: "context", text })),
		...middle,
		...a.slice(a.length - suffix).map((text): DiffLine => ({ type: "context", text })),
	];
	let oldLine = 1, newLine = 1;
	for (const op of ops) {
		if (op.type !== "add") op.oldLine = oldLine++;
		if (op.type !== "remove") op.newLine = newLine++;
	}
	return ops;
}

function shortestEdits(a: string[], b: string[]): DiffLine[] | null {
	const frontier = new Map<number, number>([[1, 0]]);
	const trace: Map<number, number>[] = [];
	let work = 0;
	for (let d = 0; d <= a.length + b.length; d++) {
		// ponytail: cap trace memory and CPU; huge rewrites use an exact whole-block replacement diff.
		if (d * d > 250_000 || work > 1_000_000) return null;
		trace.push(new Map(frontier));
		for (let k = -d; k <= d; k += 2) {
			const left = frontier.get(k - 1) ?? -1, down = frontier.get(k + 1) ?? -1;
			let x = k === -d || (k !== d && left < down) ? down : left + 1;
			let y = x - k;
			while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; work++; }
			frontier.set(k, x);
			work++;
			if (x >= a.length && y >= b.length) return backtrack(trace, a, b);
		}
	}
	return null;
}

function backtrack(trace: Map<number, number>[], a: string[], b: string[]): DiffLine[] {
	const out: DiffLine[] = [];
	let x = a.length, y = b.length;
	for (let d = trace.length - 1; d >= 0; d--) {
		const frontier = trace[d], k = x - y;
		const previousK = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1)) ? k + 1 : k - 1;
		const previousX = frontier.get(previousK) ?? 0, previousY = previousX - previousK;
		while (x > previousX && y > previousY) { out.push({ type: "context", text: a[--x] }); y--; }
		if (d === 0) break;
		if (x === previousX) out.push({ type: "add", text: b[--y] });
		else out.push({ type: "remove", text: a[--x] });
	}
	return out.reverse();
}

function groupHunks(ops: DiffLine[], contextLines: number): DiffHunk[] {
	const changedIndexes = ops.map((op, index) => (op.type === "context" ? -1 : index)).filter((i) => i !== -1);
	if (changedIndexes.length === 0) return [];

	const hunks: DiffHunk[] = [];
	let start = Math.max(0, changedIndexes[0] - contextLines);
	let end = Math.min(ops.length - 1, changedIndexes[0] + contextLines);

	for (const index of changedIndexes.slice(1)) {
		if (index - contextLines <= end + 1) {
			end = Math.min(ops.length - 1, index + contextLines);
			continue;
		}
		hunks.push(makeHunk(ops.slice(start, end + 1)));
		start = Math.max(0, index - contextLines);
		end = Math.min(ops.length - 1, index + contextLines);
	}
	hunks.push(makeHunk(ops.slice(start, end + 1)));
	return hunks;
}

function makeHunk(lines: DiffLine[]): DiffHunk {
	return {
		oldStart: lines.find((l) => l.oldLine !== undefined)?.oldLine ?? 1,
		newStart: lines.find((l) => l.newLine !== undefined)?.newLine ?? 1,
		lines,
	};
}

/** Render a diff as unified text for approval prompts and tool output. */
export function formatDiff(diff: FileDiff, path: string, maxLines = 200): string {
	if (diff.hunks.length === 0) return `${path}: no changes`;
	const out: string[] = [`--- ${path}`, `+++ ${path}`];
	let emitted = 0;
	for (const hunk of diff.hunks) {
		out.push(`@@ -${hunk.oldStart} +${hunk.newStart} @@`);
		for (const line of hunk.lines) {
			if (emitted >= maxLines) {
				out.push(`… diff truncated (+${diff.added} / -${diff.removed} total)`);
				return out.join("\n");
			}
			out.push(`${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`);
			emitted++;
		}
	}
	return out.join("\n");
}
