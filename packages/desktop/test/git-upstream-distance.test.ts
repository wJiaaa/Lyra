/**
 * 输入框分支 chip 上的 `↑18 ↓2`：当前分支比它跟踪的远端分支多几个、少几个提交。
 *
 * 没跟踪远端（从没推过）答 null 而不是 0/0——0/0 读起来是「和远端一致」，可它根本还没到过远端。
 */

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { upstreamDistance } from "../electron/git-status.ts";
import { cleanUpFixtures, commitIn, fixture, sh } from "./helpers/worktree-fixture.ts";

after(cleanUpFixtures);

test("跟踪远端的分支：领先几个、落后几个都数对", async () => {
	const { root, repo } = await fixture("upstream");
	const remote = join(root, "remote.git");
	await mkdir(remote);
	await sh(remote, "init", "--bare", "--initial-branch=main");
	await sh(repo, "remote", "add", "origin", remote);
	await sh(repo, "push", "-u", "origin", "main");
	assert.deepEqual(await upstreamDistance(repo), { upstream: "origin/main", ahead: 0, behind: 0 });

	// 远端那边多了一个：在另一个克隆里提交、推上去，这边 fetch 之后才知道。
	const other = join(root, "other");
	await sh(root, "clone", remote, other);
	await sh(other, "config", "user.email", "test@example.com");
	await sh(other, "config", "user.name", "Test");
	await commitIn(other, "theirs.md", "theirs\n");
	await sh(other, "push");
	await commitIn(repo, "a.md", "a\n");
	await commitIn(repo, "b.md", "b\n");
	assert.deepEqual(await upstreamDistance(repo), { upstream: "origin/main", ahead: 2, behind: 0 }, "没 fetch 之前，远端的新提交还不在这里");
	await sh(repo, "fetch");
	assert.deepEqual(await upstreamDistance(repo), { upstream: "origin/main", ahead: 2, behind: 1 });
});

test("没跟踪远端：null，不是 0/0", async () => {
	const { repo } = await fixture("noupstream");
	assert.equal(await upstreamDistance(repo), null);
	await sh(repo, "switch", "-c", "feature");
	assert.equal(await upstreamDistance(repo), null, "新分支从没推过");
});
