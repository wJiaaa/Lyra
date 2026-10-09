/**
 * Replacing the app with a newer copy of itself.
 *
 * This is the one piece of the update that can leave a machine with no working application, so it
 * is tested rather than trusted: the swap runs in a detached shell script after the process is
 * gone, which is exactly the situation where nobody is watching and nothing can be reported.
 *
 * Real directories standing in for bundles, and a stub `open` on PATH — so the script runs
 * verbatim, including the rollback, without needing an actual .app or launching anything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installedAppBundle, swapScript } from "../electron/ipc/install-update.ts";

const run = promisify(execFile);

/**
 * A stand-in `open` on PATH, so the script's last line can be observed instead of launching
 * anything. Returns the environment to run the script with, and where it records what it opened.
 */
async function stubOpen(root: string): Promise<{ env: NodeJS.ProcessEnv; opened: string }> {
	const bin = join(root, "bin");
	const opened = join(root, "opened.txt");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "open"), `#!/bin/bash\necho "$@" > ${JSON.stringify(opened)}`, { mode: 0o755 });
	return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, opened };
}

/** A pid that is certainly gone, so the script's wait loop falls straight through. */
const DEPARTED = 999999;

/**
 * The swap runs a bash script and uses `ditto`, so these only mean anything on macOS.
 *
 * Skipped rather than made portable: this is the macOS install path specifically — the other
 * platforms hand their installer to the OS and have nothing of this shape to test. Windows CI
 * caught them within two minutes of being written, which is the whole reason it is in the matrix.
 */
const macOnly = { skip: process.platform === "darwin" ? false : "只在 macOS 上有这条更新路径" };

test("the bundle to replace is worked out from the running executable", () => {
	assert.equal(installedAppBundle("/Applications/Plume.app/Contents/MacOS/Plume"), "/Applications/Plume.app");
	assert.equal(installedAppBundle("/Users/me/Desktop/Plume.app/Contents/MacOS/Plume"), "/Users/me/Desktop/Plume.app");
	assert.equal(installedAppBundle("/usr/local/bin/plume"), null, "not a bundle at all");
});

/**
 * The one that actually happened: an update pressed while running `pnpm dev` replaced Electron's
 * prebuilt runtime inside `node_modules` with the packaged release, because this repository renames
 * that bundle to `Plume.app` and the path shape is then indistinguishable from an install.
 */
test("a development runtime inside node_modules is never treated as the installed app", () => {
	assert.equal(
		installedAppBundle("/Users/me/code/Plume/node_modules/.pnpm/electron@43.3.0/node_modules/electron/dist/Plume.app/Contents/MacOS/Plume"),
		null,
	);
});

test("the new copy goes in, the old one is cleared away, and the app is launched again", macOnly, async () => {
	const root = await mkdtemp(join(tmpdir(), "swap-test-"));
	const target = join(root, "Plume.app");
	const staged = join(root, "new", "Plume.app");
	await mkdir(join(target, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(target, "Contents", "MacOS", "Plume"), "OLD");
	await mkdir(join(staged, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(staged, "Contents", "MacOS", "Plume"), "NEW");

	const { env, opened } = await stubOpen(root);
	const script = join(root, "swap.sh");
	await writeFile(script, swapScript({ pid: DEPARTED, staged, target, backup: `${target}.old` }), { mode: 0o755 });
	await run("/bin/bash", [script], { env });

	assert.equal(await readFile(join(target, "Contents", "MacOS", "Plume"), "utf8"), "NEW", "新版本已就位");
	assert.equal(await stat(`${target}.old`).catch(() => null), null, "备份已清掉");
	assert.ok((await readFile(opened, "utf8")).includes("Plume.app"), "重新拉起了应用");
	await rm(root, { recursive: true, force: true });
});

test("an install that fails puts the old app back rather than leaving nothing", macOnly, async () => {
	const root2 = await mkdtemp(join(tmpdir(), "swap-fail-"));
	const target2 = join(root2, "Plume.app");
	await mkdir(join(target2, "Contents"), { recursive: true });
	await writeFile(join(target2, "Contents", "marker"), "OLD");
	const { env } = await stubOpen(root2);
	const script2 = join(root2, "swap.sh");
	await writeFile(
		script2,
		swapScript({ pid: DEPARTED, staged: join(root2, "does-not-exist.app"), target: target2, backup: `${target2}.old` }),
		{ mode: 0o755 },
	);
	await run("/bin/bash", [script2], { env }).catch(() => {});

	assert.equal(await readFile(join(target2, "Contents", "marker"), "utf8"), "OLD", "装不上时旧版本被放了回去");
	await rm(root2, { recursive: true, force: true });
});
