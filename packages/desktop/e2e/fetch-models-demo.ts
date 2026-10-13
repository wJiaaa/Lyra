/* oxlint-disable no-console -- demo CLI that prints what the real window did */
/**
 * 拉取模型弹窗能删能加，模型列表能批量删——边验边录。
 *
 * 一个本地假服务按路径分两个供应商回 `/v1/models`：Relay A 列出 `dall-e-3`、`gpt-5`、
 * `gemini-3-flash-image`（第一次故意慢 2.5 秒），Relay B 列出它自己的。A 上已经有一个这次没被列出的
 * `old-model`；没有默认对话模型。
 *
 * 一、在 A 上点拉取，等的时候切到 B：A 的列表不能开在 B 上。
 * 二、回到 A 再拉：已添加的勾着、标「未列出」；按厂商搜得到；敲一个没列出的名字回车就加；取消勾选
 *     就是移除；应用以后默认对话模型是能对话的 `gpt-5`，不是排在前面的生图模型。
 * 三、模型列表：进「选择」勾两个，一次删掉。
 *
 * 用法：node --experimental-strip-types e2e/fetch-models-demo.ts [输出目录]
 */

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSettings, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume拉取模型测试");
const PORT = 9498;
const MODEL_PORT = 9598;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

let slowOnce = true;
function startModels(): Server {
	const server = createServer(async (req, res) => {
		const list = req.url?.startsWith("/a/") ? ["dall-e-3", "gpt-5", "gemini-3-flash-image"] : req.url?.startsWith("/b/") ? ["b-one", "b-two"] : null;
		if (!list || !req.url?.endsWith("/models")) {
			res.writeHead(404);
			res.end();
			return;
		}
		if (req.url.startsWith("/a/") && slowOnce) {
			slowOnce = false;
			await pause(2500);
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ data: list.map((id) => ({ id, object: "model" })) }));
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

const limits = { contextWindow: 128000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true };
async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	const base = `http://127.0.0.1:${MODEL_PORT}`;
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{ id: "a", name: "Relay A", baseUrl: `${base}/a/v1`, api: "openai-chat-completions", apiKey: "k", enabled: true, models: [{ id: "a/old-model", providerId: "a", modelId: "old-model", name: "old-model", ...limits }] },
			{ id: "b", name: "Relay B", baseUrl: `${base}/b/v1`, api: "openai-chat-completions", apiKey: "k", enabled: true, models: [{ id: "b/b-one", providerId: "b", modelId: "b-one", name: "b-one", ...limits }] },
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: null,
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
	}));
}

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

type Saved = { providers: { id: string; models: { id: string; modelId: string }[] }[]; defaultModelId: string | null };
async function saved(home: string): Promise<Saved> {
	return JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as Saved;
}
async function settled(home: string, done: (settings: Saved) => boolean): Promise<Saved> {
	let settings = await saved(home);
	for (let i = 0; i < 30 && !done(settings); i++) {
		await pause(200);
		settings = await saved(home);
	}
	return settings;
}
const idsOf = (settings: Saved, provider: string) => settings.providers.find((one) => one.id === provider)?.models.map((model) => model.modelId) ?? [];

const ROWS = (group: string) => `[...document.querySelectorAll('[data-ly-fetch-group="${group}"] [data-ly-fetch-row]')].map((row) => ({ id: row.getAttribute("data-ly-fetch-row"), state: row.getAttribute("data-ly-fetch-state"), text: row.innerText.replace(/\\s+/g, " ").trim() }))`;
const SEARCH = `[role="dialog"] input`;
const LIST_ROWS = `[...document.querySelectorAll("[data-ly-model-list] [data-ly-model-row]")].map((row) => row.getAttribute("data-ly-model-row"))`;

let app: RunningApp | undefined;
const server = startModels();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-fetch-models-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await until(app, `document.querySelector("main textarea")`, 3600);
	const stop = await startRecording(PORT, frames_);
	await pause(800);

	// 一、拉取途中换供应商。
	await openSettings(app, "模型设置");
	await click(app, "[data-ly-provider-panes] button", "Relay A", "includes");
	await until(app, `document.querySelector('[data-ly-model-row="old-model"]')`);
	await pause(600);
	await click(app, "button", "拉取模型", "includes");
	await pause(300);
	await click(app, "[data-ly-provider-panes] button", "Relay B", "includes");
	await until(app, `document.querySelector('[data-ly-model-row="b-one"]')`);
	await pause(3500);
	const leaked = await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-fetch-apply]"))`);
	await capture("拉取途中切到B_没有弹窗");
	check("A 的拉取在 B 上落地时被丢掉，B 上没有弹出 A 的列表", !leaked, { leaked });

	// 二、回到 A 再拉。
	await click(app, "[data-ly-provider-panes] button", "Relay A", "includes");
	await until(app, `document.querySelector('[data-ly-model-row="old-model"]')`);
	await pause(600);
	await click(app, "button", "拉取模型", "includes");
	await until(app, `document.querySelector("[data-ly-fetch-apply]")`, 600);
	await frames(app, 30);
	await pause(1000);
	const configured = await app.evaluate<{ id: string; state: string; text: string }[]>(ROWS("configured"));
	const available = await app.evaluate<{ id: string; state: string; text: string }[]>(ROWS("available"));
	await capture("拉取弹窗_打开");
	check("已添加的 old-model 默认勾着，标着「未列出」", configured.length === 1 && configured[0].state === "keep" && configured[0].text.includes("未列出"), configured);
	check("可添加的三个默认勾着", available.map((row) => row.id).sort().join() === "dall-e-3,gemini-3-flash-image,gpt-5" && available.every((row) => row.state === "add"), available);

	await type(app, SEARCH, "google");
	await pause(900);
	const google = await app.evaluate<{ id: string }[]>(ROWS("available"));
	await capture("拉取弹窗_按厂商搜google");
	check("搜「google」找得到 gemini", google.length === 1 && google[0].id === "gemini-3-flash-image", google);

	await type(app, SEARCH, "gpt-image-1");
	await pause(700);
	await press(app, "Enter", 13);
	await pause(900);
	const typed = await app.evaluate<{ id: string; state: string; text: string }[]>(ROWS("available"));
	check("敲一个接口没列出的名字回车，加进来标「手动添加」", typed.some((row) => row.id === "gpt-image-1" && row.state === "add" && row.text.includes("手动添加")), typed);
	await type(app, SEARCH, "");
	await press(app, "Backspace", 8);
	await pause(700);

	await click(app, '[data-ly-fetch-row="old-model"] button[role="checkbox"]');
	await pause(900);
	const removing = await app.evaluate<{ state: string; text: string }[]>(ROWS("configured"));
	const footer = await app.evaluate<string>(`document.querySelector("[data-ly-fetch-summary]")?.innerText.replace(/\\s+/g, " ").trim() ?? ""`);
	const applyLabel = await app.evaluate<string>(`document.querySelector("[data-ly-fetch-apply]").innerText.trim()`);
	await capture("拉取弹窗_一删四加");
	check("取消勾选 old-model：标「将移除」", removing[0]?.state === "remove" && removing[0].text.includes("将移除"), removing);
	check(`页脚分开写新增和移除（${footer}），按钮写「${applyLabel}」`, footer.includes("新增 4 个") && footer.includes("移除 1 个") && applyLabel === "应用 5 项更改", { footer, applyLabel });

	await click(app, "[data-ly-fetch-apply]");
	const applied = await settled(home, (settings) => !idsOf(settings, "a").includes("old-model"));
	await pause(900);
	await capture("应用之后_模型列表");
	const aIds = idsOf(applied, "a");
	check("应用后 A 上是那四个，old-model 没了", [...aIds].sort().join() === ["dall-e-3", "gemini-3-flash-image", "gpt-5", "gpt-image-1"].sort().join(), aIds);
	check("默认对话模型是 gpt-5，不是排在前面的生图模型", applied.defaultModelId === "a/gpt-5", applied.defaultModelId);
	check("B 没被动过", idsOf(applied, "b").join() === "b-one", idsOf(applied, "b"));

	// 三、批量删除。
	await click(app, "[data-ly-model-select]");
	await pause(600);
	await click(app, '[data-ly-model-row="dall-e-3"]');
	await pause(300);
	await click(app, '[data-ly-model-row="gemini-3-flash-image"]');
	await pause(700);
	const deleteLabel = await app.evaluate<string>(`document.querySelector("[data-ly-model-delete-selected]").innerText.trim()`);
	await capture("模型列表_选了两个");
	check(`选择模式里勾两行，按钮写「${deleteLabel}」`, deleteLabel === "删除 2 个", deleteLabel);
	await click(app, "[data-ly-model-delete-selected]");
	await until(app, `document.querySelector("[data-ly-modal]")`);
	await pause(900);
	await capture("批量删除_确认");
	await click(app, "[data-ly-modal] button", "删除");
	const removed = await settled(home, (settings) => idsOf(settings, "a").length === 2);
	await pause(1000);
	const left = await app.evaluate<string[]>(LIST_ROWS);
	await capture("批量删除_之后");
	check("确认后两个一起删掉，列表和存下的设置都只剩两个", [...idsOf(removed, "a")].sort().join() === "gpt-5,gpt-image-1" && [...left].sort().join() === "gpt-5,gpt-image-1", { saved: idsOf(removed, "a"), left });
	check("删完退出选择，「选择」回来了", await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-model-select]"))`), null);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_拉取模型与批量删除_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(server);
	if (home) await rm(home, { recursive: true, force: true });
}
