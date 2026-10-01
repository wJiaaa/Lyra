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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureSessionWorkspace, prChatSlug } from "../electron/scratch.ts";

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
