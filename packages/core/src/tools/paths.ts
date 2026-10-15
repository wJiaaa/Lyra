import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { scratchHome } from "../runtime/previews.ts";
import { plumeHome } from "../session/store.ts";
import { home } from "../platform.ts";

function contains(root: string, absolute: string): boolean {
	const rel = relative(resolve(root), absolute);
	return rel === "" || !(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel));
}

/**
 * Resolve a path the model wants to **write**, refusing only Plume's own data directory.
 *
 * Outside the workspace is not refused here: it is asked about, by the approval the tool already
 * requests (`assessWrite` flags `write-outside-project`). It used to be refused outright, and a
 * user who said "save it to my Desktop" got the model reaching for `cat > ~/Desktop/… <<EOF`
 * instead — which also writes there, only with no diff on the card, no read-before-write check
 * and no change record. A refusal the shell does not share is not a boundary; it is a detour.
 *
 * `~/.plume` stays shut, the scratch subtree aside: it holds settings (the permission mode among
 * them), credentials, transcripts and installed skills, and a write tool that could reach them
 * could rewrite its own permissions in one call that looks like any other. The scratch subtree
 * is open because the system prompt sends the model there for anything that should not end up
 * in the user's repository; refusing it once sent the model to an MCP filesystem server instead.
 * A workspace that itself lives under `~/.plume` is still writable.
 *
 * Attachments (`ToolContext.allowedPaths`) are still not consulted: dragging a file into the
 * conversation says "look at this", not "you may overwrite it", so a write to it asks like any
 * other path outside the workspace.
 */
export function resolveWorkspacePath(cwd: string, input: string): string {
	if (!input || typeof input !== "string") throw new Error("A path is required.");
	// 与读取侧同一套写法解析：以前这里只认 `~/`，Windows 上 `/c/…`、`~\` 读得到、写却报越界。
	const absolute = toAbsolute(cwd, input);
	if (writable([cwd], plumeHome(), absolute)) return absolute;
	throw new Error(`${input} is inside Plume's own data directory, which file tools do not write. Tell the user what to change there instead of changing it another way.`);
}

/** Anywhere but the app's home — unless it is the workspace itself or the scratch subtree. */
function writable(roots: string[], appHome: string, absolute: string): boolean {
	return !contains(appHome, absolute) || [...roots, scratchHome(appHome)].some((root) => contains(root, absolute));
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

/** Canonicalize existing parents too, so aliases share a lock and a link cannot reach what the literal path may not. */
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
	const appHome = plumeHome();
	const [root, realHome] = await Promise.all([canonical(cwd), canonical(appHome)]);
	if (!writable([root], realHome, target)) {
		throw new Error(`${input} links into Plume's own data directory, which file tools do not write.`);
	}
	/*
	 * A link that looks like it is in the workspace and lands outside it is still refused. The
	 * approval card names the path as written, so it would read "Edit notes.md" over a change to
	 * whatever the link points at. Writing the target by its own name asks with that name instead.
	 */
	const near = [cwd, scratchHome(appHome)].some((place) => contains(place, absolute));
	if (near && ![root, scratchHome(realHome)].some((place) => contains(place, target))) {
		throw new Error(`${input} is a link to ${target}, outside the workspace. Write ${target} by that path instead, so the approval names what changes.`);
	}
	return target;
}

/**
 * 给模型看的路径：相对工作区根，出了工作区写绝对路径。`read`/`edit` 按工作区根解析相对路径，
 * 所以 `grep`/`glob` 报出来的也必须这样写——相对搜索目录写过一次，`path: "src"` 搜出的
 * `pages/a.tsx` 拿去读就是 File not found。
 */
export function displayPath(cwd: string, absolute: string): string {
	const rel = relative(cwd, absolute);
	if (rel === "") return ".";
	// `..x/a.ts` 是工作区里一个以 `..` 开头的目录，不是上一级。
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return absolute;
	return rel.split(sep).join("/");
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
