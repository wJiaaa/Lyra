/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 回复里只写了文件名、项目里同名的有好几份——点开要能选，而不是「读不到」。在真窗口里点，边验边录。
 *
 * 会话 3b7e7b0d 的原样：表格里写着 `ResponseSelector.java`（三个模块各有一份），点开弹「读不到
 * <工作目录>/ResponseSelector.java」。查找要走 `git ls-files`，所以夹具的项目是一个真 git 仓库。
 *
 * 用法：node --experimental-strip-types e2e/file-choices-demo.ts [before]
 *   带 `before` 只拍图不录像，给修复前的构建用。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, frames as settle, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const BEFORE = process.argv[2] === "before";
const OUT_DIR = join(homedir(), "Desktop", "Plume同名文件链接测试");
const PORT = 9437;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PHASE = BEFORE ? "修改前" : "修改后";
const SESSION = "f11ec401-0000-4000-8000-000000000001";
const MODULES = ["eim-echat", "eim-ecom", "eim-eicq"];

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "Eim");
	for (const module of MODULES) {
		const dir = join(cwd, module, "src", "main", "java", "handle");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "ResponseSelector.java"), `// ${module.toUpperCase()}-RESPONSE-SELECTOR\nclass ResponseSelector {}\n`);
	}
	const util = join(cwd, "eim-common", "src", "main", "java", "util");
	await mkdir(util, { recursive: true });
	await writeFile(join(util, "TenantLoginQuota.java"), "// ONLY-TENANT-LOGIN-QUOTA\nclass TenantLoginQuota {}\n");
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["add", "."], { cwd });

	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const now = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "同名文件链接", cwd, projectId, projectName: "Eim", createdAt: now, updatedAt: now, modelId: "qa/model", messageCount: 2, usage, seq: 0 };
	const reply = [
		"实测证据：有 9 处长在协议适配层里：",
		"",
		"| 位置 | 越界内容 |",
		"|---|---|",
		"| `ResponseSelector.java` ×3 个模块 | 直接读 `buildTenantInfoKey` |",
		"| `TenantLoginQuota.java` | 只有一份 |",
	].join("\n");
	seedSessions(home, [
		{
			meta,
			records: [
				{ seq: 1, ts: now, type: "meta", meta },
				{ seq: 2, ts: now, type: "message", message: { role: "user", content: [{ type: "text", text: "哪些类越界了" }], timestamp: now } },
				{
					seq: 3,
					ts: now,
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: reply }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: now },
				},
				{ seq: 4, ts: now, type: "meta", meta: { ...meta, seq: 3 } },
			],
		},
	]);
	// 一个永远不会被请求的假模型：没有模型配置时窗口停在「未配置」页，回复画不出来。
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			providers: [
				{
					id: "qa",
					name: "探针",
					api: "anthropic-messages",
					baseUrl: "http://127.0.0.1:9",
					apiKey: "test",
					enabled: true,
					models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
				},
			],
			defaultModelId: "qa/model",
			mcpServers: [],
			hooks: [],
			permissionMode: "full",
			projects: [{ id: projectId, path: cwd, name: "Eim", pinned: true, lastOpenedAt: now }],
			pinnedSessionIds: [],
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));
}

const text = () => app.evaluate<string>("document.body.innerText");

async function shot(name: string): Promise<void> {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${PHASE}_${name}.png`), Buffer.from(image.data, "base64"));
}

async function poll(expression: string, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`)) return true;
		await pause(150);
	}
	return false;
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const stop = BEFORE ? async () => {} : await startRecording(PORT, frames);
	try {
		await until(app, `document.querySelector('[data-ly-row="${SESSION}"]')`);
		await pause(800);
		await openSession(app, SESSION);
		await until(app, `document.querySelectorAll('[data-ly-file-link]').length >= 2`);
		await pause(1200);
		await shot("01_回复里的两个文件名");

		console.log(`${PHASE}：点三个模块都有的 ResponseSelector.java`);
		await click(app, "[data-ly-file-link] a", "ResponseSelector.java");
		await pause(1000);
		if (BEFORE) {
			const failed = await poll(`document.body.innerText.includes("读不到")`);
			check("（修改前）点开弹「读不到」", failed, (await text()).slice(0, 300));
			await shot("02_点开读不到");
		} else {
			const rows = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((e) => e.textContent.trim())`);
			const expected = MODULES.map((module) => `${module}/src/main/java/handle`);
			check("弹出三份让人选，每行写它在项目里的哪个目录", JSON.stringify([...rows].sort()) === JSON.stringify(expected), JSON.stringify(rows));
			check("没有弹「读不到」", !(await text()).includes("读不到"), "读不到");
			const bar = await app.evaluate<boolean>(`[...document.querySelectorAll('[data-ly-file-link]')].some((e) => e.textContent.includes("ResponseSelector") && e.querySelector("[data-ly-file-actions]"))`);
			check("同名的多份时，悬停的两颗出口不画", !bar, "还在");
			await shot("02_弹出三份让人选");

			await click(app, '[role="menuitem"]', "eim-ecom/src/main/java/handle");
			const opened = await poll(`document.body.innerText.includes("EIM-ECOM-RESPONSE-SELECTOR")`);
			await pause(1000);
			check("选 eim-ecom 那份：文件面板显示的是它的内容", opened, (await text()).slice(-300));
			check("选完菜单收起", !(await app.evaluate<boolean>(`Boolean(document.querySelector('[role="menu"]'))`)), "还开着");
			await shot("03_打开选中的那份");
		}

		console.log(`${PHASE}：点只有一份的 TenantLoginQuota.java`);
		await click(app, "[data-ly-file-link] a", "TenantLoginQuota.java");
		const unique = await poll(`document.body.innerText.includes("ONLY-TENANT-LOGIN-QUOTA")`);
		await settle(app, 30);
		await pause(1000);
		check("只有一份的照旧直接打开，不弹菜单", unique && !(await app.evaluate<boolean>(`Boolean(document.querySelector('[role="menu"]'))`)), (await text()).slice(-300));
		await shot("04_唯一的那份直接打开");
	} catch (error) {
		await shot("失败现场").catch(() => {});
		throw error;
	} finally {
		await stop();
		await app.stop();
	}

	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过`);
	if (!BEFORE && frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_同名文件点开让人选_${passed}of${checks.length}.mp4`);
		await encode(frames, out);
		console.log(`视频：${out}`);
	}
	process.exitCode = passed === checks.length ? 0 : 1;
}

await main();
