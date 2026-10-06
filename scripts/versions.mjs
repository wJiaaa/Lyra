/**
 * Every place the version number is written down.
 *
 * AGENTS.md used to say "版本号在 6 个 package.json 里，要一起改", and the count drifted every time a
 * package came or went. A list nobody can forget to extend is the point of putting it here rather
 * than in a sentence.
 *
 * Internal dependencies use `workspace:*` and are unaffected.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The file that decides; everything else is made to agree with it. */
export const SOURCE = "package.json";

export const MANIFESTS = [
	"package.json",
	"packages/core/package.json",
	"packages/cli/package.json",
	"packages/desktop/package.json",
	"packages/contract/package.json",
	"packages/registry-shared/package.json",
];

export async function readVersion(relative) {
	return JSON.parse(await readFile(join(ROOT, relative), "utf8")).version;
}

/**
 * Rewrite one version string, leaving the rest of the file byte-identical.
 *
 * A regex rather than `JSON.parse` + `stringify`: these files are hand-formatted — two-space here,
 * tab there — and re-serialising one turns a one-line change into a whole-file diff that hides it.
 */
export async function writeVersion(relative, version) {
	const path = join(ROOT, relative);
	const text = await readFile(path, "utf8");
	const pattern = /("version"\s*:\s*")([^"]+)(")/;
	if (!pattern.test(text)) throw new Error(`${relative} 里找不到 version 字段`);
	await writeFile(path, text.replace(pattern, `$1${version}$3`));
}
