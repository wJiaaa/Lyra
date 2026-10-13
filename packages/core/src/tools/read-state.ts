import type { ToolContext } from "../types.ts";

export interface FileStamp {
	mtimeMs: number;
	size: number;
}

export interface ReadRecord {
	/** Modification time and size when it was read. Images and extracted documents carry none: they are not editable text. */
	stamp?: FileStamp;
	/**
	 * The last read showed less of the file than it asked for — folded into an outline, or cut at the
	 * line or output cap. Nothing in the file may be changed until a read that names its window, as in
	 * ZCode: which lines were shown is not tracked, only whether the model knows its view is partial.
	 */
	partial?: boolean;
}

function readState(ctx: ToolContext): Map<string, ReadRecord> {
	const existing = ctx.state.get("readFiles");
	if (existing instanceof Map) return existing;
	const fresh = new Map<string, ReadRecord>();
	ctx.state.set("readFiles", fresh);
	return fresh;
}

export function markRead(ctx: ToolContext, path: string, stamp?: FileStamp, partial = false): void {
	readState(ctx).set(path, { stamp: stamp && { mtimeMs: stamp.mtimeMs, size: stamp.size }, partial });
}

/**
 * Changed since the read, as ZCode decides it: a later modification time, in whole milliseconds, or
 * another size. Not a hash of the text — a rewrite to the same size within the same millisecond
 * slips through, and a touch that leaves the text alone still asks for a re-read.
 */
export function changedSince(record: ReadRecord, current: FileStamp): boolean {
	return !record.stamp || Math.floor(current.mtimeMs) > Math.floor(record.stamp.mtimeMs) || current.size !== record.stamp.size;
}

export function readRecord(ctx: ToolContext, path: string): ReadRecord | undefined {
	return readState(ctx).get(path);
}

export function hasRead(ctx: ToolContext, path: string): boolean {
	return readState(ctx).has(path);
}
