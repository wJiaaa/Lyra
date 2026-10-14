/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 圆角吸附到 Tailwind 刻度、阴影收成 token 之后，在真窗口里量一遍、拍一遍。
 *
 * 同一个剧本跑两次：改动前的构建传 `before`，改动后的传 `after`。每一处都量 computed style，不看变量
 * 本身——变量定义了却没被 Tailwind 输出，量到的就是空的圆角，这正是要抓的那种错。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/radius-shadow-demo.ts after [输出目录]`
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, contextClick, frames, openCommandPalette, openSession, openSettings, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const label = process.argv[2] === "before" ? "before" : "after";
const out = process.argv[3] ?? join(homedir(), "Desktop", "Plume圆角阴影收口测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9783;
const tag = label === "before" ? "改前" : "改后";

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function seed(home: string): Promise<void> {
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
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			// 毛玻璃关掉：CDP 截图拍不到系统材质。
			appearance: { theme: "light", vibrancy: false },
		}),
	);
	const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
	const now = Date.now();
	const meta = { id: "shapes", title: "圆角和阴影", cwd: project, projectId, projectName: "proj", createdAt: now, updatedAt: now, modelId: "none", messageCount: 2, usage, seq: 0 };
	const reply = ["卡片、代码块和行内的 `rounded-lg` 现在都落在同一套刻度上。", "", "```ts", "export const radius = \"var(--radius-lg)\";", "```"].join("\n");
	seedSessions(home, [
		{
			meta,
			records: [
				{ type: "meta", meta, ts: now },
				{ type: "message", ts: now, message: { role: "user", content: [{ type: "text", text: "把圆角和阴影收成 token" }], timestamp: now } },
				{ type: "message", ts: now, message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: now } },
			],
		},
	] as never);
}

const shot = async (app: RunningApp, name: string) => {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1000, y: 700 });
	await frames(app, 20);
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}_${tag}.png`), Buffer.from(data, "base64"));
};

/** 第一个看得见的匹配元素的 computed style 里的几项。 */
const style = (app: RunningApp, selector: string, props: string[]) =>
	app.evaluate<Record<string, string> | null>(`(() => {
		const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility());
		if (!el) return null;
		const cs = getComputedStyle(el);
		return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, cs.getPropertyValue(p)]));
	})()`);

await mkdir(out, { recursive: true });
const app = await startApp({ port: PORT, seed });
const measured: Record<string, unknown> = {};
try {
	await until(app, `document.querySelector('[data-ly-row="shapes"]')`);
	await openSession(app, "shapes");
	await until(app, `document.querySelector(".prose-dw .ly-code-block")`);
	await frames(app, 30);

	measured.radiusVars = await app.evaluate(`["--radius-xs","--radius-sm","--radius-md","--radius-lg","--radius-xl","--radius-2xl"].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim())`);
	measured.codeBlock = await style(app, ".prose-dw .ly-code-block", ["border-radius"]);
	measured.inlineCode = await style(app, ".prose-dw :not(pre) > code", ["border-radius"]);
	measured.composer = await style(app, ".ly-composer-tray, .ly-composer", ["box-shadow"]);
	await shot(app, "01_会话");

	await type(app, "textarea", "/");
	await until(app, `document.querySelector(".ly-command-menu[data-open='true']")`);
	await frames(app, 20);
	measured.slashMenu = await style(app, ".ly-command-menu", ["border-radius", "box-shadow"]);
	await shot(app, "02_斜杠菜单");
	await press(app, "Escape", 27);
	await press(app, "Backspace", 8);

	await contextClick(app, '[data-ly-row="shapes"] > button');
	await until(app, `document.querySelector(".ly-menu-card")`);
	await frames(app, 20);
	measured.menu = await style(app, ".ly-menu-card", ["border-radius", "box-shadow"]);
	await shot(app, "03_右键菜单");
	await press(app, "Escape", 27);
	await until(app, `!document.querySelector(".ly-menu-card")`);
	await openCommandPalette(app);
	measured.dialog = await style(app, ".ly-dialog-surface", ["border-radius", "box-shadow"]);
	await shot(app, "04_命令面板");
	await press(app, "Escape", 27);
	await until(app, `!document.querySelector(".ly-dialog-surface")`);

	await openSettings(app, "插件");
	await until(app, `document.querySelector(".ly-tabs-knob")`);
	await frames(app, 30);
	measured.tabsKnob = await style(app, ".ly-tabs-knob", ["box-shadow", "outline-width", "outline-style", "outline-color"]);
	await shot(app, "05_设置_插件");

	await click(app, "nav button", "常规");
	await until(app, `document.querySelector(".ly-knob")`);
	await frames(app, 20);
	measured.knob = await style(app, ".ly-knob", ["box-shadow"]);
	await shot(app, "06_设置_常规");

	await click(app, "nav button", "关于");
	await until(app, `document.querySelector(".ly-about-icon")`);
	await frames(app, 20);
	measured.aboutIcon = await style(app, ".ly-about-icon", ["border-radius", "box-shadow"]);
	await shot(app, "07_设置_关于");
	await closeSettings(app);
} finally {
	await app.stop();
}

console.log(JSON.stringify(measured, null, 2));
await writeFile(join(out, `${stamp}_量值_${tag}.json`), JSON.stringify(measured, null, 2));

if (label === "after") {
	const get = (key: string, prop: string) => (measured[key] as Record<string, string> | null)?.[prop];
	check("Tailwind 的圆角刻度在构建里有定义", (measured.radiusVars as string[]).every(Boolean), measured.radiusVars);
	check("代码块吸附到 8px", get("codeBlock", "border-radius") === "8px", measured.codeBlock);
	check("行内代码吸附到 4px", get("inlineCode", "border-radius") === "4px", measured.inlineCode);
	check("斜杠菜单和主输入框同为 16px", get("slashMenu", "border-radius") === "16px", measured.slashMenu);
	check("菜单阴影没变（就是 shadow-md）", get("menu", "box-shadow") === "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px", measured.menu);
	check("对话框阴影没变", get("dialog", "box-shadow") === "rgba(0, 0, 0, 0.16) 0px 18px 60px 0px, rgba(0, 0, 0, 0.06) 0px 2px 8px 0px", measured.dialog);
	check("分段旋钮浅色下仍有那道细边", get("tabsKnob", "outline-style") === "solid" && get("tabsKnob", "outline-width") !== "0px", measured.tabsKnob);
	check("开关旋钮阴影没变", get("knob", "box-shadow") === "rgba(0, 0, 0, 0.16) 0px 1px 2.5px 0px", measured.knob);
	check("输入框阴影没变", get("composer", "box-shadow")?.startsWith("rgba(0, 0, 0, 0.05) 0px 20px 25px -5px") === true, measured.composer);
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，截图在 ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}
