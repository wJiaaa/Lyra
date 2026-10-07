/**
 * Every lucide icon the app draws is the animated one.
 *
 * `ui/icons/index.ts` re-exports all of lucide under the animated ones, so an icon used for the
 * first time compiles and renders — as the static original, the one icon in its toolbar that doesn't
 * move on hover. Nothing else notices; this does, and names the file that brought it in.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import * as lucide from "lucide-react";
import * as icons from "../../src/ui/icons/index.ts";

const SRC = join(import.meta.dirname, "../../src");

function sources(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) return sources(path);
		return /\.tsx?$/.test(name) ? [path] : [];
	});
}

test("every icon imported from ui/icons is an animated one", () => {
	const lucideExports = lucide as Record<string, unknown>;
	const barrel = icons as Record<string, unknown>;
	const still: string[] = [];
	for (const file of sources(SRC)) {
		for (const match of readFileSync(file, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*icons\/index\.ts"/g)) {
			for (const entry of match[1]!.split(",")) {
				const part = entry.trim();
				if (!part || part.startsWith("type ")) continue;
				const name = part.split(/\s+as\s+/)[0]!;
				// Only lucide's icons: its types, `Icon` and `createLucideIcon` pass through as they are.
				if (name === "Icon" || name === "createLucideIcon" || name === "icons" || !(name in lucideExports)) continue;
				if (barrel[name] === lucideExports[name]) still.push(`${name} (${relative(SRC, file)})`);
			}
		}
	}
	assert.deepEqual(still, [], "these come straight from lucide; add an animated version in ui/icons/animated/ and export it from ui/icons/index.ts");
});
