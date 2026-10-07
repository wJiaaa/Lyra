/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 设置页不再跟着「当前会话在哪个项目」走——在真窗口里，开着 B 项目的会话去看 A 项目的东西。
 *
 * 从前常规页的「项目配置」和个性化页的项目记忆读的是当前会话的项目。
 * 设置外壳还按会话项目给整组页面换 key，换个会话回来，页内选过的范围全被重置。这里逐条验：
 *   - 会话开在 Beta，常规页照样列出 Alpha 的项目配置；
 *   - 项目记忆可以在页内选到 Alpha，读到它的两条记忆；切到 Beta 显示「还没有记住什么」；
 *   - 会话里「去审核」点过去，钩子页落在 Beta 那一栏（这是唯一替人选项目的入口，改成了显式写）；
 *   - 命令页选了 Alpha，回去换一个会话再回来，还是 Alpha。
 *
 * 用法：pnpm build 之后 node --experimental-strip-types e2e/settings-project-scope-demo.ts [输出目录]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeLessons } from "@plume/core";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume设置页项目范围测试");
const PORT = 9471;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const LESSONS = [
	{ text: "Alpha 的端口固定在 4100，别去猜。", at: 1_700_000_000_000 },
	{ text: "Alpha 改完 CSS 要跑 pnpm style。", at: 1_700_000_001_000 },
];

let app: RunningApp;
let alpha = "";
let beta = "";
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

async function seed(home: string): Promise<void> {
	alpha = join(home, "alpha");
	beta = join(home, "beta");
	await mkdir(join(alpha, ".plume"), { recursive: true });
	await mkdir(join(beta, ".plume"), { recursive: true });
	// Alpha 改写全局的权限模式；Beta 带一条没信任过的项目钩子，好让会话里出现「去审核」。
	await writeFile(join(alpha, ".plume", "config.json"), JSON.stringify({ permissionMode: "ask" }));
	await writeFile(
		join(beta, ".plume", "config.json"),
		JSON.stringify({ thinking: "high", hooks: { events: { SessionStart: [{ hooks: [{ type: "command", command: "echo beta" }] }] } } }),
	);

	process.env.PLUME_HOME = home;
	await writeLessons(alpha, LESSONS);

	const idOf = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const now = Date.now();
	const session = (cwd: string, name: string, title: string, at: number) => {
		const meta = {
			id: randomUUID(), title, cwd, projectId: idOf(cwd), projectName: name, createdAt: at, updatedAt: at,
			modelId: null, messageCount: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0,
		};
		const message = (seq: number, role: string, text: string) =>
			({ seq, ts: at + seq, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq } });
		return { meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", `${name} 里的一句话`), message(3, "assistant", "好的。")] };
	};
	seedSessions(home, [session(alpha, "Alpha", "Alpha 的会话", now - 120_000), session(beta, "Beta", "Beta 的会话", now - 60_000)]);

	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1, providers: [], mcpServers: [],
			projects: [
				{ id: idOf(alpha), path: alpha, name: "Alpha", pinned: false, lastOpenedAt: now - 120_000 },
				{ id: idOf(beta), path: beta, name: "Beta", pinned: false, lastOpenedAt: now - 60_000 },
			],
			defaultModelId: null, permissionMode: "auto", thinking: "medium", retryAttempts: 3,
			hooks: [], scheduledTasks: [], disabledPlugins: [], pluginRegistries: [], skillRegistries: [], alwaysAllow: [],
			personalization: { customInstructions: "", enableMemory: true, enableProjectMemory: true, enableToolAssistedMemory: true, tone: "friendly" },
		}),
	);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const ui = driver(app);
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	let shots = 0;
	const shot = async (name: string) => {
		const data = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${String(++shots).padStart(2, "0")}_${name}.png`), Buffer.from(data.data, "base64"));
	};
	const text = (selector: string) => app.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent ?? "").join(" | ")`);
	const count = (selector: string) => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
	/** 当前可见的那一页里的元素——设置页会把看过的页面留着，只是藏起来。 */
	const visible = (selector: string) =>
		app.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.checkVisibility()).map((e) => e.textContent ?? "")`);
	const clickText = async (selector: string, pattern: string) => {
		await ui.until(
			`[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.checkVisibility() && ${pattern}.test(e.textContent.trim()))`,
			20000,
		);
		await app.evaluate(
			`(()=>{document.querySelector('[data-probe]')?.removeAttribute('data-probe');[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility() && ${pattern}.test(e.textContent.trim())).setAttribute('data-probe','');})()`,
		);
		await ui.click("[data-probe]");
	};
	const section = async (label: string) => {
		await clickText("nav button", new RegExp(`^${label}$`).toString());
		await pause(1200);
	};
	const openSession = async (title: string) => {
		await clickText("[data-ly-row]", new RegExp(title).toString());
		await ui.until(`document.querySelector("main")?.textContent.includes(${JSON.stringify(title.replace(" 的会话", " 里的一句话"))})`, 20000);
		await pause(1000);
	};
	const backToChat = async () => {
		await clickText("button", /^返回/.toString());
		await pause(1000);
	};

	try {
		await pause(1500);
		console.log("\n① 打开 Beta 的会话，再进设置");
		await openSession("Beta 的会话");
		await ui.until(`document.querySelector("[data-ly-hook-trust-banner]")`, 20000);
		check("Beta 的会话里出现了「去审核」横幅", (await count("[data-ly-hook-trust-banner]")) === 1, String(await count("[data-ly-hook-trust-banner]")));
		await shot("Beta会话");
		await ui.click("[data-ly-open-settings]");
		await pause(1400);

		console.log("\n② 常规页：两个项目的配置都列出来，不只是会话所在的 Beta");
		await section("常规");
		await ui.until(`document.querySelectorAll("[data-project-layer]").length >= 2`, 15000).catch(() => {});
		const layers = await text("[data-project-layer] p.font-mono");
		check("列出 Alpha 的项目配置", layers.includes(join(alpha, ".plume", "config.json")), layers);
		check("列出 Beta 的项目配置", layers.includes(join(beta, ".plume", "config.json")), layers);
		const titles = await text("[data-project-layer] > div:first-child");
		check("两张卡的标题带着各自的项目名", titles.includes("Alpha 的项目配置") && titles.includes("Beta 的项目配置"), titles);
		check("Alpha 那张卡说的是 permissionMode", (await count("[data-project-layer-key='permissionMode']")) === 1, await text("[data-project-layer-key]"));
		await shot("常规页_两个项目的配置");

		console.log("\n③ 个性化页：项目记忆在页内选项目");
		await section("个性化");
		await ui.until(`document.querySelector("[data-project-memory] [data-ly-select]")`, 15000);
		await app.evaluate(`document.querySelector("[data-project-memory]").scrollIntoView({ block: "center" })`);
		await pause(800);
		const initial = (await text("[data-project-memory] [data-ly-select]")).trim();
		console.log(`   默认选的是：${initial}`);
		await ui.click("[data-project-memory] [data-ly-select]");
		await pause(700);
		await shot("个性化页_项目下拉");
		await clickText("[role^=menuitem]", /^Alpha/.toString());
		await ui.until(`document.querySelectorAll("[data-project-lesson]").length === 2`, 10000).catch(() => {});
		const lessons = await text("[data-project-lesson]");
		check("选 Alpha 后读到它的两条记忆", (await count("[data-project-lesson]")) === 2 && lessons.includes("4100"), lessons);
		check("有记忆时有「全部忘掉」", (await count("[data-project-memory-clear]")) === 1, String(await count("[data-project-memory-clear]")));
		await pause(800);
		await shot("个性化页_Alpha的记忆");
		await ui.click("[data-project-memory] [data-ly-select]");
		await pause(700);
		await clickText("[role^=menuitem]", /^Beta/.toString());
		await ui.until(`document.querySelector("[data-project-memory-empty]")?.textContent.includes("还没有记住")`, 10000).catch(() => {});
		check("切到 Beta 显示「还没有记住什么」", (await text("[data-project-memory-empty]")).includes("还没有记住"), await text("[data-project-memory-empty]"));
		check("没有记忆时不给「全部忘掉」", (await count("[data-project-memory-clear]")) === 0, String(await count("[data-project-memory-clear]")));
		await pause(800);
		await shot("个性化页_Beta没有记忆");

		console.log("\n④ 会话里点「去审核」，钩子页落在 Beta");
		await backToChat();
		await ui.click("[data-ly-hook-trust-banner] button");
		await pause(1500);
		const scope = (await text("[data-ly-project-scope]")).trim();
		check("钩子页的范围是 Beta", /Beta/.test(await visible("[data-ly-project-scope]").then((all) => all.join("|"))), scope);
		check("列出了 Beta 那条待信任的钩子", (await visible("main")).join("").includes("echo beta"), "");
		await shot("钩子页_落在Beta");

		console.log("\n⑤ 命令页选 Alpha，回去换到 Alpha 的会话再回来，选择还在");
		await section("命令");
		await clickText("[data-ly-project-scope]", /.*/.toString());
		await pause(600);
		await clickText("[role^=menuitem]", /^Alpha/.toString());
		await pause(900);
		const picked = (await visible("[data-ly-project-scope]")).join("|");
		check("命令页选上了 Alpha", picked.includes("Alpha"), picked);
		await backToChat();
		await openSession("Alpha 的会话");
		await ui.click("[data-ly-open-settings]");
		await pause(1500);
		const kept = (await visible("[data-ly-project-scope]")).join("|");
		check("换了会话回来，命令页还是 Alpha", kept.includes("Alpha"), kept);
		await shot("命令页_换会话后仍是Alpha");
		await pause(1000);
	} finally {
		await stop();
		const passed = checks.filter((one) => one.ok).length;
		const name = `${STAMP}_设置页不跟会话项目走_${passed}of${checks.length}.mp4`;
		await encode(frames, join(OUT_DIR, name), 30);
		await app.stop();
		console.log(`\n${passed}/${checks.length} 通过 → ${join(OUT_DIR, name)}`);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
