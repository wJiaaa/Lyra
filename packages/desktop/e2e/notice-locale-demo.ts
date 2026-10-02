/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 运行时说的话跟着界面语言走——在真窗口里发一句话、跑一次 /compact，看弹出来的是哪种语言。
 *
 * 单测（`test/notice-text.test.ts`）验的是「有 code 就查词条」这条规矩；这里补它证不到的那段：
 * 这些话是主进程里的 core 发出来、经 IPC 送到窗口、再落到 Toaster 和命令行上的，中间任何一层
 * 把 `code` 或参数丢了，窗口就退回 core 自己写的那句。
 *
 * 三样都不需要真实凭据：没配模型时发消息（无参数）、项目里 `.plume/config.json` 写了不该写的键
 * （带参数）、没配模型时 `/compact`（命令行上那一行，以及它被拒时的提示）。
 *
 * 用法：node --experimental-strip-types e2e/notice-locale-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, frameGrabber, pause, startRecording, type Frame } from "./record.ts";
import { en } from "../src/i18n/messages/en.ts";
import { zhCN as zh } from "../src/i18n/messages/zh-CN.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume提示语言测试");
const PORT = 9431;
const STAMP = new Date()
	.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" })
	.replace(/[: ]/g, "-")
	.slice(0, 16);

/** core 在通知里自己写的那句。窗口上出现它，就说明 code 在路上丢了。 */
const CORE_TEXT = "No model is configured. Add a provider in Settings → Models first.";
const EN_TEXT = en["notice.no-model"];
const ZH_TEXT = zh["notice.no-model"];
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
const KEYS = { keys: "providers, mcpServers" };
const EN_REFUSED = fill(en["notice.project-config-refused"], KEYS);
const ZH_REFUSED = fill(zh["notice.project-config-refused"], KEYS);
const EN_COMPACT = en["compactNote.no-model"];
const ZH_COMPACT = zh["compactNote.no-model"];

let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# demo\n");
	// Two keys a project file may not hold: the notice names them, which is the parameter under test.
	await mkdir(join(cwd, ".plume"), { recursive: true });
	await writeFile(join(cwd, ".plume", "config.json"), JSON.stringify({ providers: [], mcpServers: {} }));
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			uiLocale: "en",
			permissionMode: "full",
			projects: [{ id: projectId, path: cwd, name: "demo", pinned: true, lastOpenedAt: Date.now() }],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
}

/**
 * `/compact` and Enter. The slash menu may take the first Enter to pick the command; if the field
 * still holds it afterwards, the second Enter is the one that runs it.
 */
async function runCompact(): Promise<void> {
	const d = driver(app);
	await d.type("/compact");
	await pause(900);
	await d.submit();
	await pause(800);
	const left = await app.evaluate<string>('(() => document.querySelector("main textarea")?.value ?? "")()');
	if (left.trim()) await d.submit();
}

function bodyText(): Promise<string> {
	return app.evaluate<string>("document.body.innerText");
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	const grab = await frameGrabber(PORT);
	const shoot = async (name: string) => {
		const { data } = await grab.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(data, "base64"));
	};

	try {
		console.log("【一】英文界面，没有配模型，发一句话");
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1200);
		await d.type("hello");
		await pause(800);
		await d.submit();
		await d.until(`document.body.innerText.includes(${JSON.stringify(EN_TEXT)}) || document.body.innerText.includes(${JSON.stringify(CORE_TEXT)})`, 20000).catch(() => {});
		await d.until(`document.body.innerText.includes(${JSON.stringify(EN_REFUSED)})`, 10000).catch(() => {});
		await pause(1200);
		const english = await bodyText();
		check("没有模型：英文词条", english.includes(EN_TEXT), english.slice(0, 400));
		check("没有退回 core 自己写的那句", !english.includes(CORE_TEXT), "窗口上是 core 的原文");
		check("项目配置里被拒的键：英文词条，键名填进去了", english.includes(EN_REFUSED), english.slice(0, 600));
		await shoot("01_英文界面的提示");
		await pause(1200);

		console.log("\n【二】英文界面跑一次 /compact");
		await runCompact();
		await d.until(`document.body.innerText.includes(${JSON.stringify(EN_COMPACT)})`, 15000).catch(() => {});
		await pause(1200);
		const englishCompact = await bodyText();
		check("/compact 被拒的原因：英文词条", englishCompact.includes(EN_COMPACT), englishCompact.slice(0, 600));
		check("没有出现 core 的中文原话", !englishCompact.includes("还没有可用的模型"), "窗口上是 core 的原文");
		await shoot("02_英文界面的压缩结果");
		await pause(1500);

		console.log("\n【三】换成中文界面，开一个新对话再发一句");
		await grab.evaluate(`(async () => {
			const settings = await window.plume.settings.get();
			await window.plume.settings.save({ ...settings, uiLocale: "zh-CN" });
			return true;
		})()`);
		await pause(1500);
		await d.markByText("/新对话/", "data-demo-new");
		await d.click("[data-demo-new]");
		await pause(1200);
		await d.type("你好");
		await pause(800);
		await d.submit();
		await d.until(`document.body.innerText.includes(${JSON.stringify(ZH_TEXT)})`, 20000).catch(() => {});
		await d.until(`document.body.innerText.includes(${JSON.stringify(ZH_REFUSED)})`, 10000).catch(() => {});
		await pause(1200);
		const chinese = await bodyText();
		check("没有模型：中文词条", chinese.includes(ZH_TEXT), chinese.slice(0, 400));
		check("项目配置里被拒的键：中文词条，键名填进去了", chinese.includes(ZH_REFUSED), chinese.slice(0, 600));
		await shoot("03_中文界面的提示");
		await pause(1200);

		console.log("\n【四】中文界面跑一次 /compact");
		await runCompact();
		await d.until(`document.body.innerText.includes(${JSON.stringify(ZH_COMPACT)})`, 15000).catch(() => {});
		await pause(1200);
		const chineseCompact = await bodyText();
		check("/compact 被拒的原因：中文词条", chineseCompact.includes(ZH_COMPACT), chineseCompact.slice(0, 600));
		await shoot("04_中文界面的压缩结果");
		await pause(1500);
	} finally {
		grab.close();
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成 60fps…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_提示与压缩结果跟随界面语言_${passed}of${checks.length}.mp4`);
	await app.stop();
	await encode(frames, out, 60, 1200);

	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	process.exitCode = 1;
});
