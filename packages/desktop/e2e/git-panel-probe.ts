/* oxlint-disable no-console -- performance probe CLI that prints timing measurements */
/**
 * Opening the Git panel on a project with a real pile of uncommitted work.
 *
 * Three moments, because the complaint was about all three: how long before the pane exists, how
 * long before it says anything at all (the placeholder, or the list), and how long before every
 * row is on screen. It also samples what is drawn each frame, so a state that appears and is
 * immediately replaced — a heading with nothing under it, a skeleton that flickers — shows up as a
 * line in the timeline rather than having to be noticed by eye.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";

const exec = promisify(execFile);

async function makeRepo(files: number): Promise<string> {
	const root = join(tmpdir(), `plume-gitpanel-${files}`);
	await rm(root, { recursive: true, force: true });
	await mkdir(root, { recursive: true });
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "probe@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "probe"], { cwd: root });
	for (let i = 0; i < files; i++) {
		await writeFile(join(root, `src${i}.ts`), Array.from({ length: 120 }, (_, l) => `export const v${i}_${l} = ${l};`).join("\n"));
	}
	await exec("git", ["add", "-A"], { cwd: root });
	await exec("git", ["commit", "-qm", "baseline"], { cwd: root });
	for (let i = 0; i < files; i++) {
		const body = Array.from({ length: 130 }, (_, l) => `export const v${i}_${l} = ${l + 1};`).join("\n");
		await writeFile(join(root, `src${i}.ts`), body);
		await writeFile(join(root, `new${i}.ts`), body);
	}
	return root;
}

async function main() {
	const repo = await makeRepo(120);
	console.log(`project: ${repo} (120 modified + 120 untracked)\n`);

	const app = await startApp({
		port: 9338,
		seed: async (home) => {
			await mkdir(home, { recursive: true });
			await writeFile(
				join(home, "settings.json"),
				JSON.stringify({ projects: [{ id: repo, name: "probe", path: repo, pinned: false, lastOpenedAt: Date.now() }] }),
			);
		},
	});

	try {
		// The shortcut refuses until a project is open, and that is a round trip after the shell paints.
		await app.evaluate(`(async () => {
			for (let i = 0; i < 200; i++) {
				if (document.body.innerText.includes("plume-gitpanel-120")) return 1;
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error("the project never opened: " + document.body.innerText.slice(0, 200));
		})()`);

		const timeline = await app.evaluate<{ at: number; state: string }[]>(`(async () => {
			const frame = () => new Promise((r) => requestAnimationFrame(r));
			// ⌘⇧R is the panel's own shortcut, which is how anybody actually opens it.
			window.dispatchEvent(new KeyboardEvent("keydown", {
				key: "R", code: "KeyR", metaKey: true, shiftKey: true, bubbles: true,
			}));

			const started = performance.now();
			const seen = [];
			let last = "";
			for (let i = 0; i < 300; i++) {
				const pane = document.querySelector('[data-dock-pane="review"]');
				let state;
				if (!pane) state = "(no pane)";
				else {
					const rows = pane.querySelectorAll("[data-ly-diff-row], details, summary").length;
					const skeleton = pane.querySelector('[role="status"]');
					const text = pane.innerText.replace(/\\s+/g, " ").slice(0, 46);
					state = (skeleton ? "SKELETON " : "") + "rows=" + rows + " | " + text;
				}
				if (state !== last) { seen.push({ at: Math.round(performance.now() - started), state }); last = state; }
				await frame();
			}
			return seen;
		})()`);

		console.log("what the pane showed, frame by frame (only when it changed):\n");
		for (const step of timeline) console.log(`  +${String(step.at).padStart(4)} ms  ${step.state}`);
	} finally {
		await app.stop();
		await rm(repo, { recursive: true, force: true }).catch(() => {});
	}
}

await main();
