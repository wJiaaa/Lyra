/**
 * A screenshot of the review panel with binary changes in it, for looking at.
 *
 * `node e2e/shot-binary-diff.ts <out.png>` — seeds a repository with an image added, one changed
 * and one deleted, plus a zip and a text file, then opens 改动 and expands everything.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/plume-binary-diff.png";
const trayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "tray");
const repo = "/tmp/plume-bindiff-shot";

function seedRepo(): void {
	rmSync(repo, { recursive: true, force: true });
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@t.t");
	git("config", "user.name", "t");
	copyFileSync(join(trayDir, "tray@2x.png"), join(repo, "logo.png"));
	copyFileSync(join(trayDir, "tray.png"), join(repo, "old-icon.png"));
	writeFileSync(join(repo, "app.ts"), "const version = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "init");

	copyFileSync(join(trayDir, "trayTemplate@2x.png"), join(repo, "new-mark.png"));
	copyFileSync(join(trayDir, "tray@1.5x.png"), join(repo, "logo.png"));
	writeFileSync(join(repo, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]));
	rmSync(join(repo, "old-icon.png"));
	writeFileSync(join(repo, "app.ts"), "const version = 2;\n");
}

seedRepo();

const app = await startApp({
	port: 9468,
	seed: async (home) => {
		writeFileSync(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
		writeFileSync(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: repo, name: "bindiff", pinned: false, lastOpenedAt: Date.now() }],
				defaultModelId: null,
				permissionMode: "auto",
				thinking: "medium",
				retryAttempts: 3,
				hooks: [],
				scheduledTasks: [],
				disabledPlugins: [],
				pluginRegistries: [],
				skillRegistries: [],
				alwaysAllow: [],
				appearance: { theme: process.env.PLUME_SHOT_THEME === "light" ? "light" : "dark" },
			}),
		);
	},
});

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	await settle(2500);
	// Open the review pane from the conversation's own title bar.
	const opened = await app.evaluate<boolean>(`(() => {
		const hit = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("data-ly-tip") ?? "").startsWith("Git"));
		hit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return Boolean(hit);
	})()`);
	process.stdout.write(`opened git panel: ${opened}\n`);
	await settle(2000);

	// Expand every file row so the binary rendering is on screen.
	const expanded = await app.evaluate<number>(`(() => {
		const rows = [...document.querySelectorAll("button")].filter((b) => /\\.(png|zip|ts)$/.test(b.textContent?.trim() ?? ""));
		for (const row of rows) row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return rows.length;
	})()`);
	process.stdout.write(`expanded ${expanded} rows\n`);
	await settle(2500);

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`wrote ${out}\n`);
} finally {
	await app.stop();
}
