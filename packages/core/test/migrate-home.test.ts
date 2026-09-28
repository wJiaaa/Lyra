/**
 * Carrying the old home over.
 *
 * The rename is a one-way door for someone's data: get this wrong and every session, every
 * setting and the API keys look deleted. So the rules are pinned down — move exactly once, never
 * when it would be ambiguous, and never fail hard.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migratePreviousHome } from "../src/session/migrate-home.ts";

/**
 * The old home is looked up from the real home directory, so these tests point that somewhere
 * temporary — which is also the one thing that makes them safe to run on a machine that has one.
 *
 * Both variables, because `os.homedir()` does not read the same one everywhere: `HOME` on Unix,
 * `USERPROFILE` on Windows. Setting only `HOME` left Windows looking at the actual user's home
 * directory, where there is no `.deepwise` — so the migration correctly reported that it had
 * nothing to do, and the test that asked it to move something failed. The sandbox was simply not
 * in effect, which is the worst way for a test to be wrong: it was still touching a real machine.
 */
const HOME_VARS = ["HOME", "USERPROFILE"] as const;

async function sandbox(): Promise<{ home: string; previous: string; restore: () => void }> {
	const root = await mkdtemp(join(tmpdir(), "ly-migrate-"));
	const real = HOME_VARS.map((name) => [name, process.env[name]] as const);
	const realPlumeHome = process.env.PLUME_HOME;
	for (const name of HOME_VARS) process.env[name] = root;
	delete process.env.PLUME_HOME;
	return {
		home: join(root, ".plume"),
		previous: join(root, ".deepwise"),
		restore: () => {
			for (const [name, value] of real) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			if (realPlumeHome !== undefined) process.env.PLUME_HOME = realPlumeHome;
		},
	};
}

test("the old home is moved, contents and all", async () => {
	const box = await sandbox();
	try {
		await mkdir(join(box.previous, "sessions", "abc"), { recursive: true });
		await writeFile(join(box.previous, "settings.json"), '{"providers":[]}');
		await writeFile(join(box.previous, "sessions", "abc", "one.jsonl"), '{"seq":1}\n');

		const result = await migratePreviousHome(box.home);

		assert.equal(result.moved, true);
		assert.equal(await readFile(join(box.home, "settings.json"), "utf8"), '{"providers":[]}');
		assert.equal(await readFile(join(box.home, "sessions", "abc", "one.jsonl"), "utf8"), '{"seq":1}\n');
	} finally {
		box.restore();
		await rm(join(box.home, ".."), { recursive: true, force: true });
	}
});

test("nothing happens when there is nothing to move", async () => {
	const box = await sandbox();
	try {
		assert.deepEqual(await migratePreviousHome(box.home), { moved: false });
	} finally {
		box.restore();
	}
});

test("two homes are left alone rather than merged", async () => {
	const box = await sandbox();
	try {
		// Someone has already used the renamed app. Merging two histories is not a decision to
		// make on their behalf at startup.
		await mkdir(box.previous, { recursive: true });
		await writeFile(join(box.previous, "settings.json"), "old");
		await mkdir(box.home, { recursive: true });
		await writeFile(join(box.home, "settings.json"), "new");

		assert.equal((await migratePreviousHome(box.home)).moved, false);
		assert.equal(await readFile(join(box.home, "settings.json"), "utf8"), "new", "the new home is untouched");
		assert.equal(await readFile(join(box.previous, "settings.json"), "utf8"), "old", "and so is the old one");
	} finally {
		box.restore();
		await rm(box.home, { recursive: true, force: true });
	}
});

test("an explicit PLUME_HOME means the caller has already decided", async () => {
	const box = await sandbox();
	try {
		await mkdir(box.previous, { recursive: true });
		process.env.PLUME_HOME = box.home;

		assert.equal((await migratePreviousHome(box.home)).moved, false);
	} finally {
		delete process.env.PLUME_HOME;
		box.restore();
	}
});

test("a migration that cannot happen reports rather than throws", async () => {
	const box = await sandbox();
	try {
		// A file where the old home should be: not a directory, so there is nothing to move.
		await writeFile(box.previous, "not a directory");
		const result = await migratePreviousHome(box.home);
		assert.equal(result.moved, false);
		assert.equal(result.error, undefined, "not an error either — there was simply nothing to do");
	} finally {
		box.restore();
	}
});
