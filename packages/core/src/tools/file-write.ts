import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import { lstat, mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolContext } from "../types.ts";
import { recordFileChange } from "./file-changes.ts";
import { resolveFilePath } from "./paths.ts";

const writes = new Map<string, Promise<unknown>>();
interface TextFile {
	path: string;
	before: string | null;
	write(content: string): Promise<string | undefined>;
}

/** Read, approve and write under the same process-wide file queue, shared by edit and write. */
export async function withTextFile<T>(ctx: ToolContext, input: string, action: (file: TextFile) => Promise<T>): Promise<T> {
	const path = await resolveFilePath(ctx.cwd, input);
	const initial = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	// Paths cover creation; inode identity also serializes edits through different hard links.
	const keys = [path, ...(initial ? [`${initial.dev}:${initial.ino}`] : [])];
	const previous = keys.map((key) => writes.get(key)?.catch(() => {}));
	const run = Promise.all(previous).then(async () => {
		ctx.signal?.throwIfAborted();
		let handle: FileHandle | undefined;
		const changed = () => new Error("The file changed before writing. Read it again before editing.");
		try {
			let before: string | null = null;
			if (initial) {
				if (!initial.isFile()) throw new Error("Only regular UTF-8 text files can be edited.");
				handle = await open(path, constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
				const current = await handle.stat();
				if (current.dev !== initial.dev || current.ino !== initial.ino) throw changed();
				const bytes = await handle.readFile();
				if (!isUtf8(bytes) || bytes.includes(0)) throw new Error("Only UTF-8 text files can be edited; this file contains binary data.");
				before = bytes.toString("utf8");
			}
			return await action({ path, before, write: async (content) => {
				ctx.signal?.throwIfAborted();
				const changeId = await recordFileChange(ctx, path, before, content);
				// Revalidate after approval and recording, before the first destructive operation.
				if (await resolveFilePath(ctx.cwd, input) !== path) throw changed();
				if (handle) {
					const current = await lstat(path), opened = await handle.stat();
					if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || await readFile(path, "utf8") !== before) throw changed();
				} else {
					await mkdir(dirname(path), { recursive: true });
					if (await realpath(dirname(path)) !== dirname(path)) throw changed();
					// Exclusive creation cannot overwrite a file that appeared while approval was pending.
					handle = await open(path, "wx");
				}
				ctx.signal?.throwIfAborted();
				const bytes = Buffer.from(content, "utf8");
				try {
					// Keep the inode (including hard links and permissions), and handle short writes explicitly.
					await handle.truncate(0);
					let offset = 0;
					while (offset < bytes.length) {
						const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
						if (!bytesWritten) throw new Error("No bytes were written.");
						offset += bytesWritten;
					}
				} catch (error) {
					throw new Error("The write failed after it started; the file may be incomplete. Read it again before retrying.", { cause: error });
				}
				const visible = await lstat(path), written = await handle.stat();
				if (visible.isSymbolicLink() || visible.dev !== written.dev || visible.ino !== written.ino) {
					throw new Error("The file path changed during writing; the visible result is unknown. Read it again.");
				}
				return changeId;
			} });
		} finally { await handle?.close(); }
	});
	for (const key of keys) writes.set(key, run);
	try { return await run; }
	finally { for (const key of keys) if (writes.get(key) === run) writes.delete(key); }
}
