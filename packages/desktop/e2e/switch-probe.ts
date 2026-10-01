/* oxlint-disable no-console -- performance probe CLI that prints timing measurements */
/**
 * How long a conversation switch takes, measured on the frames.
 *
 * Seeds a profile with several substantial conversations, then clicks down the sidebar and reports
 * two things per click: how long the renderer's main thread was blocked (the window is frozen for
 * exactly that long, so this is what "the menu does not respond" means), and how long until the
 * transcript on screen actually belongs to the conversation that was clicked.
 */

import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { seedSessions as seedFixture, type FixtureRecord, type FixtureSession } from "./session-fixture.ts";

const exec = promisify(execFile);

const SESSIONS = 6;
const MESSAGES = 90;

function projectIdFor(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

const usage = {
	input: 100,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	total: 300,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A conversation long enough that rendering it is real work. */
async function seedSessions(home: string, cwd: string): Promise<void> {
	const projectId = projectIdFor(cwd);
	const sessions: FixtureSession[] = [];
	for (let s = 0; s < SESSIONS; s++) {
		const id = `00000000-0000-4000-8000-${String(s).padStart(12, "0")}`;
		const meta = {
			id,
			title: `会话 ${s}`,
			cwd,
			projectId,
			projectName: "probe",
			createdAt: 1_700_000_000_000 + s,
			updatedAt: 1_700_000_000_000 + s,
			modelId: "probe",
			messageCount: MESSAGES,
			usage,
			seq: 0,
		};
		const records: FixtureRecord[] = [{ seq: 0, ts: meta.createdAt, type: "meta", meta }];
		for (let m = 0; m < MESSAGES; m++) {
			const body =
				m % 2 === 0
					? { role: "user", content: [{ type: "text", text: `第 ${m} 问，会话 ${s}。` }], timestamp: meta.createdAt + m }
					: {
							role: "assistant",
							content: [
								{
									type: "text",
									// Long enough to be a real markdown parse and a real layout.
									text: `## 回答 ${m}\n\n${"这是一段足够长的回答文本，用来让渲染变成真实的工作量。".repeat(8)}\n\n\`\`\`ts\nexport const answer${m} = ${m};\n\`\`\`\n`,
								},
							],
							api: "anthropic",
							provider: "probe",
							model: "probe",
							usage,
							stopReason: "stop",
							timestamp: meta.createdAt + m,
						};
			records.push({ seq: m + 1, ts: meta.createdAt + m, type: "message", message: body });
		}
		records.push({ seq: MESSAGES + 1, ts: meta.createdAt, type: "meta", meta: { ...meta, seq: MESSAGES + 1 } });
		sessions.push({ meta, records });
	}
	seedFixture(home, sessions);
}

/**
 * A project with a real pile of uncommitted work, which is the case being reported.
 *
 * Switching between conversations in a *clean* checkout was always fast; what the user described
 * is switching inside a repository with a couple of hundred changed files, because that is what
 * every one of these calls scales with.
 */
async function makeRepo(files: number): Promise<string> {
	const root = join(tmpdir(), `plume-switch-${files}`);
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
	const cwd = await makeRepo(120);
	console.log(`project: ${cwd} (120 modified + 120 untracked)\n`);
	const app = await startApp({
		port: 9336,
		seed: async (home) => {
			await seedSessions(home, cwd);
			await mkdir(home, { recursive: true });
			await writeFile(
				join(home, "settings.json"),
				JSON.stringify({
					projects: [{ id: cwd, name: "probe", path: cwd, pinned: false, lastOpenedAt: Date.now() }],
				}),
			);
		},
	});

	try {
		/*
		 * A long-task observer, installed once.
		 *
		 * `longtask` entries are exactly the stretches during which the window cannot answer a
		 * click, repaint, or run an animation frame — which is the thing being complained about,
		 * stated in the only units that mean anything.
		 */
		await app.evaluate(`(() => {
			window.__blocks = [];
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) window.__blocks.push(Math.round(entry.duration));
			}).observe({ entryTypes: ["longtask"] });
			return 1;
		})()`);

		const rows = await app.evaluate<{ label: string; blocked: number; settled: number }[]>(`(async () => {
			const frame = () => new Promise((r) => requestAnimationFrame(r));
			const rows = [];
			const buttons = [...document.querySelectorAll("[data-ly-row] > button")];
			if (buttons.length < 2) throw new Error("expected a list of sessions, found " + buttons.length);

			for (const button of buttons.slice(0, 5)) {
				const want = button.textContent.trim().split("\\n")[0];
				window.__blocks.length = 0;
				const started = performance.now();
				button.click();

				// Until the transcript on screen is this conversation's — its title is in the pane header.
				let settled = -1;
				for (let i = 0; i < 240; i++) {
					await frame();
					const header = document.querySelector('[data-dock-pane="conversation"]');
					if (header && header.textContent.includes(want)) { settled = performance.now() - started; break; }
				}
				// Let anything still queued land before the numbers are read.
				for (let i = 0; i < 8; i++) await frame();
				rows.push({
					label: want,
					blocked: window.__blocks.reduce((a, b) => Math.max(a, b), 0),
					settled: Math.round(settled),
				});
			}
			return rows;
		})()`);

		console.log("switching between conversations:\n");
		console.log("  conversation           longest frozen   until on screen");
		for (const row of rows) {
			console.log(
				`  ${row.label.padEnd(20)}   ${String(row.blocked).padStart(9)} ms   ${String(row.settled).padStart(11)} ms`,
			);
		}
	} finally {
		await app.stop();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

await main();
