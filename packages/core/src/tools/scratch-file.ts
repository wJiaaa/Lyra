import { scratchTarget } from "../resources/handlers.ts";
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
