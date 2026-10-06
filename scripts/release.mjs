#!/usr/bin/env node
/**
 * Cutting a release, as one command.
 *
 * It used to be a list in AGENTS.md: bump the version in every package.json, write the notes, tag,
 * push. Every step of that is easy and one of them is always forgotten — one manifest once sat at
 * 0.1.0 for thirty-five releases because it was the item at the end of the list.
 *
 *   pnpm release patch                 补丁位 +1
 *   pnpm release minor|major
 *   pnpm release 0.9.0                 指定版本
 *   pnpm release patch --no-push       改完提交打好 tag，不推——本地看一眼再决定
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { MANIFESTS, ROOT, SOURCE, readVersion, writeVersion } from "./versions.mjs";

const run = promisify(execFile);

/** Run a command, or stop with its output. Nothing here is worth continuing past. */
async function must(file, args, options = {}) {
	try {
		const { stdout } = await run(file, args, { cwd: ROOT, ...options });
		return stdout.trim();
	} catch (error) {
		fail(`${file} ${args.join(" ")} 失败\n${error.stderr || error.stdout || error.message}`);
	}
}

function fail(message) {
	console.error(`\n✖ ${message}\n`);
	process.exit(1);
}

function note(message) {
	console.log(`  ${message}`);
}

/** The next version, from a bump word or an explicit number. */
function nextVersion(current, request) {
	if (/^\d+\.\d+\.\d+$/.test(request)) {
		const [a, b] = [request, current].map((v) => v.split(".").map(Number));
		const bigger = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
		if (!bigger) fail(`${request} 不比当前的 ${current} 大`);
		return request;
	}
	const [major, minor, patch] = current.split(".").map(Number);
	if (request === "major") return `${major + 1}.0.0`;
	if (request === "minor") return `${major}.${minor + 1}.0`;
	if (request === "patch") return `${major}.${minor}.${patch + 1}`;
	fail(`不认识的版本参数：${request}。用 patch / minor / major 或 x.y.z`);
}

/**
 * Everything that must be true before a tag is worth pushing.
 *
 * Checked up front rather than as it goes, so a failure leaves the tree exactly as it was found
 * instead of half-bumped.
 */
async function preflight() {
	const branch = await must("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch !== "main") fail(`发版要在 main 上，当前是 ${branch}`);

	const dirty = await must("git", ["status", "--porcelain"]);
	if (dirty) fail(`工作区不干净，先提交或收起这些改动：\n${dirty}`);

	await must("git", ["fetch", "--quiet", "origin", "main"]);
	const ahead = await must("git", ["rev-list", "--count", "origin/main..HEAD"]);
	const behind = await must("git", ["rev-list", "--count", "HEAD..origin/main"]);
	if (ahead !== "0" || behind !== "0") {
		fail(`本地与 origin/main 不一致（领先 ${ahead}，落后 ${behind}）。先推或先拉。`);
	}

}

async function main() {
	const args = process.argv.slice(2);

	const request = args[0];
	if (!request) fail("用法：pnpm release <patch|minor|major|x.y.z> [--no-push]");
	const noPush = args.includes("--no-push");

	const current = await readVersion(SOURCE);
	const version = nextVersion(current, request);
	const tag = `v${version}`;
	console.log(`\n${current} → ${version}\n`);

	await preflight();

	const existing = await must("git", ["tag", "-l", tag]);
	if (existing) fail(`${tag} 已经存在`);

	note(`写版本号（${MANIFESTS.length} 处）`);
	for (const relative of MANIFESTS) await writeVersion(relative, version);

	note("生成 CHANGELOG");
	const previous = await must("git", ["describe", "--tags", "--abbrev=0"]);
	const section = await must("npx", ["git-cliff", `${previous}..HEAD`, "--tag", tag, "--unreleased"]);
	const changelogPath = join(ROOT, "CHANGELOG.md");
	const existingLog = await readFile(changelogPath, "utf8");
	/*
	 * Prepended under the preamble rather than at the top of the file, so the explanation of what
	 * this file is stays above the versions instead of being pushed below the newest one.
	 */
	const firstVersion = existingLog.indexOf("\n## [");
	const head = firstVersion === -1 ? existingLog.trimEnd() : existingLog.slice(0, firstVersion);
	const rest = firstVersion === -1 ? "" : existingLog.slice(firstVersion + 1);
	const added = section.slice(section.indexOf("## ["));
	// Trimmed at the end too: with no earlier version `rest` is empty and would leave a blank last line.
	await writeFile(changelogPath, `${`${head}\n\n${added.trim()}\n\n${rest}`.replace(/\n{3,}/g, "\n\n").trimEnd()}\n`);

	note("提交");
	await must("git", ["add", "--", ...MANIFESTS, "CHANGELOG.md"]);
	await must("git", ["commit", "-m", `chore(release): ${tag}`]);

	note("打 tag");
	const message = await must("node", ["scripts/changelog-section.mjs", tag]);
	await must("git", ["tag", "-a", tag, "-m", message]);

	if (noPush) {
		console.log(`\n没有推送。看一眼之后：\n  git push origin main && git push origin ${tag}\n撤销：\n  git reset --hard origin/main && git tag -d ${tag}\n`);
		return;
	}

	note("推送");
	await must("git", ["push", "origin", "main"]);
	await must("git", ["push", "origin", tag]);
	console.log(`\n✓ ${tag} 已推送。\n`);
}

await main();
