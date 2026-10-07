/**
 * What a confined command may write, as rules rather than as a running sandbox.
 *
 * Two of these matter more than the rest. The escaping tests are a security boundary: a profile is
 * a string the kernel parses, so a directory whose name contains a quote could otherwise end the
 * literal early and turn the remainder of a path into profile syntax nobody wrote. The containment
 * tests are the other half — a grant that resolves to nothing, or one that quietly covers more than
 * it names, both fail in the direction you do not notice.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bwrapArgs, canonicalPath, seatbeltArgs, writableRoots } from "../src/sandbox/policy.ts";

const profileOf = (args: string[]) => args[1] ?? "";

test("read-only grants no writable roots at all", () => {
	assert.deepEqual(writableRoots({ mode: "read-only", workspaceRoot: "/some/project" }), []);
});

test("danger-full-access is not a confined mode, so it derives nothing either", () => {
	assert.deepEqual(writableRoots({ mode: "danger-full-access", workspaceRoot: "/some/project" }), []);
});

test("workspace-write grants the workspace and the temp areas", () => {
	const roots = writableRoots({ mode: "workspace-write", workspaceRoot: realpathSync.native(tmpdir()) });
	assert.ok(roots.length > 0);
	// Every root is canonical: a grant naming a symlink matches nothing at runtime.
	for (const root of roots) assert.equal(root, canonicalPath(root));
});

test("a workspace inside a temp root is absorbed rather than granted twice", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "plume-sb-"));
	const child = join(parent, "project");
	await mkdir(child, { recursive: true });
	t.after(() => rm(parent, { recursive: true, force: true }));

	const roots = writableRoots({ mode: "workspace-write", workspaceRoot: child });
	// `child` sits under the platform temp dir, which is already granted; listing both would make
	// the profile say the same thing twice.
	const canonicalChild = canonicalPath(child);
	const covering = roots.filter((root) => canonicalChild === root || canonicalChild.startsWith(`${root}/`));
	assert.equal(covering.length, 1, `expected exactly one grant covering the workspace, got ${JSON.stringify(roots)}`);
});

test("a sibling whose path merely starts the same is not absorbed", () => {
	// `/a/bc` is not inside `/a/b`; a plain startsWith would swallow it.
	const roots = writableRoots({ mode: "workspace-write", workspaceRoot: "/nonexistent-a/bc" });
	assert.ok(roots.includes("/nonexistent-a/bc"));
});

test("an unresolvable root is kept as spelled, granting nothing until it exists", () => {
	const missing = "/definitely/not/here/right/now";
	assert.equal(canonicalPath(missing), missing);
});

test("a symlinked root resolves to what the kernel would report", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "plume-sb-link-"));
	const real = join(base, "real");
	const link = join(base, "link");
	await mkdir(real, { recursive: true });
	await symlink(real, link);
	t.after(() => rm(base, { recursive: true, force: true }));

	assert.equal(canonicalPath(link), realpathSync.native(real));
});

// ---------------------------------------------------------------------------
// Seatbelt
// ---------------------------------------------------------------------------

test("the profile denies writes and keeps the sink a shell cannot run without", () => {
	const profile = profileOf(seatbeltArgs({ mode: "read-only", workspaceRoot: "/p" }));
	assert.match(profile, /\(deny file-write\*\)/);
	assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/);
	// A read-only profile grants no subtree.
	assert.ok(!profile.includes("subpath"), profile);
});

test("workspace-write adds subpath grants", () => {
	const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: realpathSync.native(tmpdir()) }));
	assert.match(profile, /\(allow file-write\* \(subpath /);
});

test("the profile is passed as -p, the way sandbox-exec takes it", () => {
	const args = seatbeltArgs({ mode: "read-only", workspaceRoot: "/p" });
	assert.equal(args[0], "-p");
	assert.equal(args.length, 2);
});

/*
 * The three escaping tests below deliberately sit outside `/tmp`.
 *
 * `writableRoots` drops any root contained by another — a workspace under `/tmp` is already covered
 * by the `/tmp` grant, and saying so twice makes a profile nobody reads carefully. That de-duping is
 * correct, but it also means a hostile path under `/tmp` never reaches the profile at all, leaving
 * nothing to assert escaping against. On macOS this went unnoticed because `/tmp` canonicalises to
 * `/private/tmp`, which does not contain `/tmp/...`; on Linux it is plain `/tmp`, which does. Two of
 * these failed there and the third passed for the wrong reason — its `!includes` was satisfied by an
 * empty profile rather than by an escaped one.
 */

test("a quote in a directory name cannot end the literal early", () => {
	const hostile = '/ws/we"ird';
	const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: hostile }));
	// The quote is escaped, so what follows stays inside the string literal.
	assert.ok(profile.includes('we\\"ird'), profile);
	// And the profile still has exactly the quotes that open and close its literals: an unescaped
	// one would leave an odd count.
	assert.equal((profile.match(/(?<!\\)"/g) ?? []).length % 2, 0, profile);
});

test("a backslash is escaped before the quote handling, not after", () => {
	const hostile = "/ws/back\\slash";
	const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: hostile }));
	assert.ok(profile.includes("back\\\\slash"), profile);
});

test("a newline in a path cannot inject another profile form", () => {
	const hostile = "/ws/a\n(allow file-write* (subpath \"/\"))";
	const profile = profileOf(seatbeltArgs({ mode: "workspace-write", workspaceRoot: hostile }));
	// The injected form is inside a string literal — its quotes are escaped — so it is a path, not
	// a grant. What must never appear is that form with its own unescaped quotes.
	assert.ok(!profile.includes('(subpath "/"))'), profile);
	// And the path did reach the profile, so the line above is about escaping rather than absence.
	assert.ok(profile.includes("/ws/a"), profile);
});

// ---------------------------------------------------------------------------
// bwrap
// ---------------------------------------------------------------------------

test("bwrap binds the whole filesystem read-only", () => {
	const args = bwrapArgs({ mode: "read-only", workspaceRoot: "/p" });
	assert.deepEqual(args.slice(0, 3), ["--ro-bind", "/", "/"]);
	assert.ok(args.includes("--die-with-parent"), "a killed turn must not leave the command running");
	assert.ok(!args.includes("--bind"), "read-only binds nothing writable");
});

test("bwrap binds each writable root back over the read-only mount", () => {
	const root = realpathSync.native(tmpdir());
	const args = bwrapArgs({ mode: "workspace-write", workspaceRoot: root });
	const bindIndexes = args.map((a, i) => (a === "--bind" ? i : -1)).filter((i) => i >= 0);
	assert.ok(bindIndexes.length > 0);
	for (const i of bindIndexes) assert.equal(args[i + 1], args[i + 2], "a bind maps a path onto itself");
});
