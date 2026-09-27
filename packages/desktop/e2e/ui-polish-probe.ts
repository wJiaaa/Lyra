/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * A reported UI fault, checked in a real window.
 *
 * Found by looking at the app rather than at the code, so verified the same way: by asking the
 * window what it drew, not by asking the source what it meant to draw.
 *
 * Menu separators were invisible in dark: the soft rule is measured from the *page*, and a menu is
 * a lighter surface, so the line came out darker than the card it divided.
 *
 * Run: node --experimental-strip-types e2e/ui-polish-probe.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const PORT = 9476;
const WINDOW = { width: 1440, height: 900 };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = await startApp({
	port: PORT,
	seed: async (home) => {
		const root = join(home, "project");
		await mkdir(root, { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ ...WINDOW, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: root, name: "project", pinned: false, lastOpenedAt: Date.now() }],
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
				appearance: { theme: "dark" },
			}),
		);
	},
});

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "  ✔" : "  ✖"} ${what}`);
	if (!ok) failures.push(what);
};

/** Relative luminance of a `rgb(...)` string, for judging whether a hairline can be seen. */
const LUMA = `(css, overLuma) => {
	// rgb(a) and color(srgb ...) both appear here: the theme's veils resolve to the latter.
	let r, g, b, a = 1;
	const rgb = /rgba?\\(([^)]+)\\)/.exec(css);
	const srgb = /color\\(srgb ([^)]+)\\)/.exec(css);
	if (rgb) {
		const parts = rgb[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat);
		[r, g, b] = parts; if (parts.length > 3) a = parts[3];
	} else if (srgb) {
		const parts = srgb[1].split(/[\\s\\/]+/).filter(Boolean).map(parseFloat);
		[r, g, b] = parts.slice(0, 3).map((n) => n * 255); if (parts.length > 3) a = parts[3];
	} else return null;
	const own = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	// A translucent hairline is only as bright as what shows through it.
	return overLuma === undefined ? own : own * a + overLuma * (1 - a);
}`;

try {
	await pause(2_800);
	await app.evaluate(`(async () => {
		const wait = (ms) => new Promise(r => setTimeout(r, ms));
		const row = document.querySelector('[data-project-row], [data-ly-project]');
		if (row) { row.click(); await wait(1200); }
		return true;
	})()`);
	await pause(1_500);

	// ── Separator contrast ───────────────────────────────────────────────────────────────────
	console.log("\n[1] 菜单分隔线在暗色下的对比度");
	const rule = await app.evaluate<{ line: number; surface: number; delta: number } | string>(`(() => {
		const luma = ${LUMA};
		const probe = document.createElement('div');
		probe.className = 'bg-line-float';
		probe.style.cssText = 'position:fixed;left:-100px;top:0;width:10px;height:10px';
		document.body.appendChild(probe);
		const line = getComputedStyle(probe).backgroundColor;
		probe.className = 'bg-float';
		const surface = getComputedStyle(probe).backgroundColor;
		probe.remove();
		const b = luma(surface);
		if (b === null) return 'surface read failed: ' + surface;
		const a = luma(line, b);
		if (a === null) return 'line read failed: ' + line;
		return { line: a, surface: b, delta: a - b };
	})()`);
	console.log("   ", JSON.stringify(rule));
	check(
		typeof rule !== "string" && rule.delta > 0.03,
		`分隔线比它所在的菜单表面更亮（差 ${typeof rule === "string" ? "?" : rule.delta.toFixed(3)}，改之前是负的）`,
	);

	console.log(failures.length === 0 ? "\n全部通过" : `\n${failures.length} 条没过：\n- ${failures.join("\n- ")}`);
} catch (error) {
	console.error("\n探针自己出错了:", error);
	failures.push(String(error));
} finally {
	await app.stop();
}

if (failures.length > 0) process.exitCode = 1;
