/* oxlint-disable no-console -- performance probe CLI that prints timing measurements */
/**
 * Measuring what the window actually waits for.
 *
 * Not a test — a probe. It builds a repository with a realistic pile of uncommitted work, points
 * the app at it, and times the IPC calls that opening a project and switching conversations make.
 * The numbers are the whole output; nothing here asserts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";

const exec = promisify(execFile);

/** A repository with `dirty` changed files and `fresh` untracked ones, all real text. */
async function makeRepo(files: number): Promise<string> {
	const root = join(tmpdir(), `plume-perf-${Date.now()}`);
	await mkdir(root, { recursive: true });
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "probe@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "probe"], { cwd: root });

	// A committed baseline, so half the changes are modifications rather than additions.
	for (let i = 0; i < files; i++) {
		const body = Array.from({ length: 120 }, (_, line) => `export const v${i}_${line} = ${line};`).join("\n");
		await writeFile(join(root, `src${i}.ts`), `${body}\n`);
	}
	await exec("git", ["add", "-A"], { cwd: root });
	await exec("git", ["commit", "-qm", "baseline"], { cwd: root });

	// Now dirty every one of them, and add as many again that git has never seen.
	for (let i = 0; i < files; i++) {
		const body = Array.from({ length: 130 }, (_, line) => `export const v${i}_${line} = ${line + 1};`).join("\n");
		await writeFile(join(root, `src${i}.ts`), `${body}\n`);
		await writeFile(join(root, `new${i}.ts`), `${body}\n`);
	}
	return root;
}

async function main() {
	const files = Number(process.env.PERF_FILES ?? 120);
	const repo = await makeRepo(files);
	console.log(`repo: ${repo} (${files} modified + ${files} untracked)`);

	const app = await startApp({ port: 9333 });
	try {
		// Warm: the first call of anything pays for module loading, not for the work.
		await app.evaluate(`window.plume.workspace.info(${JSON.stringify(repo)}).then(() => 1)`);

		const time = async (label: string, expression: string) => {
			const ms = await app.evaluate<number>(
				`(async () => { const t = performance.now(); await (${expression}); return performance.now() - t; })()`,
			);
			console.log(`${label.padEnd(34)} ${ms.toFixed(0)} ms`);
			return ms;
		};

		await time("workspace.info (dirty repo)", `window.plume.workspace.info(${JSON.stringify(repo)})`);
		await time("git.status (dirty repo)", `window.plume.git.status(${JSON.stringify(repo)})`);
		await time("git.repos (dirty repo)", `window.plume.git.repos(${JSON.stringify(repo)})`);
		await time("sessions.list", `window.plume.sessions.list()`);
		// What the git panel's changes view asks for on every status it receives.
		await time("diff.workspaceDiff", `window.plume.diff.workspaceDiff(${JSON.stringify(repo)})`);
		await time("git.diffRefs (staged)", `window.plume.git.diffRefs(${JSON.stringify(repo)}, "HEAD", null)`);
		await time("git.worktrees", `window.plume.git.worktrees(${JSON.stringify(repo)})`);

		// The two calls 新对话 and 新建项目 wait on before anything on screen changes.
		await time("git.generalScratch", `window.plume.git.generalScratch()`);
		await time(
			"settings.save",
			`window.plume.settings.get().then((s) => window.plume.settings.save(s))`,
		);

		/*
		 * What the user feels: is the main process still answering while a project is being read?
		 *
		 * `sessions.list` is the cheapest call there is, so any time it takes here is time it spent
		 * queued behind the work `workspace.info` is doing on the same event loop.
		 */
		const blocked = await app.evaluate<{ info: number; worst: number; samples: number[] }>(`(async () => {
			const samples = [];
			let running = true;
			const poll = (async () => {
				while (running) {
					const t = performance.now();
					await window.plume.sessions.list();
					samples.push(performance.now() - t);
					await new Promise((r) => setTimeout(r, 16));
				}
			})();
			const t = performance.now();
			await window.plume.workspace.info(${JSON.stringify(repo)});
			const info = performance.now() - t;
			running = false;
			await poll;
			return { info, worst: Math.max(...samples), samples };
		})()`);
		console.log(`\nwhile workspace.info ran ${blocked.info.toFixed(0)} ms:`);
		console.log(`  worst sessions.list round trip  ${blocked.worst.toFixed(0)} ms`);
		console.log(`  samples ${blocked.samples.map((s) => s.toFixed(0)).join(", ")}`);
	} finally {
		await app.stop();
		await exec("rm", ["-rf", repo]).catch(() => {});
	}
}

await main();
