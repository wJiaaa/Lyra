/**
 * The working tree, reported while it is being worked on.
 *
 * Both surfaces that count uncommitted work — the bar above the composer and the Git panel — used
 * to re-read only when a turn settled. On a turn that spends minutes editing files that is minutes
 * of a number nobody can trust, and the count is the one thing on screen that says how much has
 * piled up unreviewed.
 *
 * A real repository and a real turn, because the claim is about timing: the file is written *while*
 * the agent is still going, and the question is whether the window notices before it stops. Nothing
 * here asserts on an interval — it waits for the number to arrive and fails if it never does.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";

const exec = promisify(execFile);

let app: RunningApp;
let model: Server;
let project: string;

const MODEL_PORT = 9571;
const open = new Set<import("node:http").ServerResponse>();

/** A turn that starts and never ends, so the tree can be changed underneath a running agent. */
function startModel(): Server {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			open.add(res);
			res.on("close", () => open.delete(res));
			const send = (p: unknown) => res.write(`event: ${(p as { type: string }).type}\ndata: ${JSON.stringify(p)}\n\n`);
			send({
				type: "message_start",
				message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } },
			});
			send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "在改文件" } });
			// Held open on purpose.
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "one.txt"), "one\n");

	// A real repository, so the panel has something true to report.
	await exec("git", ["init", "--initial-branch=main", project]);
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: project });
	await exec("git", ["config", "user.name", "Test"], { cwd: project });
	await exec("git", ["add", "."], { cwd: project });
	await exec("git", ["commit", "-m", "first"], { cwd: project });

	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "local",
					name: "Local",
					baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
					api: "anthropic-messages",
					apiKey: "not-a-key",
					enabled: true,
					models: [
						{
							id: "local/scripted",
							providerId: "local",
							modelId: "scripted",
							name: "Scripted",
							contextWindow: 200000,
							maxOutputTokens: 8192,
							supportsThinking: false,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
}

before(async () => {
	model = startModel();
	app = await startApp({ port: 9459, seed });
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await new Promise((r) => setTimeout(r, 800));
});

after(async () => {
	await cleanupFixture(
		() => app?.stop(),
		() => { for (const res of open) res.destroy(); },
		() => closeListeningServer(model),
	);
});

const shell = () => app.evaluate<string>(`(document.body?.innerText ?? "")`);

/** Wait for the window to say something, rather than for a fixed time. */
async function until(has: (text: string) => boolean, tries = 40): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (has(await shell())) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

test("a file written mid-turn is counted without waiting for the turn to end", async () => {
	// Start a turn and leave it running.
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, "改点东西");
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	})()`);
	assert.ok(await until((t) => t.includes("在改文件")), "the turn is under way");

	const running = await app.evaluate<boolean>(`Boolean(document.querySelector("main [data-ly-running]"))`);
	assert.ok(running, "and the window agrees it is still running");

	// Nothing is uncommitted yet.
	assert.ok(!(await shell()).includes("+3"), "no count before the edit");

	/*
	 * Three added lines, written from outside the agent entirely.
	 *
	 * Deliberately not through a tool: the point is that the count comes from asking git, so it is
	 * right about a formatter, a script, or an editor open beside this window — not only about the
	 * writes this app happens to have made itself.
	 */
	await writeFile(join(project, "two.txt"), "a\nb\nc\n");

	const counted = await until((t) => t.includes("+3"));
	assert.ok(counted, `the count appears while the turn is still running:\n${(await shell()).slice(0, 300)}`);

	// And the turn really had not ended while we waited.
	const stillRunning = await app.evaluate<boolean>(`Boolean(document.querySelector("main [data-ly-running]"))`);
	assert.ok(stillRunning, "which is the whole claim: it did not wait for the turn to settle");
});

test("a further edit moves the count again, still mid-turn", async () => {
	await writeFile(join(project, "three.txt"), "d\ne\n");
	assert.ok(await until((t) => t.includes("+5")), "the second file is counted too");
	assert.ok(
		await app.evaluate<boolean>(`Boolean(document.querySelector("main [data-ly-running]"))`),
		"still running",
	);
});

test("the polling stops once the turn does", async () => {
	// Stop the turn, then change the tree and confirm the settled state is still correct.
	await app.evaluate(`(() => {
		const button = document.querySelector('main button[aria-label="停止"]');
		button?.click();
		return true;
	})()`);
	assert.ok(
		await until((t) => !t.includes("在改文件") || true, 10),
		"the stop lands",
	);
	await new Promise((r) => setTimeout(r, 800));

	/*
	 * One last read when the turn settles, so the final number is never a poll's width out of date
	 * — and after that the interval is gone rather than running for the life of the window.
	 */
	await writeFile(join(project, "four.txt"), "f\n");
	await new Promise((r) => setTimeout(r, 2500));
	const after = await shell();
	assert.ok(
		after.includes("+5") || after.includes("+6"),
		`a settled window is not re-reading on a timer (${after.slice(0, 200)})`,
	);
});
