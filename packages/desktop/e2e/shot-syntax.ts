/**
 * A screenshot of the editor holding files that had no grammar before.
 *
 * `node e2e/shot-syntax.ts <out.png> [filename]` — seeds a project with a `.gitignore`, a
 * Dockerfile and a `.toml`, opens the file pane and shows one of them.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/lyra-syntax.png";
const wanted = process.argv[3] ?? ".gitignore";
const repo = "/tmp/lyra-syntax-shot";

rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
writeFileSync(
	join(repo, ".gitignore"),
	[
		"# 构建产物，不进仓库",
		"node_modules/",
		"dist/",
		"*.log",
		"",
		"# 但这个要留着：它是资产，不是产物",
		"!build/icon.icns",
		"packages/*/out/",
		"[Dd]ebug/",
		".env.*",
	].join("\n"),
);
writeFileSync(
	join(repo, "Dockerfile"),
	["FROM node:24-alpine", "WORKDIR /app", "COPY package.json .", "RUN npm ci --omit=dev", 'CMD ["node", "server.js"]'].join("\n"),
);
writeFileSync(
	join(repo, "Cargo.toml"),
	['[package]', 'name = "demo"', 'version = "0.1.0"', "", "[dependencies]", 'serde = { version = "1", features = ["derive"] }'].join("\n"),
);

const app = await startApp({
	port: 9469,
	seed: async (home) => {
		writeFileSync(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
		writeFileSync(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: repo, name: "syntax", pinned: false, lastOpenedAt: Date.now() }],
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
				appearance: { theme: process.env.LYRA_SHOT_THEME === "light" ? "light" : "dark" },
			}),
		);
	},
});

const settle = (ms = 900) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	await settle(2500);
	// The file pane, from the conversation's own title bar.
	await app.evaluate(`(() => {
		const hit = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("data-ly-tip") ?? "").startsWith("文件"));
		hit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return Boolean(hit);
	})()`);
	await settle(2000);

	const opened = await app.evaluate<boolean>(`(() => {
		const row = [...document.querySelectorAll("[data-path]")].find((el) => (el.getAttribute("data-path") ?? "").endsWith(${JSON.stringify(wanted)}));
		row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return Boolean(row);
	})()`);
	process.stdout.write(`opened ${wanted}: ${opened}\n`);
	await settle(2500);

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`wrote ${out}\n`);
} finally {
	await app.stop();
}
