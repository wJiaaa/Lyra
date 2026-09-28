/**
 * Branch listing and switching, against real repositories.
 *
 * Everything here builds an actual checkout in a temporary directory and runs the real commands
 * against it. That is the point: this layer is a thin wrapper over `git`, so the only failures
 * worth catching are the ones where our idea of what git says differs from what it says — and no
 * amount of mocking can surface those, because a mock returns whatever we already believed.
 *
 * Two of them were live at once, and both came from the same line: classifying a ref by whether
 * its short name contains a slash.
 *
 *   - `refs/remotes/origin/HEAD` shortens to plain `origin`. No slash, so it was filed as a local
 *     branch and offered in the switcher as somewhere to go. It is a symbolic pointer; checking it
 *     out is not a thing you can do.
 *   - A local `feat/thing` has a slash, so it was filed as a remote. On a repository that names
 *     branches that way — most of them — nearly every local branch was in the wrong half.
 *
 * And a third, downstream of the first: picking a remote branch ran `git switch origin/main`,
 * which fails with "a branch is expected, got remote branch" — an error the user sees for having
 * clicked an entry the menu offered them.
 *
 * A bare repository stands in for the remote. No network, no `gh`, and the app itself never shells
 * out to anything but `git`.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { listBranches, switchBranch } from "../electron/git.ts";
import { createBranch, deleteBranch } from "../electron/git-history.ts";

const exec = promisify(execFile);

let dir: string;
let origin: string;

/** Run git in the checkout, failing loudly: a broken fixture must not read as a broken assertion. */
async function git(args: string[], cwd = dir): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout;
}

before(async () => {
	const root = await mkdtemp(join(tmpdir(), "plume-git-"));
	dir = join(root, "work");
	origin = join(root, "origin.git");

	// A bare repository to push to, which is what makes the remote refs real.
	await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
	await exec("git", ["init", "--initial-branch=main", dir]);
	await git(["config", "user.email", "test@example.com"]);
	await git(["config", "user.name", "Test"]);
	await writeFile(join(dir, "one.txt"), "one\n");
	await git(["add", "."]);
	await git(["commit", "-m", "first"]);

	/*
	 * Branches with slashes in them, because that is the shape the bug was about.
	 *
	 * `feat/thing` and `docs/notes` are ordinary local branches. Anything that decides "local or
	 * remote" from the name will get both of them wrong.
	 */
	await git(["branch", "feat/thing"]);
	await git(["branch", "docs/notes"]);
	await git(["branch", "dev"]);

	await git(["remote", "add", "origin", origin]);
	await git(["push", "-u", "origin", "main"]);
	// A branch that exists only on the remote, which is the one worth switching to.
	await git(["push", "origin", "main:release/1.x"]);
	await git(["push", "origin", "main:solo-remote"]);
	await git(["fetch", "origin"]);
	// `origin/HEAD`, which git creates on clone and which `for-each-ref` shortens to `origin`.
	await git(["remote", "set-head", "origin", "main"]);
});

after(async () => {
	await rm(join(dir, ".."), { recursive: true, force: true }).catch(() => {});
});

test("a local branch with a slash in its name is local", async () => {
	const branches = await listBranches(dir);
	assert.ok(branches.local.includes("feat/thing"), `feat/thing is local (${branches.local.join(", ")})`);
	assert.ok(branches.local.includes("docs/notes"), "docs/notes is local");
	assert.ok(branches.local.includes("dev"), "and so is a plain one");
	assert.ok(!branches.remote.includes("feat/thing"), "and it is not also listed as remote");
});

test("the remote's own HEAD pointer is not offered as a branch", async () => {
	const branches = await listBranches(dir);
	/*
	 * The exact shape of the first bug: `refs/remotes/origin/HEAD` short-names to `origin`, which
	 * has no slash and so was filed as a local branch. It is not a branch at all.
	 */
	assert.ok(!branches.local.includes("origin"), `no branch called "origin" (${branches.local.join(", ")})`);
	assert.ok(!branches.remote.includes("origin"), "nor among the remotes");
	assert.ok(!branches.remote.some((r) => r.endsWith("/HEAD")), "and no origin/HEAD either");
});

test("a branch that exists only on the remote is offered, with its remote prefix", async () => {
	const branches = await listBranches(dir);
	assert.ok(branches.remote.includes("origin/solo-remote"), `(${branches.remote.join(", ")})`);
	// Slashes in remote branch names work the same way.
	assert.ok(branches.remote.includes("origin/release/1.x"), "including one with a slash of its own");
});

test("a remote branch that already has a local twin is not offered twice", async () => {
	const branches = await listBranches(dir);
	// `main` is local and also on the remote; picking `origin/main` would just be picking `main`.
	assert.ok(branches.local.includes("main"));
	assert.ok(!branches.remote.includes("origin/main"), `(${branches.remote.join(", ")})`);
});

test("switching to a local branch goes there", async () => {
	assert.deepEqual(await switchBranch(dir, "feat/thing"), { ok: true });
	assert.equal((await listBranches(dir)).current, "feat/thing");
	assert.deepEqual(await switchBranch(dir, "main"), { ok: true });
});

test("switching to a remote branch creates the local branch that follows it", async () => {
	/*
	 * The failure this replaces: `git switch origin/solo-remote` answers "a branch is expected, got
	 * remote branch", and that message went to the user verbatim from a menu that had just offered
	 * the entry.
	 */
	const result = await switchBranch(dir, "origin/solo-remote");
	assert.deepEqual(result, { ok: true }, `switching to a remote branch works (${result.error ?? ""})`);

	const after = await listBranches(dir);
	assert.equal(after.current, "solo-remote", "and lands on a local branch named after it");
	assert.ok(after.local.includes("solo-remote"), "which now exists locally");

	// Following it, so a push has somewhere to go without being told.
	const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"]);
	assert.equal(upstream.trim(), "origin/solo-remote");

	assert.deepEqual(await switchBranch(dir, "main"), { ok: true });
});

test("a remote branch whose name has a slash also switches", async () => {
	const result = await switchBranch(dir, "origin/release/1.x");
	assert.deepEqual(result, { ok: true }, `(${result.error ?? ""})`);
	assert.equal((await listBranches(dir)).current, "release/1.x");
	assert.deepEqual(await switchBranch(dir, "main"), { ok: true });
});

test("switching to something that is not there fails with git's own words", async () => {
	const result = await switchBranch(dir, "no-such-branch");
	assert.equal(result.ok, false);
	assert.ok(result.error && result.error.length > 0, "and says why");
});

test("uncommitted work is not silently thrown away by a switch", async () => {
	await writeFile(join(dir, "one.txt"), "changed, not committed\n");
	/*
	 * git refuses this on its own when the change would be overwritten. Here the file is the same
	 * on both branches, so it carries across — what matters is that the edit still exists either
	 * way, which is the thing a switch must never quietly undo.
	 */
	await switchBranch(dir, "dev");
	const status = await git(["status", "--porcelain"]);
	assert.ok(status.includes("one.txt"), `the edit survived the switch (${JSON.stringify(status)})`);

	await git(["checkout", "--", "one.txt"]);
	await switchBranch(dir, "main");
});

test("creating a branch puts you on it, and deleting one takes it off the list", async () => {
	const made = await createBranch(dir, "feat/made-here");
	assert.equal(made.ok, true, made.error);
	assert.equal((await listBranches(dir)).current, "feat/made-here");

	await switchBranch(dir, "main");
	const gone = await deleteBranch(dir, "feat/made-here", true);
	assert.equal(gone.ok, true, gone.error);
	assert.ok(!(await listBranches(dir)).local.includes("feat/made-here"));
});

test("a directory that is not a repository answers empty rather than throwing", async () => {
	const plain = await mkdtemp(join(tmpdir(), "plume-not-git-"));
	try {
		assert.deepEqual(await listBranches(plain), { current: null, local: [], remote: [] });
	} finally {
		await rm(plain, { recursive: true, force: true });
	}
});
