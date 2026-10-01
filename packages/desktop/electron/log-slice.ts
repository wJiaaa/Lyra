import { open } from "node:fs/promises";

/** One read's worth: a quiet build fits in one, a chatty dev server catches up over a few polls. */
const LOG_SLICE = 256 * 1024;

/**
 * Part of a growing log file, from byte `from`.
 *
 * The log is the whole output, where `job.output` is clipped to head and tail. Asking from -1 skips
 * to the last slice and starts on a line, so opening a server that has logged for an hour does not
 * replay the hour. A read never ends inside a multi-byte character: the bytes it leaves are where
 * `next` points, and the next read starts with them.
 */
export async function readLogSlice(path: string, from: number, limit = LOG_SLICE): Promise<{ text: string; next: number; atEnd: boolean }> {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		const start = from < 0 || from > size ? Math.max(0, size - limit) : from;
		const length = Math.min(limit, size - start);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		let end = utf8Boundary(buffer, bytesRead);
		let begin = 0;
		if (start > 0 && from < 0) {
			const newline = buffer.indexOf(10);
			begin = newline >= 0 && newline < end ? newline + 1 : 0;
		}
		if (end < begin) end = begin;
		return { text: buffer.toString("utf8", begin, end), next: start + end, atEnd: start + end >= size };
	} finally {
		await handle.close();
	}
}

/** Where the bytes stop being whole characters: a read can end inside a multi-byte one. */
function utf8Boundary(buffer: Buffer, length: number): number {
	for (let back = 1; back <= 3 && back <= length; back++) {
		const byte = buffer[length - back]!;
		if ((byte & 0xc0) === 0x80) continue;
		const needs = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return needs > back ? length - back : length;
	}
	return length;
}
