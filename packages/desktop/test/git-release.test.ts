import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bumpSemver, getRepoInfo } from "../electron/git-release.ts";

const exec = promisify(execFile);

describe("git release bumpSemver", () => {
	it("bumps patch versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "patch"), "0.7.4");
		assert.equal(bumpSemver("v0.7.3", "patch"), "0.7.4");
		assert.equal(bumpSemver("1.0.0", "patch"), "1.0.1");
	});

	it("bumps minor versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "minor"), "0.8.0");
		assert.equal(bumpSemver("v0.7.3", "minor"), "0.8.0");
		assert.equal(bumpSemver("1.2.9", "minor"), "1.3.0");
	});

	it("bumps major versions correctly", () => {
		assert.equal(bumpSemver("0.7.3", "major"), "1.0.0");
		assert.equal(bumpSemver("v0.7.3", "major"), "1.0.0");
		assert.equal(bumpSemver("1.2.9", "major"), "2.0.0");
	});

	/*
	 * 在临时仓库里验，不读这份检出自己的 origin：fork 出来的检出 owner 是 fork 的主人，
	 * 写死一份名单的断言在别人机器上必红，而它要守的只是地址怎么拆。
	 */
	it("resolves owner, name and host from each remote URL shape", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-git-release-"));
		try {
			await exec("git", ["init", "-q", dir]);
			const cases: Array<[string, { owner: string; name: string; host: string }]> = [
				["https://github.com/kittors/Plume.git", { host: "github.com", owner: "kittors", name: "Plume" }],
				["https://github.com/kittors/Plume", { host: "github.com", owner: "kittors", name: "Plume" }],
				["git@github.com:kittors/Plume.git", { host: "github.com", owner: "kittors", name: "Plume" }],
				["ssh://git@gitlab.example.com/group/Plume.git", { host: "gitlab.example.com", owner: "group", name: "Plume" }],
			];
			for (const [url, expected] of cases) {
				await exec("git", ["-C", dir, "remote", "remove", "origin"]).catch(() => {});
				await exec("git", ["-C", dir, "remote", "add", "origin", url]);
				assert.deepEqual(await getRepoInfo(dir), expected, url);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is null without an origin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "plume-git-release-"));
		try {
			await exec("git", ["init", "-q", dir]);
			assert.equal(await getRepoInfo(dir), null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
