import { createHash } from "node:crypto";
import type { ToolContext } from "../types.ts";
import { snapshotTag, type Hunk } from "./hunk.ts";
import { coversChars, mergeCharRanges } from "./long-line.ts";

export interface ReadRecord {
	tag: string;
	/** The short model-facing tag is not enough to detect collisions or bind an edit to a read. */
	version?: string;
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
		tag: content === undefined ? "" : snapshotTag(content),
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

export function wasShown(record: ReadRecord, from: number, to: number): boolean {
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

/** Move visibility along with the original lines; only supplied replacement lines become visible. */
export function markEdited(ctx: ToolContext, path: string, before: string, after: string, hunks?: Hunk[]): void {
	const record = readRecord(ctx, path)!;
	const count = before === "" ? 0 : before.split("\n").length - Number(before.endsWith("\n"));
	const known = Array.from({ length: count }, (_, i) => wasShown(record, i + 1, i + 1));
	const windows = Array.from({ length: count }, (_, i) => record.chars?.get(i + 1));
	if (!hunks) {
		// A legacy replacement has no line map. A partial reader must re-read before using line patches.
		markRead(ctx, path, after, 1, known.every(Boolean) ? after.split("\n").length : undefined);
		return;
	}
	const anchor = (h: Hunk) => h.op === "insert" ? h.after + 0.5 : h.start;
	for (const h of [...hunks].sort((a, b) => anchor(b) - anchor(a))) {
		const start = h.op === "insert" ? h.after : h.start - 1;
		const removed = h.op === "insert" ? 0 : h.end - h.start + 1;
		known.splice(start, removed, ...Array<boolean>(h.op === "delete" ? 0 : h.lines.length).fill(true));
		windows.splice(start, removed, ...Array<[number, number][] | undefined>(h.op === "delete" ? 0 : h.lines.length).fill(undefined));
	}
	const ranges: [number, number][] = [];
	const chars = new Map<number, [number, number][]>();
	for (let i = 0; i < known.length; i++) {
		if (!known[i]) continue;
		const window = windows[i];
		if (window) chars.set(i + 1, window);
		const last = ranges.at(-1);
		if (last && last[1] === i) last[1] = i + 1;
		else ranges.push([i + 1, i + 1]);
	}
	readState(ctx).set(path, { tag: snapshotTag(after), version: readVersion(after), ranges, chars });
}
