/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 计划存在会话历史里：应用刚启动、内存里什么都没有时，交过计划的对话在「面板」菜单里有「计划」，
 * 点开就是那份计划；没交过的对话菜单里没有这一项。
 *
 * 三场对话都是直接写进磁盘的会话日志，不经模型——等同于「上次交了计划，这次重开应用」。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/plan-history-demo.ts [输出目录]`
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { startApp, type RunningApp } from "./app.ts";
import { click, closeTab, openPane, openSession, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume计划保存测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9873;
const PANE = '[data-dock-content="plan"]';
const MENU_ITEMS = `[...document.querySelectorAll('[role="menuitem"]')].map(e=>e.textContent.trim())`;

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const TITLE = "登录改成 OAuth";
const CHANGES = [
	"抽出写会话的那段，给 OAuth 复用",
	"加 OAuth 回调路由，换取 token 后写会话（`src/auth/oauth.ts`）",
	"补回调和会话写入的测试",
];
/** 计划是一段 Markdown，照 codex 的 `<proposed_plan>`：标题、概要、主要改动、测试、假设。 */
const planOf = (changes: string[]) => ({
	plan: [`# ${TITLE}`, "", "## 概要", "加一条 OAuth 回调路由，换到 token 后复用现有的写会话；登录页换成「用 GitHub 登录」按钮。", "", "## 主要改动", ...changes.map((change) => `- ${change}`), "", "## 测试", "- 跑 oauth 的测试", "- 本地点一次「用 GitHub 登录」，走完回调后会话里有用户", "", "## 假设", "- 线上和本地用同一个 OAuth 应用，回调地址分别配置"].join("\n"),
});
const PLAN = planOf(CHANGES);

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# plan history\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const said = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp });
	const planned = (id: string, details: object) => [
		{ role: "user", content: [{ type: "text", text: "登录这块想换成 OAuth。" }], timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id, name: "submit_plan", arguments: PLAN }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "toolUse", timestamp: 2 },
		{ role: "toolResult", toolCallId: id, toolName: "submit_plan", content: [{ type: "text", text: "ok" }], isError: false, details, timestamp: 3 },
	];
	const session = (id: string, title: string, messages: object[], updatedAt: number) => {
		const meta = { id, title, cwd, projectId, projectName: "计划保存", createdAt: 1, updatedAt, modelId: "qa/model", messageCount: messages.length, usage, seq: messages.length + 1 };
		return { meta, records: [
			{ type: "meta", meta, seq: 0, ts: 1 },
			...messages.map((message, index) => ({ type: "message", message, seq: index + 1, ts: index + 1 })),
			{ type: "meta", meta, seq: messages.length + 1, ts: messages.length + 1 },
		] };
	};
	seedSessions(home, [
		session("plan-approved", "批准过计划", [...planned("plan-a", { kind: "plan", plan: { ...PLAN, approvedAt: 3 } }), said("开始做第一步。", 4)], 30),
		session("plan-declined", "打回过计划", [...planned("plan-b", { kind: "plan-feedback", feedback: "再想想" }), said("好，我再想想。", 4)], 20),
		session("no-plan", "没有计划", [{ role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1 }, said("你好。", 2)], 10),
	]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "ask",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "计划保存", pinned: true, lastOpenedAt: 1 }],
	}));
}

let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

async function photo(name: string) {
	await mkdir(out, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(image.data, "base64"));
}

async function menu(): Promise<string[]> {
	await click(app!, 'button[aria-label="面板"]');
	await until(app!, `document.querySelector('[role="menuitem"]')`);
	await pause(700);
	return app!.evaluate<string[]>(MENU_ITEMS);
}

async function closeMenu() {
	await app!.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await app!.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await until(app!, `!document.querySelector('[role="menuitem"]')`);
	await pause(400);
}

async function pane() {
	return app!.evaluate<{ shown: boolean; h1: string; changes: number; status: string; hint: boolean }>(`(()=>{
		const pane=document.querySelector(${JSON.stringify(PANE)});
		return {
			shown:Boolean(pane&&pane.checkVisibility({visibilityProperty:true})),
			h1:pane?.querySelector('[data-plan-body] h1')?.textContent??"",
			changes:[...(pane?.querySelectorAll('[data-plan-body] h2')??[])].find(e=>e.textContent==="主要改动")?.nextElementSibling?.querySelectorAll('li').length??0,
			status:pane?.querySelector('[data-plan-status]')?.textContent??"",
			hint:Boolean(pane?.querySelector('[data-plan-hint]')),
		};
	})()`);
}

try {
	app = await startApp({ port: PORT, seed: (home) => seed(home) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");

	await openSession(app, "no-plan");
	await pause(900);
	const bare = await menu();
	check("没交过计划的对话：「面板」菜单里没有「计划」", bare.length > 0 && !bare.some((item) => item.startsWith("计划")), bare);
	await photo("01_没有计划的对话菜单");
	await closeMenu();

	await openSession(app, "plan-approved");
	await pause(900);
	const listed = await menu();
	check("交过计划的对话：刚启动、内存里没有审阅记录，菜单里也有「计划」", listed.some((item) => item.startsWith("计划")), listed);
	await photo("02_有计划的对话菜单");
	await closeMenu();

	await openPane(app, "计划");
	await until(app, `document.querySelector(${JSON.stringify(`${PANE} [data-plan-body]`)})`, 600);
	await pause(1200);
	const approved = await pane();
	check("点开就是会话历史里那份计划：标题、三处改动、标「已批准」，没有评论提示", approved.shown && approved.h1 === TITLE && approved.changes === 3 && approved.status === "已批准" && !approved.hint, approved);
	await photo("03_重开后的计划面板_已批准");

	await openSession(app, "plan-declined");
	await pause(900);
	await openPane(app, "计划");
	await until(app, `document.querySelector(${JSON.stringify(`${PANE} [data-plan-status]`)})`, 600);
	await pause(1200);
	const declined = await pane();
	check("打回过的计划也读得到，标「未批准」", declined.shown && declined.changes === 3 && declined.status === "未批准", declined);
	await photo("04_打回过的计划_未批准");
	await closeTab(app, "plan");
	await pause(600);

	await openSession(app, "no-plan");
	await pause(900);
	const stillBare = await menu();
	check("切回没有计划的对话，菜单里还是没有「计划」", !stillBare.some((item) => item.startsWith("计划")), stillBare);
	await closeMenu();
	await pause(600);
} catch (error) {
	check("验证脚本跑完", false, String(error));
	await photo("失败现场").catch(() => {});
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await mkdir(out, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_计划存进会话历史_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
