/**
 * Editing a file by exact text replacement.
 *
 * This used to be a line-number patch (`REPLACE 7-9` under a tag from `read`), with the string
 * form kept as "legacy". The patch form made the smallest change the most expensive one: swapping
 * one word meant retyping the whole line, and on prose stored one paragraph per line that is over a
 * thousand characters to copy exactly — in Terminal-Bench's overfull-hbox the model wrote a script
 * to apply its word swaps rather than do that. Every other harness we compared (pi, maka, ZCode,
 * opencode, Claude Code) edits by text. Why the earlier measurement no longer decides it:
 * docs/adr/0046-edit-by-text.md.
 *
 * What kept the line form safe still holds here: the file must have been read and must not have
 * changed since, the match must be exact and unique, and the text replaced must sit in what the
 * model was shown.
 */

import { errorResult } from "./result.ts";
import type { Tool, ToolResult } from "../types.ts";
import { withTextFile } from "./file-write.ts";
import { computeDiff, formatDiff, type FileDiff } from "./diff.ts";
import { formatCharWindow, indexToLineCol, MAX_LINE_CHARS } from "./long-line.ts";
import { displayPath, resolveWorkspacePath } from "./paths.ts";
import { markEdited, markReadRanges, readRecord, readVersion, wasShownChars, type ReadRecord } from "./read-state.ts";
import { decodeInput, decodeText, encodeText } from "./text-layout.ts";

interface EditArgs {
	path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export const editTool: Tool<EditArgs> = {
	name: "edit",
	approvalKind: "edit",
	description:
		"Replace exact text in a file. `old_string` must match the file exactly, whitespace and indentation included, and be unique unless `replace_all` is set. " +
		"Keep `old_string` as small as possible while still unique: when only a word changes, a few words around it are enough, even on a long line. " +
		"Read the file before editing it; if it changed since, the edit is refused — re-read and redo it. " +
		"For several separate changes, send several edit calls in one response.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path, absolute or relative to the workspace root." },
			old_string: { type: "string", description: "The exact text to replace." },
			new_string: { type: "string", description: "The text to put in its place." },
			replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
		},
		required: ["path", "old_string", "new_string"],
		additionalProperties: false,
	},
	mutating: true,
	executionMode: "sequential",
	summarize: (args) => `Edit ${args.path}`,

	async execute(args, ctx): Promise<ToolResult> {
		// 不吃 `ctx.allowedPaths`，理由见 `write.ts` 里同一处的注释：附件是「给你看」，不是「可以改」。
		if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
			return errorResult("`old_string` and `new_string` must both be strings.");
		}
		try {
			return await withTextFile(ctx, args.path, async ({ path: absolute, before: raw, write }) => {
				const record = readRecord(ctx, absolute);
				if (!record?.version) return errorResult(`Read ${args.path} as text before editing it.`);
				if (raw === null) return errorResult(`File not found: ${args.path}`);
				const { text: before, layout } = decodeText(raw);
				if (record.version !== readVersion(before)) return errorResult(`The file changed since you read it. Re-read ${args.path} before editing.`);

				if (args.old_string === "") return errorResult("`old_string` is empty. To fill an empty file or replace a whole file, use `write`.");
				const oldString = decodeInput(args.old_string, layout);
				const newString = decodeInput(args.new_string, layout);
				if (oldString === newString) return errorResult("`old_string` and `new_string` are identical, so this edit would do nothing.");

				const occurrences = countOccurrences(before, oldString, Boolean(args.replace_all));
				if (occurrences === 0) {
					return errorResult(
						`\`old_string\` was not found in ${args.path}. It must match exactly, including whitespace and indentation — copy it from what read showed, without the line-number prefix.`,
					);
				}
				if (occurrences > 1 && !args.replace_all) {
					return errorResult(`\`old_string\` appears ${occurrences} times in ${args.path}. Include more of the surrounding text to make it unique, or set replace_all: true.`);
				}
				if (!spanShown(record, before, oldString, Boolean(args.replace_all))) {
					return errorResult(revealUnread(record, before, oldString, args.path));
				}

				const after = args.replace_all ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
				const count = args.replace_all ? occurrences : 1;
				const diff = computeDiff(before, after);
				const shown = displayPath(ctx.cwd, resolveWorkspacePath(ctx.cwd, args.path));

				if (ctx.requestApproval) {
					const decision = await ctx.requestApproval({
						kind: "edit",
						title: `Edit ${shown}`,
						detail: formatDiff(diff, shown),
						subject: absolute,
					});
					if (decision !== "once" && decision !== "always") return errorResult("The user rejected this edit.");
				}

				const changeId = await write(encodeText(after, layout));
				markEdited(ctx, absolute, before, after);
				// One line of context, not the preview's three: the echo is there to spare a re-read, not to review the change.
				const view = changedView(computeDiff(before, after, 1), after);
				markReadRanges(ctx, absolute, after, view.ranges);

				return {
					content: [
						{
							type: "text",
							text: `Edited ${shown}: ${count} replacement${count === 1 ? "" : "s"}, +${diff.added} -${diff.removed}.${view.text}`,
						},
					],
					details: {
						kind: "edit",
						changeId,
						path: shown,
						added: diff.added,
						removed: diff.removed,
						hunks: diff.hunks,
					},
				};
			});
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	},
};

/** Above this many lines the echo costs more than the re-read it saves; the line ranges alone are given. */
const MAX_ECHO_LINES = 60;

/**
 * The changed regions as they now read.
 *
 * Without an echo the model re-read the file after almost every edit: in the session history 71 of
 * 154 successful edits were followed straight away by a read of the same file — a round trip each,
 * resending the whole conversation, to learn what this result already knows.
 *
 * A line too long to show whole is windowed like `read` does and left unmarked: replacing text
 * outside the window still needs `char_offset`.
 */
function changedView(diff: FileDiff, after: string): { text: string; ranges: [number, number][] } {
	const lines = after.endsWith("\n") ? after.slice(0, -1).split("\n") : after.split("\n");
	const blocks = diff.hunks.map((hunk) => hunk.lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine])));
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	if (total === 0) return { text: "", ranges: [] };
	if (total > MAX_ECHO_LINES) {
		const spans = blocks.filter((block) => block.length).map((block) => `${block[0]}-${block.at(-1)}`);
		return { text: `\nChanged regions now at lines ${spans.join(", ")}.`, ranges: [] };
	}
	const width = String(Math.max(...blocks.flat())).length;
	const ranges: [number, number][] = [];
	const rendered = blocks.map((block) =>
		block
			.map((lineNo) => {
				const text = lines[lineNo - 1] ?? "";
				if (text.length <= MAX_LINE_CHARS) ranges.push([lineNo, lineNo]);
				return `${String(lineNo).padStart(width, " ")}→${text.length <= MAX_LINE_CHARS ? text : formatCharWindow(text)}`;
			})
			.join("\n"),
	);
	return { text: `\nNow reads:\n${rendered.join("\n     ⋯\n")}`, ranges };
}

function matchesOf(haystack: string, needle: string): number[] {
	const hits: number[] = [];
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) hits.push(at);
	return hits;
}

/** A unique replacement needs its one match shown; `replace_all` needs every match shown. */
function spanShown(record: ReadRecord, before: string, needle: string, all: boolean): boolean {
	const shown = (at: number) => {
		const { line, col } = indexToLineCol(before, at);
		return wasShownChars(record, line, col, col + needle.length - 1);
	};
	const hits = matchesOf(before, needle);
	return all ? hits.every(shown) : hits.some(shown);
}

const MAX_REVEAL_LINES = 40;

/**
 * Text the model never saw — inside a folded outline body, say — is shown in the rejection and
 * counted as seen, so the retry is the same call instead of a read and then the call.
 */
function revealUnread(record: ReadRecord, before: string, needle: string, path: string): string {
	const lines = before.split("\n");
	const spans: number[] = [];
	for (const at of matchesOf(before, needle)) {
		const first = indexToLineCol(before, at).line;
		const last = indexToLineCol(before, at + needle.length - 1).line;
		for (let line = first; line <= last; line++) if (!spans.includes(line)) spans.push(line);
	}
	if (spans.length > MAX_REVEAL_LINES || spans.some((line) => (lines[line - 1] ?? "").length > MAX_LINE_CHARS)) {
		return `\`old_string\` sits in a part of ${path} you have not read. Read that span with char_offset before replacing it.`;
	}
	for (const line of spans) record.ranges.push([line, line]);
	const width = String(spans.at(-1)).length;
	const shown = spans.map((line) => `${String(line).padStart(width, " ")}→${lines[line - 1]}`).join("\n");
	return `\`old_string\` sits in lines of ${path} you have not read. They read:\n${shown}\nIf that is the text you meant to replace, send the same edit again.`;
}

function countOccurrences(haystack: string, needle: string, replaceAll: boolean): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		// Uniqueness includes overlapping matches; replace_all consumes non-overlapping matches.
		index = haystack.indexOf(needle, index + (replaceAll ? needle.length : 1));
	}
	return count;
}
