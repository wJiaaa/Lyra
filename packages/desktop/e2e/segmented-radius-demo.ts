/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 分段控件（`TabStrip`、设置页的 `Segmented`）和插件页的范围按钮收成同一套小圆角之后，在真窗口里
 * 量一遍、拍一遍。浅色、深色各起一次。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/segmented-radius-demo.ts before|after [输出目录]`
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames, openSettings, until } from "./drive.ts";

const label = process.argv[2] === "before" ? "before" : "after";
const out = process.argv[3] ?? join(homedir(), "Desktop", "Plume分段控件圆角测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const tag = label === "before" ? "改前" : "改后";

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

function seeder(theme: "light" | "dark") {
	return async (home: string) => {
		const project = join(home, "proj");
		await mkdir(project, { recursive: true });
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ id: "e2e", name: "proj", path: project, pinned: true, lastOpenedAt: 1 }],
				defaultModelId: null,
				permissionMode: "auto",
				thinking: "high",
				retryAttempts: 3,
				hooks: [],
				scheduledTasks: [],
				disabledPlugins: [],
				alwaysAllow: [],
				// 毛玻璃关掉：CDP 截图拍不到系统材质。
				appearance: { theme, vibrancy: false },
			}),
		);
	};
}

/** 第一个看得见的匹配元素的圆角。 */
const radius = (app: RunningApp, selector: string) =>
	app.evaluate<string | null>(`(() => {
		const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility());
		return el ? getComputedStyle(el).borderRadius : null;
	})()`);

const shot = async (app: RunningApp, name: string, clip: string) => {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1000, y: 760 });
	await app.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
	await frames(app, 20);
	// 只拍控件那一条，前后对照时一眼看得出圆角。
	const box = await app.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
		const r = document.querySelector(${JSON.stringify(clip)}).getBoundingClientRect();
		return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 24), width: r.width + 48, height: r.height + 48 };
	})()`);
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 2 } });
	await writeFile(join(out, `${stamp}_${name}_${tag}.png`), Buffer.from(data, "base64"));
	const full = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}_整页_${tag}.png`), Buffer.from(full.data, "base64"));
};

await mkdir(out, { recursive: true });
const measured: Record<string, Record<string, string | null>> = {};
for (const theme of ["dark", "light"] as const) {
	const app = await startApp({ port: 9785, seed: seeder(theme) });
	try {
		await until(app, `document.querySelector("[data-ly-open-settings]")`);
		await openSettings(app, "插件");
		await until(app, `document.querySelector(".ly-tabs-knob")`);
		await frames(app, 30);
		const m: Record<string, string | null> = {
			tabs: await radius(app, '[role="tablist"].ly-tabs'),
			tabsKnob: await radius(app, ".ly-tabs-knob"),
			tab: await radius(app, '.ly-tabs [role="tab"]'),
			scope: await radius(app, "[data-ly-project-scope]"),
		};
		await shot(app, `${theme === "dark" ? "1深色" : "2浅色"}_插件页标签`, "main .ly-tabs");

		await click(app, "nav button", "常规");
		await until(app, `document.querySelector("[data-segment-rail]")`);
		await frames(app, 20);
		m.segmented = await radius(app, "[data-segmented]");
		m.segmentRail = await radius(app, "[data-segment-rail]");
		m.segment = await radius(app, "[data-segment]");
		await shot(app, `${theme === "dark" ? "1深色" : "2浅色"}_常规页思考强度`, "[data-segmented]");
		measured[theme] = m;
	} finally {
		await app.stop();
	}
}

console.log(JSON.stringify(measured, null, 2));
await writeFile(join(out, `${stamp}_量值_${tag}.json`), JSON.stringify(measured, null, 2));

if (label === "after") {
	for (const theme of ["dark", "light"] as const) {
		const m = measured[theme]!;
		check(`${theme}：插件页标签条外框 8px`, m.tabs === "8px", m.tabs);
		check(`${theme}：标签滑块和每一格 6px`, m.tabsKnob === "6px" && m.tab === "6px", { knob: m.tabsKnob, tab: m.tab });
		check(`${theme}：「用户」范围按钮 8px`, m.scope === "8px", m.scope);
		check(`${theme}：思考强度外框 8px，滑块和每一格 6px`, m.segmented === "8px" && m.segmentRail === "6px" && m.segment === "6px", { box: m.segmented, rail: m.segmentRail, segment: m.segment });
	}
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，截图在 ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}
