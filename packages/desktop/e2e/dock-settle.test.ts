/**
 * Adopting a layout is not a movement, so nothing about it animates.
 *
 * Every switch between conversations loads that conversation's saved layout, and `DockView` marks
 * the document with `data-dock-settling` for the two frames that takes so the panes land rather
 * than travel. That flag used to suppress the entrance with `animation: none` — and an animation
 * is bound to its element by *name*, so putting the name back started a fresh one. The flag whose
 * whole purpose was to stop panes animating was replaying the entrance of every pane in the dock,
 * two frames after every switch: measured from `opacity`, 0 → 1 over eleven frames, on the
 * conversation as well as the panels.
 *
 * Both halves are asserted here, because fixing one by losing the other would be no fix: a pane
 * that is genuinely new must still fade in, and one that was already there must not.
 *
 * Measured from `opacity` rather than from class names or animation bookkeeping — what is being
 * claimed is about what the eye sees.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";

let app: RunningApp;

/**
 * Two conversations, so a layout can be arranged in one and adopted back into it.
 *
 * The last test needs a pane to be *inserted* by an adoption, and that only happens when the
 * conversation being opened has a saved layout the current one does not — which takes somewhere
 * to switch away to and back from.
 */
async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "one.ts"), "export const one = 1\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "off",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
		}),
	);

	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const sessions = [];
	for (const id of ["settle-a", "settle-b"]) {
		const meta = {
			id,
			title: id === "settle-a" ? "第一个会话" : "第二个会话",
			cwd: project,
			projectId,
			projectName: "project",
			createdAt: 1,
			updatedAt: 2,
			modelId: "none",
			messageCount: 1,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			seq: 2,
		};
		const records = [
			{ seq: 1, ts: 1, type: "meta", meta },
			{
				seq: 2,
				ts: 2,
				type: "message",
				message: { role: "user", content: [{ type: "text", text: `${id} 的第一条消息` }], timestamp: 2 },
			},
		];
		sessions.push({ meta, records });
	}
	seedSessions(home, sessions);
}

before(async () => {
	app = await startApp({ port: 9448, seed });
	await app.evaluate(`document.documentElement.dataset.reduceMotion = "off"`);
});

after(async () => {
	await app?.stop();
});

/** `opacity` of the first pane on screen, once per frame. */
async function opacityOverFrames(setup: string, frames: number): Promise<number[]> {
	return app.evaluate<number[]>(`(async () => {
		const pane = document.querySelector("[data-dock-pane]");
		if (!pane) throw new Error("no pane on screen");
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		// Isolate adoption from the initial shell entrance, which may still be in progress.
		await Promise.all(pane.getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
		${setup}
		const out = [];
		for (let i = 0; i < ${frames}; i++) {
			out.push(Number(getComputedStyle(pane).opacity));
			await frame();
		}
		return out;
	})()`);
}

test("a pane already on screen does not fade when the settling flag is lifted", async () => {
	// Exactly what a conversation switch does: raise the flag, let the layout be adopted, drop it
	// two frames later.
	const samples = await opacityOverFrames(
		`
		document.documentElement.dataset.dockSettling = "";
		await frame();
		await frame();
		delete document.documentElement.dataset.dockSettling;
		`,
		14,
	);

	const faded = samples.filter((value) => value < 0.99);
	assert.deepEqual(faded, [], `a pane replayed its entrance: ${samples.join(" ")}`);
});

test("a pane that is genuinely new still arrives rather than appearing", async () => {
	const samples = await app.evaluate<number[]>(`(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		const host = document.querySelector(".ly-dock") ?? document.body;
		const el = document.createElement("div");
		el.className = "ly-dock-pane";
		el.style.cssText = "position:absolute;left:0;top:0;width:10px;height:10px;pointer-events:none";
		host.appendChild(el);
		const out = [];
		// By the clock rather than a frame count: ten frames are 167ms at 60Hz but 83ms at 120Hz, inside the fade.
		const end = performance.now() + 250;
		do {
			out.push(Number(getComputedStyle(el).opacity));
			await frame();
		} while (performance.now() < end);
		out.push(Number(getComputedStyle(el).opacity));
		el.remove();
		return out;
	})()`);

	assert.ok(samples[0] < 0.5, `a new pane blinked into existence: ${samples.join(" ")}`);
	assert.ok(samples[samples.length - 1] > 0.9, `a new pane never finished arriving: ${samples.join(" ")}`);
});

/**
 * And the case the flag exists for: a pane the *adoption itself* brings in.
 *
 * Driven through the app rather than by planting a div and setting the flag by hand. The suppression
 * used to be a rule keyed on `data-dock-settling`, which a synthetic pane would pick up wherever it
 * was inserted; it is now a class applied to the panes a settle covers — including the ones that
 * arrive during it, which is the harder half and the one worth a test. Reaching in to set the flag
 * would now assert on a mechanism instead of on what the eye sees, and would have gone on passing
 * while every conversation switch faded its panes back in.
 *
 * So: arrange a layout in one conversation, leave, and come back to it. The panel is inserted by
 * the adoption, and it must be there rather than arrive.
 */
for (const motion of ["off", "on"]) test(`a pane the adoption brings in lands rather than fading (reduced motion ${motion})`, async (t) => {
	await app.evaluate(`document.documentElement.dataset.reduceMotion = ${motion === "on" ? '"on"' : '"off"'}`);
	// Open the first conversation and give it a second pane, which saves that layout under its id.
	await app.evaluate(`(async () => {
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		document.querySelector('[data-ly-row="settle-a"] button').click();
		await wait(900);
		if (!document.querySelector('[data-dock-pane="terminal"]')) {
			document.querySelector('button[aria-label="面板"]').click();
			await wait(250);
			[...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.trim().startsWith("终端"))?.click();
			await wait(900);
		}
		if (document.querySelectorAll("[data-dock-pane]").length < 2) throw new Error("the panel never opened");
		// Away to the other conversation, whose own layout is a single pane.
		document.querySelector('[data-ly-row="settle-b"] button').click();
		await wait(900);
		return true;
	})()`);

	/*
	 * Back to the first, sampling from the frame the switch is asked for.
	 *
	 * The pane is inserted part-way through these frames, so the sampler watches for it to appear
	 * and records what it was drawn at — `null` until it exists, a number from then on.
	 */
	const samples = await app.evaluate<(number | null)[]>(`(async () => {
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		const paneOf = () => document.querySelector('[data-dock-pane="terminal"]');
		document.querySelector('[data-ly-row="settle-a"] button').click();
		const out = [];
		for (let i = 0; i < 30; i++) {
			const pane = paneOf();
			out.push(pane ? Number(getComputedStyle(pane).opacity) : null);
			await frame();
		}
		return out;
	})()`);

	const drawn = samples.filter((value): value is number => value !== null);
	t.diagnostic(JSON.stringify({ motion, opacity: drawn }));
	assert.ok(drawn.length > 0, `the panel never came back: ${samples.join(" ")}`);
	assert.deepEqual(
		drawn.filter((value) => value < 0.99),
		[],
		`a pane faded itself in while the dock was settling: ${samples.join(" ")}`,
	);
});
