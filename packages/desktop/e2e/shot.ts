/**
 * A screenshot of the plugins page, for looking at rather than asserting on.
 *
 * Not a test — `node e2e/shot.ts <out.png>` — and deliberately kept beside the tests, because it
 * boots the app the same way they do. Reviewing a change to how something is *drawn* against a DOM
 * assertion is reviewing a description of the picture; this is the picture.
 *
 * Seeds the real default registry, so what comes back is the real catalogue with its real logos —
 * which is the only way to see whether the marks and the icons sit together properly.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startApp } from "./app.ts";

const out = process.argv[2] ?? "/tmp/lyra-plugins.png";
const REGISTRY = "https://market.07230805.xyz/v1/index";

async function seed(home: string): Promise<void> {
	// Two bundles on disk, so the 已安装 row has something in it besides whatever installs.
	const mcp = join(home, "mcp", "demo-mcp");
	await mkdir(mcp, { recursive: true });
	await writeFile(
		join(mcp, ".mcp.json"),
		JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["-y", "@demo/server"] } } }),
	);
	const plugin = join(home, "plugins", "demo-plugin", "skills", "greet");
	await mkdir(plugin, { recursive: true });
	await writeFile(join(plugin, "SKILL.md"), "---\nname: greet\ndescription: 打个招呼。\n---\n");

	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			pluginRegistries: [REGISTRY],
			skillRegistries: [`${REGISTRY}?kind=skill`],
			alwaysAllow: [],
			// `LYRA_SHOT_THEME=light` — the marks tint themselves from a declared brand colour, and a
			// mix that reads well on #171717 is not automatically one that reads on white.
			appearance: { theme: process.env.LYRA_SHOT_THEME === "light" ? "light" : "dark" },
		}),
	);
}

const app = await startApp({ port: 9451, seed });
try {
	await app.evaluate(`(() => {
		[...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "插件")?.click();
		return true;
	})()`);
	// Long enough for the index to arrive and every logo to be fetched and judged.
	await new Promise((resolve) => setTimeout(resolve, 12_000));

	if (process.argv[3]) {
		await app.evaluate(`(() => {
			[...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === ${JSON.stringify(process.argv[3])}).pop()?.click();
			return true;
		})()`);
		await new Promise((resolve) => setTimeout(resolve, 4000));
	}

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(out, Buffer.from(shot.data, "base64"));
	process.stdout.write(`wrote ${out}\n`);
} finally {
	await app.stop();
}
