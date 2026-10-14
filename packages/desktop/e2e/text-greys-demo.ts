/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 次要文字两档灰（`--color-ink-muted` / `--color-ink-faint`）改深之后，在真窗口里拍前后对照。
 *
 * 浅色、深色各起一次应用。同一个窗口里先把两个变量写回改动前的值拍「改前」，再放回 `applyAppearance`
 * 算出来的值拍「改后」——这次只改了这两个值，所以同一窗口里换掉它们就是两版之间的全部差别，省掉
 * 一次旧代码的构建。断言量的是页面上真画出来的颜色，不是变量本身。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/text-greys-demo.ts [输出目录]`
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { contextClick, frames, openSession, press, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume次要文字灰度测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9781;

/** 改动前 `applyAppearance` 在出厂外观下算出的两档灰（macOS，对比度 60）。 */
const BEFORE = {
	light: { muted: "#7a7a7a", faint: "#a4a4a4" },
	dark: { muted: "#888888", faint: "#767676" },
} as const;
const AFTER = {
	light: { muted: "#656565", faint: "#8b8b8b" },
	dark: { muted: "#9b9b9b", faint: "#818181" },
} as const;

const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function seeder(theme: "light" | "dark") {
	return async (home: string) => {
		const project = join(home, "proj");
		await mkdir(project, { recursive: true });
		await writeFile(join(project, "theme.ts"), "export const muted = 0.7;\n");
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
				// 毛玻璃关掉：CDP 截图拍不到系统材质，透明的侧栏会被合成成一片中灰，量出来的不是用户看到的。
				appearance: { theme, vibrancy: false },
			}),
		);
		const projectId = createHash("sha256").update(project).digest("hex").slice(0, 16);
		const now = Date.now();
		const meta = (id: string, title: string, ago: number, count: number) => ({
			id, title, cwd: project, projectId, projectName: "proj", createdAt: now - ago, updatedAt: now - ago, modelId: "none", messageCount: count, usage, seq: 0,
		});
		const main = meta("greys", "次要文字为什么发灰", 3 * 60_000, 4);
		const t = main.updatedAt;
		const reply = [
			"问题在派生公式只按页面算对比度。`ink-muted` 在页面上有 5:1，到了菜单上只剩 3.9:1。",
			"",
			"改成按它坐着的最浅那张面算下限之后，两档灰在每一种表面上都读得清。",
		].join("\n");
		seedSessions(home, [
			{
				meta: main,
				records: [
					{ type: "meta", meta: main, ts: t },
					{ type: "message", ts: t, message: { role: "user", content: [{ type: "text", text: "深色和浅色的次要文字都有点太浅，灰灰的很漂浮" }], timestamp: t } },
					{
						type: "message",
						ts: t,
						message: {
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "先量一下两档灰在各个表面上的对比度，再决定改哪一档。", signature: "sig" },
								{ type: "toolCall", id: "c1", name: "read", arguments: { path: "theme.ts" } },
							],
							timestamp: t,
						},
					},
					{ type: "message", ts: t, message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export const muted = 0.7;\n" }], isError: false, timestamp: t } },
					{ type: "message", ts: t, message: { role: "assistant", content: [{ type: "text", text: reply }], timestamp: t } },
				],
			},
			...[
				["fix-path", "修复 Windows 路径判断", 26 * 3_600_000],
				["dock", "面板标签条对齐", 3 * 86_400_000],
				["release", "整理 0.9.22 发版说明", 9 * 86_400_000],
			].map(([id, title, ago]) => {
				const m = meta(id as string, title as string, ago as number, 1);
				return {
					meta: m,
					records: [
						{ type: "meta" as const, meta: m, ts: m.updatedAt },
						{ type: "message" as const, ts: m.updatedAt, message: { role: "user" as const, content: [{ type: "text" as const, text: title as string }], timestamp: m.updatedAt } },
					],
				};
			}),
		] as never);
	};
}

/** 指针移到对话区空白处、取消焦点：前后两张图里不能一张悬停在第 1 行、另一张第 2 行挂着焦点环。 */
const rest = async (app: RunningApp) => {
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1000, y: 620 });
	await app.evaluate(`document.activeElement instanceof HTMLElement && document.activeElement.blur()`);
	await frames(app, 20);
};

const shotTo = async (app: RunningApp, name: string) => {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(data, "base64"));
};

/**
 * 把两个变量写成给定值并等它画上屏。
 *
 * 和 `applyAppearance` 换主题一样先挂 `data-theme-switching` 按住过渡：不按的话带 `transition-colors`
 * 的元素要用 150ms 爬过去，第一次跑时量到的正是爬到一半的 `#717171`，截图也拍在半路上。
 */
const paint = async (app: RunningApp, greys: { muted: string; faint: string }) => {
	await app.evaluate(`(() => {
		const root = document.documentElement;
		root.dataset.themeSwitching = "";
		root.style.setProperty("--color-ink-muted", ${JSON.stringify(greys.muted)});
		root.style.setProperty("--color-ink-faint", ${JSON.stringify(greys.faint)});
	})()`);
	await frames(app, 3);
	await app.evaluate(`delete document.documentElement.dataset.themeSwitching`);
	await frames(app, 3);
};

/** 页面上真画出来的颜色：随便哪个读 muted / faint 的元素的 computed color，和它坐着的不透明底色。 */
const measure = (app: RunningApp) =>
	app.evaluate<{ vars: { muted: string; faint: string }; muted: string | null; faint: string | null }>(`(() => {
		const hex = (rgb) => "#" + rgb.match(/\\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
		const css = getComputedStyle(document.documentElement);
		const first = (cls) => [...document.querySelectorAll("." + cls)].find((e) => e.checkVisibility() && e.textContent.trim());
		const m = first("text-ink-muted"), f = first("text-ink-faint");
		return {
			vars: { muted: css.getPropertyValue("--color-ink-muted").trim(), faint: css.getPropertyValue("--color-ink-faint").trim() },
			muted: m ? hex(getComputedStyle(m).color) : null,
			faint: f ? hex(getComputedStyle(f).color) : null,
		};
	})()`);

await mkdir(out, { recursive: true });
for (const theme of ["light", "dark"] as const) {
	const app = await startApp({ port: PORT, seed: seeder(theme) });
	try {
		await until(app, `document.querySelector('[data-ly-row="greys"]')`);
		await openSession(app, "greys");
		await until(app, `document.body.innerText.includes("改成按它坐着的最浅那张面")`);
		await frames(app, 30);

		const live = await measure(app);
		check(`${theme}：applyAppearance 算出的是新值`, live.vars.muted === AFTER[theme].muted && live.vars.faint === AFTER[theme].faint, live.vars);
		check(`${theme}：页面上的次要文字画成新值`, live.muted === AFTER[theme].muted && live.faint === AFTER[theme].faint, { muted: live.muted, faint: live.faint });

		await paint(app, BEFORE[theme]);
		const old = await measure(app);
		check(`${theme}：改前的图确实画的是旧值`, old.muted === BEFORE[theme].muted && old.faint === BEFORE[theme].faint, { muted: old.muted, faint: old.faint });
		await rest(app);
		await shotTo(app, `${theme === "light" ? "01_浅色" : "03_深色"}_改前_会话`);
		await contextClick(app, '[data-ly-row="fix-path"] > button');
		await until(app, `document.querySelector('[role="menu"]')`);
		await frames(app, 20);
		await shotTo(app, `${theme === "light" ? "01_浅色" : "03_深色"}_改前_菜单`);
		await press(app, "Escape", 27);
		await until(app, `!document.querySelector('[role="menu"]')`);

		await paint(app, AFTER[theme]);
		await rest(app);
		await shotTo(app, `${theme === "light" ? "02_浅色" : "04_深色"}_改后_会话`);
		await contextClick(app, '[data-ly-row="fix-path"] > button');
		await until(app, `document.querySelector('[role="menu"]')`);
		await frames(app, 20);
		await shotTo(app, `${theme === "light" ? "02_浅色" : "04_深色"}_改后_菜单`);
		await press(app, "Escape", 27);
	} finally {
		await app.stop();
	}
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} 通过，截图在 ${out}`);
if (passed !== checks.length) process.exitCode = 1;
