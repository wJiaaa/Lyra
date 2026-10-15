import { scratchTarget, skillTarget } from "../resources/handlers.ts";
import { parseResourceUrl } from "../resources/router.ts";
import type { ToolContext } from "../types.ts";

/**
 * `scratch://x` as the file it names on disk, or null for anything else.
 *
 * `read` and `edit` must agree on which file an address is, because the read-before-edit record is
 * keyed by that file. They did not: `read` went through the address handler and recorded nothing,
 * `edit` resolved the address as a relative path (`<project>/scratch:/x`), and every edit of a
 * scratch file failed with "read it first" — re-reading did not help, only switching to the
 * absolute path did. A ranged address (`scratch://x:10-40`) stays an address: it is a slice, not a file.
 */
export async function scratchFile(ctx: ToolContext, input: string): Promise<string | null> {
	if (!ctx.resources?.canResolve(input)) return null;
	const url = parseResourceUrl(input);
	if (url?.scheme !== "scratch" || url.range) return null;
	// The literal path, not its realpath: the tools canonicalize it themselves, after a boundary check that compares spellings.
	return scratchTarget(url, { cwd: ctx.cwd, sessionId: ctx.sessionId, scratchDir: ctx.scratchDir, state: ctx.state });
}

/**
 * `skill://<name>/<path>` as the path it names on disk, or null for anything else.
 *
 * Not folded into `scratchFile`: `edit` and `write` take that one, and a skill must stay read-only.
 * Only `ls` needs this — without it `ls skill://x/references` was joined onto the workspace as
 * `<cwd>/skill:/x/references` and reported "not found" for a directory that exists.
 */
export async function skillPath(ctx: ToolContext, input: string): Promise<string | null> {
	if (!ctx.resources?.canResolve(input)) return null;
	const url = parseResourceUrl(input);
	// A bare `skill://` is the index of skills, which is not a directory on disk.
	if (url?.scheme !== "skill" || url.range || url.segments.length === 0) return null;
	const { target } = await skillTarget(url, { cwd: ctx.cwd, sessionId: ctx.sessionId, scratchDir: ctx.scratchDir, state: ctx.state });
	return target;
}
