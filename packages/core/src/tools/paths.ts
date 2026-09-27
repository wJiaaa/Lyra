import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scratchHome } from "../runtime/previews.ts";
import { lyraHome } from "../session/store.ts";
import { home } from "../platform.ts";

function contains(root: string, absolute: string): boolean {
	const rel = relative(resolve(root), absolute);
	return rel === "" || !(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel));
}

/**
 * Resolve a path the model wants to **write** and refuse anything that escapes the workspace.
 *
 * The model is not trusted to stay inside the workspace: `../../.ssh/id_rsa` is a normal-looking
 * argument. `write` and `edit` route through here so the containment check exists once.
 *
 * Reading is a different question and is asked elsewhere, in `read-access.ts`: a read outside the
 * workspace is put to the user, because refusing one they could obviously grant is what taught the
 * model to go around the file tools with `cat`. A write is not offered that way — the tools that
 * change files stay inside the project, full stop. The asymmetry is the point, and it is why the
 * attachment set (`ToolContext.allowedPaths`) is honoured over there and has no parameter here:
 * dragging a file into the conversation says "look at this", not "you may overwrite it".
 *
 * The scratch directory is the one exception, because the system prompt sends the model there
 * for anything that should not end up in the user's repository. Refusing it would be telling the
 * model to write somewhere and then stopping it — which is exactly what happened before this,
 * and what it worked around by reaching for an MCP filesystem server instead. Only the scratch
 * subtree is opened up: `~/.lyra` itself still holds settings and transcripts, and stays shut.
 */
export function resolveWorkspacePath(cwd: string, input: string): string {
	if (!input || typeof input !== "string") throw new Error("A path is required.");
	// 与读取侧同一套写法解析：以前这里只认 `~/`，Windows 上 `/c/…`、`~\` 读得到、写却报越界。
	const absolute = toAbsolute(cwd, input);
	if (contains(cwd, absolute) || contains(scratchHome(lyraHome()), absolute)) return absolute;
	throw new Error(`Path escapes the workspace root (${cwd}): ${input}`);
}

/** `~/x` as an absolute path, and anything already absolute resolved against the session's cwd. */
export function toAbsolute(cwd: string, input: string): string {
	const native = process.platform === "win32" ? windowsSpelling(input, home(), tmpdir()) : input;
	const expanded = native.startsWith("~/") || native === "~" ? native.replace("~", home()) : native;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * A path as a Windows shell spelled it, as the Windows path it names.
 *
 * On Windows the agent's commands run in Git Bash, which reads `/c/Users/me` as `C:\Users\me` and
 * `/tmp` as the user's temp directory. Node reads the same strings as `C:\c\Users\me` and `C:\tmp`
 * — paths that do not exist, and a path that does not exist is not asked about (`worthAsking`).
 * So `cat /c/Users/me/.ssh/id_ed25519` read the key without a question. `~\` is PowerShell's
 * spelling of the home directory, which only `~/` was expanded for.
 *
 * Pure, with the home and temp directories handed in, so it can be tested on any platform.
 */
export function windowsSpelling(input: string, homeDir: string, tempDir: string): string {
	const drive = /^(?:\/cygdrive)?\/([a-zA-Z])(?=\/|$)(.*)$/.exec(input);
	if (drive) return `${drive[1].toUpperCase()}:\\${drive[2].replace(/^\//, "").replaceAll("/", "\\")}`;
	const temp = /^\/tmp(?=\/|$)(.*)$/.exec(input);
	if (temp) return `${tempDir}${temp[1].replaceAll("/", "\\")}`;
	if (input === "~" || input.startsWith("~\\")) return `${homeDir}${input.slice(1)}`;
	return input;
}

/** Canonicalize existing parents too, so aliases share a lock and a missing leaf cannot hide an escape. */
export async function resolveFilePath(
	cwd: string,
	input: string,
): Promise<string> {
	const absolute = resolveWorkspacePath(cwd, input);
	const canonical = async (path: string): Promise<string> => {
		try { return await realpath(path); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
			return resolve(await canonical(dirname(path)), basename(path));
		}
	};
	const target = await canonical(absolute);
	const roots = await Promise.all([canonical(cwd), canonical(scratchHome(lyraHome()))]);
	if (!roots.some((root) => contains(root, target))) {
		throw new Error(`Path escapes the workspace root through a symbolic link: ${input}`);
	}
	return target;
}

export function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute);
	return rel === "" ? "." : rel.startsWith("..") ? absolute : rel;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function imageMimeType(path: string): string | null {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return null;
	return IMAGE_EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

/** Heuristic: a NUL byte in the first 8 KiB means the file is not text. */
export function looksBinary(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 8192);
	for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
	return false;
}
