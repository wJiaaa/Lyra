/**
 * Turning a repository name into a directory name.
 *
 * The input comes from the GitHub API, and the output is a path component under the user's home.
 * That is the whole reason this is a function worth testing rather than a template string: a name
 * is remote input, and `..` is a perfectly ordinary sequence of characters right up until it is
 * pasted into a path.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureSessionWorkspace, prChatSlug, rescueLegacyWorkspaces } from "../electron/scratch.ts";

test("owner/name becomes one path component", () => {
	const slug = prChatSlug("kittors/plume", 42);
	assert.equal(slug, "kittors-plume-42");
	assert.ok(!slug.includes("/"), "a slash would make this two directories");
});

test("traversal cannot survive", () => {
	for (const hostile of ["../../etc", "..", "a/../../b", "./.."]) {
		const slug = prChatSlug(hostile, 1);
		assert.ok(!slug.includes("/"), `${hostile} kept a separator`);
		assert.ok(!/(^|-)\.\.(-|$)/.test(slug), `${hostile} kept a traversal segment: ${slug}`);
		// `..` alone reduces to nothing, and a slug still has to name something.
		assert.notEqual(slug, "");
	}
});

test("a name that is only unsafe characters still names something", () => {
	assert.equal(prChatSlug("///", 7), "repo-7");
	assert.equal(prChatSlug("", 7), "repo-7");
});

test("length is bounded, and the number survives the truncation", () => {
	const slug = prChatSlug("o".repeat(300), 1234);
	assert.ok(slug.length <= 70, `too long: ${slug.length}`);
	assert.ok(slug.endsWith("-1234"), "the number is what keeps two truncated names apart");
});

test("two pull requests in one repository get different directories", () => {
	assert.notEqual(prChatSlug("kittors/plume", 1), prChatSlug("kittors/plume", 2));
});

test("the same pull request always gets the same directory", () => {
	// This is what makes a conversation reopen months later: nothing is recorded, it is derived.
	assert.equal(prChatSlug("kittors/plume", 9), prChatSlug("kittors/plume", 9));
});

test("unicode and spaces are replaced rather than passed through", () => {
	const slug = prChatSlug("用户/我的 项目", 3);
	assert.match(slug, /^[a-zA-Z0-9._-]+$/);
	assert.ok(slug.endsWith("-3"));
});

/**
 * Carrying the old arrangement forward.
 *
 * `workspaces/` exists because `scratch/` was shared with `core`'s own housekeeping, which deletes
 * every directory there that is not named after a live session — so the working directory of every
 * project-less conversation was being deleted on every launch. The rescue runs once, before that
 * sweep, and the thing it must never do is touch what the sweep legitimately owns.
 */
test("the old directories are carried over, and core's own are left alone", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "plume-rescue-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});

	const sessionId = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";
	await mkdir(join(home, "scratch", "general"), { recursive: true });
	await mkdir(join(home, "scratch", "acme-widgets-42"), { recursive: true });
	await mkdir(join(home, "scratch", sessionId), { recursive: true });
	await mkdir(join(home, "pr", "owner-repo-7"), { recursive: true });
	await writeFile(join(home, "scratch", "acme-widgets-42", "PR.md"), "# 42\n");

	const moved = await rescueLegacyWorkspaces();

	assert.deepEqual(moved.sort(), ["acme-widgets-42", "general", "owner-repo-7"]);
	assert.ok(existsSync(join(home, "workspaces", "general")));
	assert.ok(existsSync(join(home, "workspaces", "owner-repo-7")), "the oldest root is carried over too");
	assert.equal(
		await readFile(join(home, "workspaces", "acme-widgets-42", "PR.md"), "utf8"),
		"# 42\n",
		"what was in it came with it",
	);
	assert.ok(
		existsSync(join(home, "scratch", sessionId)),
		"a session id belongs to core's housekeeping and stays where it is",
	);
});

test("a directory already carried over is never overwritten", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "plume-rescue-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});

	await mkdir(join(home, "scratch", "general"), { recursive: true });
	await writeFile(join(home, "scratch", "general", "old.txt"), "旧的");
	await mkdir(join(home, "workspaces", "general"), { recursive: true });
	await writeFile(join(home, "workspaces", "general", "new.txt"), "在用的");

	assert.deepEqual(await rescueLegacyWorkspaces(), [], "nothing moved");
	// The one that has not been getting deleted is the one that wins.
	assert.equal(await readFile(join(home, "workspaces", "general", "new.txt"), "utf8"), "在用的");
	assert.ok(!existsSync(join(home, "workspaces", "general", "old.txt")));
});

test("a conversation's directory is put back when it has gone missing", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "plume-ensure-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});

	const mine = join(home, "workspaces", "general");
	assert.equal(await ensureSessionWorkspace(mine), true);
	assert.ok(existsSync(mine));

	// Anything that is not ours is refused: this creates directories from a path read out of a
	// stored session record, and a project's own directory is not its to recreate.
	const elsewhere = join(home, "..", "somebody-elses-project");
	assert.equal(await ensureSessionWorkspace(elsewhere), false);
	assert.ok(!existsSync(elsewhere));
});
