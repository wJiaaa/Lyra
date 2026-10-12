/**
 * Tests for Git worktree management, creation, auto-creation and cleanup.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import {
	autoCreateSessionWorktree,
	cleanOldWorktrees,
	createWorktree,
	removeWorktree,
	resolveWorktreesRoot,
} from "../electron/git-worktrees.ts";
import { listWorktrees } from "../electron/git-repos.ts";
import { canonicalPath } from "../electron/path-key.ts";
import { DEFAULT_SETTINGS } from "@plume/core";

const exec = promisify(execFile);

let dir: string;
let origin: string;
let root: string;

/** Every worktree these tests make lives under the temporary root, never in the user's `~/.plume`. */
function at(name: string): { targetDir: string } {
	return { targetDir: join(root, "trees", name) };
}

async function git(args: string[], cwd = dir): Promise<string> {
	const { stdout } = await exec("git", args, { cwd });
	return stdout;
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "plume-wt-test-"));
	dir = join(root, "work");
	origin = join(root, "origin.git");

	await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
	await exec("git", ["init", "--initial-branch=main", dir]);
	await git(["config", "user.email", "test@example.com"]);
	await git(["config", "user.name", "Test"]);
	await writeFile(join(dir, "README.md"), "# Test\n");
	await git(["add", "."]);
	await git(["commit", "-m", "initial commit"]);
	await git(["remote", "add", "origin", origin]);
	await git(["push", "-u", "origin", "main"]);
});

after(async () => {
	await rm(root, { recursive: true, force: true }).catch(() => {});
});

test("resolveWorktreesRoot handles default and custom paths", () => {
	const defaultPath = resolveWorktreesRoot();
	assert.ok(defaultPath.length > 0);
	assert.ok(defaultPath.includes("worktrees"));

	const custom = resolveWorktreesRoot("~/my-custom-worktrees");
	assert.ok(!custom.startsWith("~"));
	assert.ok(custom.includes("my-custom-worktrees"));
});

test("createWorktree creates a linked worktree and listWorktrees lists it", async () => {
	const res = await createWorktree(dir, "feature/wt-1", at("feature-wt-1"));
	assert.equal(res.ok, true);
	assert.ok(res.path && existsSync(res.path));
	assert.equal(res.branch, "feature/wt-1");

	const trees = await listWorktrees(dir);
	assert.ok(trees.length >= 2);
	const linked = trees.find((t) => t.path === res.path);
	assert.ok(linked);
	assert.equal(linked.worktree, true);
	assert.equal(linked.branch, "feature/wt-1");
});

test("removeWorktree removes a linked worktree and cleans it up", async () => {
	const created = await createWorktree(dir, "feature/wt-to-remove", at("feature-wt-to-remove"));
	assert.equal(created.ok, true);
	assert.ok(created.path && existsSync(created.path));

	const removed = await removeWorktree(dir, created.path);
	assert.equal(removed.ok, true);
	assert.equal(existsSync(created.path), false);

	const trees = await listWorktrees(dir);
	assert.ok(!trees.some((t) => t.path === created.path));
});

test("autoCreateSessionWorktree creates dedicated worktree when enabled in settings", async () => {
	const customSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCreateOnNewSession: true,
			rootDir: join(root, "session-worktrees"),
		},
	};

	const res = await autoCreateSessionWorktree(dir, customSettings, "session-12345678");
	assert.equal(res.worktreeCreated, true);
	assert.ok(res.cwd.includes("session-worktrees"));
	assert.ok(existsSync(res.cwd));

	// Test disabled setting
	const disabledSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCreateOnNewSession: false,
		},
	};
	const resDisabled = await autoCreateSessionWorktree(dir, disabledSettings, "session-999");
	assert.equal(resDisabled.worktreeCreated, false);
	assert.equal(resDisabled.cwd, dir);
});

/*
 * 根目录留空时，工作树建在 `resolveWorktreesRoot()` 下——也就是 Git 面板的守卫放行的那一处。
 *
 * 从前留空是建在仓库旁边，而守卫只认 `~/.plume/worktrees`：这些会话里暂存、提交、推送全部报
 * 「该目录不在已打开的项目内」。两边读同一个函数，这条测试守的就是它们不再分开。
 */
test("留空的根目录下，自动建的工作树落在守卫放行的目录里", async () => {
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = join(root, "plume-home");
	try {
		const settings = { ...DEFAULT_SETTINGS, worktrees: { autoCreateOnNewSession: true, rootDir: "" } };
		const res = await autoCreateSessionWorktree(dir, settings, "blankroot-1234");
		assert.equal(res.worktreeCreated, true);
		// 守卫比较前两边都取规范写法，这里照做：macOS 上临时目录一边是 /var，一边是 /private/var。
		const allowed = canonicalPath(resolveWorktreesRoot(""));
		assert.equal(relative(allowed, canonicalPath(res.cwd)), basename(res.cwd), `${res.cwd} 不在 ${allowed} 里`);
	} finally {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
	}
});

test("cleanOldWorktrees prunes excess worktrees above keepLimit while protecting active ones", async () => {
	// Create multiple worktrees
	const wt1 = await createWorktree(dir, "cleanup/wt-1", at("cleanup-wt-1"));
	const wt2 = await createWorktree(dir, "cleanup/wt-2", at("cleanup-wt-2"));
	const wt3 = await createWorktree(dir, "cleanup/wt-3", at("cleanup-wt-3"));

	assert.ok(wt1.path && wt2.path && wt3.path);

	const cleanSettings = {
		...DEFAULT_SETTINGS,
		worktrees: {
			autoCleanOld: true,
			keepLimit: 2,
		},
	};

	// wt1 is active, should not be deleted
	const active = new Set([wt1.path]);
	const cleanedCount = await cleanOldWorktrees(dir, cleanSettings, active);
	assert.ok(cleanedCount >= 1);
	assert.equal(existsSync(wt1.path), true, "active session worktree must be preserved");
});

/**
 * The guard has to hold whatever the path looks like.
 *
 * On Windows it did not, and the failure was silent and destructive: `git worktree list` prints
 * `C:/Users/...` while everything else in the app produces `C:\Users\...`, so the set of active
 * worktrees never matched and the cleanup deleted the checkout the session was running in. The
 * spelling below is the one git would have produced; the assertion is that it is still recognised.
 */
test("a worktree in use is protected however its path is spelled", async () => {
	const keep = await createWorktree(dir, "spelling/in-use", at("spelling-in-use"));
	const doomed = await createWorktree(dir, "spelling/idle-1", at("spelling-idle-1"));
	const alsoDoomed = await createWorktree(dir, "spelling/idle-2", at("spelling-idle-2"));
	assert.ok(keep.path && doomed.path && alsoDoomed.path);

	const settings = { ...DEFAULT_SETTINGS, worktrees: { autoCleanOld: true, keepLimit: 1 } };

	/*
	 * Built by hand, not with `join`.
	 *
	 * `join` normalises the `..` away, which would make this string identical to `keep.path` and
	 * the test vacuous — it passed before the fix on macOS for exactly that reason. Written out, it
	 * is a different string naming the same directory, which is the whole situation being tested.
	 */
	const awkward = `${keep.path}/../${basename(keep.path)}`;
	assert.notEqual(awkward, keep.path, "the awkward spelling must actually differ, or this proves nothing");

	const cleaned = await cleanOldWorktrees(dir, settings, new Set([awkward]));

	assert.ok(cleaned >= 1, "the idle worktrees should still be cleaned");
	assert.equal(existsSync(keep.path), true, "the worktree in use must survive an odd spelling");
});

/*
 * 兜底的 `rm -rf` 只碰 git 自己认的工作树。
 *
 * `removeWorktree` 在 `git worktree remove` 失败之后会兜底删目录，而「这根本不是一棵工作树」
 * 正是它最常见的失败原因——于是传进去一个普通目录，git 拒绝，兜底把它整个删掉。这个函数由
 * `git:removeWorktree` 直接暴露给渲染进程，也就是说一个任意路径就能触发一次递归删除。
 *
 * 目录里放东西，是因为空目录被删掉和没被删掉太像；有内容时「还在」才是个有力的断言。
 */
test("不是工作树的目录，删不掉", async () => {
	const bystander = join(root, "not-a-worktree");
	await mkdtemp(join(root, "x-")).catch(() => {});
	await exec("mkdir", ["-p", bystander]);
	await writeFile(join(bystander, "重要文件.txt"), "别删我\n");

	const result = await removeWorktree(dir, bystander);

	assert.equal(result.ok, false, "它不是工作树，这次调用就该失败");
	assert.equal(existsSync(bystander), true, "目录必须还在——这是这条测试的全部意义");
	assert.equal(existsSync(join(bystander, "重要文件.txt")), true, "里面的东西也在");
});

test("真的工作树照样删得掉", async () => {
	// 上面那条守卫如果写死了，这条会红：它证明收紧的是「不是工作树」而不是「删不了了」。
	const made = await createWorktree(dir, "wt-removable", at("wt-removable"));
	assert.equal(made.ok, true, made.error);
	assert.ok(made.path);

	const result = await removeWorktree(dir, made.path);
	assert.equal(result.ok, true, result.error);
	assert.equal(existsSync(made.path), false);
});
