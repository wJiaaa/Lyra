/**
 * A picture of the sidebar, for looking at rather than asserting on.
 *
 * Not a test — `node e2e/shot-sidebar.ts` — and beside the tests because it boots the app the same
 * way they do. Reviewing a change to how something is *drawn* against a DOM assertion is reviewing
 * a description of the picture; this is the picture. `LYRA_SHOT_THEME` picks the theme, which is
 * the one thing a pinned row's colour still depends on.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const DAY = 86_400_000;
const NAMES = ["cf-sub-worker-public", "agent-test", "deepWise", "CliProxy", "Lyra", "quantum"];
const AGES = [0, 0, 1, 1, 3, 9, 20, 40, 90];

async function seed(home: string): Promise<void> {
	const now = Date.now();
	const metas: unknown[] = [];
	let n = 0;
	for (const name of NAMES) {
		for (let i = 0; i < 9; i++) {
			const updatedAt = now - AGES[i % AGES.length] * DAY - n * 60_000;
			metas.push({
				id: `s${n}`,
				title: `${name} 的会话 ${i + 1}，标题稍微长一点`,
				cwd: `/w/${name}`,
				projectId: name,
				projectName: name,
				createdAt: updatedAt - 60_000,
				updatedAt,
				modelId: "m",
				messageCount: 4,
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				seq: 1,
				archived: n % 3 === 2,
			});
			n++;
		}
	}
	await mkdir(join(home, "sessions"), { recursive: true });
	await writeFile(join(home, "sessions", "index.json"), JSON.stringify(metas));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: NAMES.map((name, i) => ({ path: `/w/${name}`, name, pinned: i === 0, lastOpenedAt: 100 - i })),
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
			appearance: {
				theme: process.env.LYRA_SHOT_THEME === "light" ? "light" : "dark",
			},
		}),
	);
}

const out = process.argv[2] ?? "/tmp/lyra-sidebar";
const app = await startApp({ port: 9471, seed });
const view = `document.querySelector(".ly-sidebar-fill .ly-scroll-view")`;

try {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	for (const [name, top] of [
		["top", 0],
		["pinned", 300],
	] as const) {
		await app.evaluate(`(() => { ${view}.scrollTop = ${top}; return true; })()`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(`${out}-${name}.png`, Buffer.from(shot.data, "base64"));
		const state = await app.evaluate(`(() => {
			const el = ${view};
			const origin = el.getBoundingClientRect().top;
			const style = getComputedStyle(el);
			return {
				rail: style.getPropertyValue("--ly-rail").trim(),
				inset: style.getPropertyValue("--ly-fade-inset").trim(),
				strip: Math.round(el.querySelector("[data-ly-rail]").getBoundingClientRect().top - origin),
				heads: [...el.querySelectorAll("[data-ly-head]")]
					.map((h) => Math.round(h.getBoundingClientRect().top - origin))
					.filter((y) => y < 400),
			};
		})()`);
		process.stdout.write(`wrote ${out}-${name}.png ${JSON.stringify(state)}\n`);
	}
} finally {
	await app.stop();
}
