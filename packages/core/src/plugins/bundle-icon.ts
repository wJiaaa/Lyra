/**
 * The icon a bundle ships with itself, read off the disk.
 *
 * The rules for where to look and what counts as a picture are in `@plume/registry-shared`, because
 * the platform applies the same ones to the archive it builds. If they ever disagree, a bundle
 * wears one mark in the catalogue and a different one after it is installed — which is the same
 * class of bug as the catalogue calling something a plugin that installs as an MCP server, and the
 * reason those rules are in the contract package rather than in either side.
 *
 * Read as a `data:` URL rather than a path. The renderer is where a mark is drawn and it cannot
 * open a file: `img-src` is `self data: blob:` and stays that way, and every other picture in this
 * app already arrives the same way — see `remoteImage`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { acceptIcon, iconCandidates } from "@plume/registry-shared";

/**
 * How large an icon may be before it is left on disk.
 *
 * Far below the 1MB the platform accepts, and the difference is where the bytes end up: there an
 * icon is an object in a bucket fetched by whoever looks at that one entry, here it is base64 in an
 * IPC message sent for *every* installed bundle on every scan. Twenty bundles at the platform's
 * ceiling would be 27MB crossing the process boundary to draw twenty 32px tiles.
 *
 * An icon past this is not a picture that failed to load; it is one that should have been saved
 * smaller, and the bundle still gets the mark for its kind.
 */
const MAX_INLINE_BYTES = 128 * 1024;

/**
 * A bundle's own icon as a data URL, or undefined.
 *
 * `declared` is `interface.logo` from the manifest. A remote URL is not this function's business —
 * it stays in the manifest and is fetched by the main process — and a relative path that climbs out
 * of the bundle returns nothing rather than falling through to a guessed file.
 */
export async function readBundleIcon(dir: string, declared?: string): Promise<string | undefined> {
	for (const candidate of iconCandidates(declared)) {
		const data = await readFile(join(dir, candidate)).catch(() => null);
		if (!data || data.length > MAX_INLINE_BYTES) continue;
		const accepted = acceptIcon(candidate, data);
		if (!accepted) continue;
		return `data:${accepted.contentType};base64,${data.toString("base64")}`;
	}
	return undefined;
}
