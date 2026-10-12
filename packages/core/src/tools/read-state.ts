import { createHash } from "node:crypto";
import type { ToolContext } from "../types.ts";
import { computeDiff } from "./diff.ts";
import { coversChars, mergeCharRanges } from "./long-line.ts";

export interface ReadRecord {
	/** Hash of the text that was read. An edit is refused once the file no longer matches it. */
	version?: string;
	/** Lines whose content the model has seen; they follow their text when an edit shifts them. */
	ranges: [number, number][];
	chars?: Map<number, [number, number][]>;
}

function readState(ctx: ToolContext): Map<string, ReadRecord> {
	const existing = ctx.state.get("readFiles");
	if (existing instanceof Map) return existing;
	const fresh = new Map<string, ReadRecord>();
	ctx.state.set("readFiles", fresh);
	return fresh;
}

export function readVersion(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export function markRead(ctx: ToolContext, path: string, content?: string, from = 1, to?: number): void {
	markReadRanges(ctx, path, content, to === undefined ? [] : [[from, to]]);
}

export function markReadRanges(ctx: ToolContext, path: string, content: string | undefined, added: [number, number][]): void {
	const previous = readRecord(ctx, path);
	const version = content === undefined ? undefined : readVersion(content);
	// Extracted documents and images deliberately carry no editable text version.
	readState(ctx).set(path, {
		version,
		ranges: version && previous?.version === version ? [...previous.ranges, ...added] : [...added],
		chars: version && previous?.version === version ? previous.chars : undefined,
	});
}

export function markReadChars(ctx: ToolContext, path: string, line: number, from: number, to: number, lineLength: number): void {
	const record = readRecord(ctx, path);
	if (!record) return;
	if (from <= 1 && to >= lineLength) {
		record.chars?.delete(line);
		return;
	}
	const chars = record.chars ?? new Map<number, [number, number][]>();
	chars.set(line, mergeCharRanges([...(chars.get(line) ?? []), [from, to]]));
	record.chars = chars;
}

export function readRecord(ctx: ToolContext, path: string): ReadRecord | undefined {
	return readState(ctx).get(path);
}

export function hasRead(ctx: ToolContext, path: string): boolean {
	return readState(ctx).has(path);
}

export function wasShown(record: Pick<ReadRecord, "ranges">, from: number, to: number): boolean {
	for (let line = from; line <= to; line++) {
		if (!record.ranges.some(([a, b]) => line >= a && line <= b)) return false;
	}
	return true;
}

export function wasShownChars(record: ReadRecord, line: number, from: number, to: number): boolean {
	if (!wasShown(record, line, line)) return false;
	const windows = record.chars?.get(line);
	return !windows || coversChars(windows, from, to);
}

/** Visibility follows surviving lines to their new numbers; lines the edit wrote count as seen, since the model wrote them. */
export function markEdited(ctx: ToolContext, path: string, before: string, after: string): void {
	const record = readRecord(ctx, path)!;
	const ranges: [number, number][] = [];
	const chars = new Map<number, [number, number][]>();
	originsFromDiff(before, after).forEach((origin, i) => {
		if (origin && !wasShown(record, origin, origin)) return;
		const window = record.chars?.get(origin);
		if (window) chars.set(i + 1, window);
		append(ranges, i + 1);
	});
	readState(ctx).set(path, { version: readVersion(after), ranges, chars });
}

/** Index = line in the new text, value = its line in the old text; 0 for a line the edit wrote. */
function originsFromDiff(before: string, after: string): number[] {
	const count = after === "" ? 0 : after.split("\n").length - Number(after.endsWith("\n"));
	const origins = Array<number>(count).fill(0);
	for (const hunk of computeDiff(before, after, Number.MAX_SAFE_INTEGER).hunks) {
		for (const line of hunk.lines) {
			if (line.type === "context" && line.newLine && line.oldLine) origins[line.newLine - 1] = line.oldLine;
		}
	}
	return origins;
}

function append(ranges: [number, number][], line: number): void {
	const last = ranges.at(-1);
	if (last && last[1] === line - 1) last[1] = line;
	else ranges.push([line, line]);
}
