/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 生图模型在设置里自成一类——边验边录。
 *
 * 一个本地假服务：OpenAI 兼容的 `/v1/images/generations` 回一张 1×1 的 PNG，别的请求回一段空 SSE。
 * 设置里有一个对话模型，和一个挂着两种生图模型的供应商：`gpt-image-1` 靠名字认出来，`house-artist`
 * 靠存下的开关。没选默认生图模型。
 *
 * 用法：node --experimental-strip-types e2e/image-model-settings-probe.ts [before|after] [输出目录]
 */

import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSettings, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume生图模型设置测试");
const PORT = 9497;
const MODEL_PORT = 9597;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const imageRequests: Record<string, unknown>[] = [];

function startModel(): Server {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.url?.endsWith("/images/generations")) {
				imageRequests.push(JSON.parse(body));
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	const base = `http://127.0.0.1:${MODEL_PORT}`;
	const limits = { contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true };
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{
				id: "local", name: "Local", baseUrl: base, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
				models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", ...limits, supportsTools: true }],
			},
			{
				id: "img", name: "Image Relay", baseUrl: `${base}/v1`, api: "openai-chat-completions", apiKey: "image-key", enabled: true,
				models: [
					{ id: "img/gpt-image-1", providerId: "img", modelId: "gpt-image-1", name: "GPT Image 1", ...limits, supportsTools: false },
					{ id: "img/house-artist", providerId: "img", modelId: "house-artist", name: "House Artist", ...limits, supportsTools: false, imageOutput: true },
				],
			},
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
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

/** 等得到就是 true；改动前的界面上有些东西本来就不存在，那是一条不过的检查，不是脚本出错。 */
const appears = (app: RunningApp, expression: string, budget = 300) => until(app, expression, budget).then(() => true, () => false);

const MENU_MODELS = `[...document.querySelectorAll('[role="menu"] [data-model]')].map((row) => row.getAttribute("data-model"))`;
const ROW_OF = (modelId: string) => `document.querySelector('[data-ly-model-row="${modelId}"]')?.parentElement`;
const EDITOR_SWITCH = `[...document.querySelectorAll('[role="dialog"] label')].find((label) => label.innerText.startsWith("生图模型"))?.querySelector('[role="switch"]')`;
const CONTEXT_FIELD = `[...document.querySelectorAll('[role="dialog"] label, [role="dialog"] span')].some((el) => el.innerText?.trim() === "上下文窗口（token）")`;

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-image-model-settings-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await until(app, `document.querySelector("main textarea")`, 3600);
	const stop = await startRecording(PORT, frames_);
	await pause(800);

	// 一、输入框的模型菜单只列对话模型。
	await click(app, "main button:has(.ly-fit-probe)");
	await until(app, `document.querySelector('[role="menu"] [data-model]')`);
	await pause(1000);
	const chat = await app.evaluate<string[]>(MENU_MODELS);
	await capture("输入框_对话模型菜单");
	check("输入框的模型菜单里没有生图模型", chat.length > 0 && chat.every((id) => !id.startsWith("img/")), chat);
	await press(app, "Escape", 27);
	await pause(600);

	// 二、智能体页的生图模型：没选时是「自动」，显示第一个；菜单里只有生图模型。
	await openSettings(app, "智能体");
	const SELECT = `button[aria-label="生图模型"]`;
	if (await appears(app, `document.querySelector('${SELECT}')`)) {
		await app.evaluate(`document.querySelector('${SELECT}').scrollIntoView({ block: "center" })`);
		await frames(app, 30);
		await pause(800);
		const label = await app.evaluate<string>(`document.querySelector('${SELECT}').innerText.replace(/\\s+/g, " ").trim()`);
		check("没选默认生图模型时显示「GPT Image 1 · 自动」", label.includes("GPT Image 1") && label.includes("自动"), label);
		await capture("智能体_生图模型_自动");
		await click(app, SELECT);
		await until(app, `document.querySelector('[role="menu"] [data-model]')`);
		await pause(1000);
		const drawing = await app.evaluate<string[]>(MENU_MODELS);
		await capture("智能体_生图模型_菜单");
		check("生图模型菜单只列生图模型，名字认出的和开关打开的都在", JSON.stringify(drawing) === JSON.stringify(["img/gpt-image-1", "img/house-artist"]), drawing);
		await press(app, "Escape", 27);
		await pause(600);
	} else {
		await capture("智能体_没有生图模型这一行");
		check("智能体页有「生图模型」这一行", false, await app.evaluate<string[]>(`[...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).filter((l) => l.includes("图"))`));
	}

	// 三、模型列表：生图模型有标记，不显示上下文窗口，测试是真画一张，默认是另一项设置。
	await click(app, "nav button", "模型设置");
	await click(app, "[data-ly-provider-panes] button", "Image Relay", "includes");
	await until(app, `document.querySelector('[data-ly-model-row="gpt-image-1"]')`);
	await pause(800);
	const rows = await app.evaluate<{ id: string; marked: boolean; window: string }[]>(`["gpt-image-1", "house-artist"].map((id) => {
		const row = document.querySelector('[data-ly-model-row="' + id + '"]')?.parentElement;
		return { id, marked: Boolean(row?.querySelector('[role="img"][aria-label="生图模型"]')), window: row?.querySelector('[class*="w-[46px]"]')?.innerText.trim() ?? "?" };
	})`);
	await capture("模型设置_生图模型行");
	check("两个生图模型都标着「生图模型」", rows.every((row) => row.marked), rows);
	check("生图模型那一行不写上下文窗口", rows.every((row) => row.window === ""), rows);

	const testLabel = await app.evaluate<string | null>(`${ROW_OF("gpt-image-1")}?.querySelector('button[aria-label^="画一张小图"], button[aria-label^="测试"]')?.getAttribute("aria-label") ?? null`);
	check("测试按钮说的是「画一张小图测试（会计费）」", testLabel === "画一张小图测试（会计费）", testLabel);
	if (testLabel) {
		await app.evaluate(`${ROW_OF("gpt-image-1")}.querySelector('button[aria-label="${testLabel}"]').setAttribute("data-probe-test", "")`);
		await click(app, "[data-probe-test]");
		const result = `${ROW_OF("gpt-image-1")}?.querySelector("[data-ly-tip*='·']")?.getAttribute("data-ly-tip") ?? ""`;
		await appears(app, `${result}`, 900);
		await pause(800);
		const tip = await app.evaluate<string>(result);
		await capture("模型设置_画一张测试");
		check("测试真画了一张，结果写着「生成成功」", imageRequests.length === 1 && tip.includes("生成成功"), { requests: imageRequests.length, tip });
	}

	await app.evaluate(`${ROW_OF("gpt-image-1")}.querySelector('button[aria-label="更多操作"]')?.setAttribute("data-probe-more", "")`);
	if (await appears(app, `document.querySelector("[data-probe-more]")`, 60)) {
		await click(app, "[data-probe-more]");
		await until(app, `document.querySelector('[role="menu"] [role="menuitem"]')`);
		await pause(800);
		const items = await app.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.innerText.trim())`);
		await capture("模型设置_更多菜单");
		check("生图模型的菜单里是「设为默认生图模型」", items.includes("设为默认生图模型"), items);
		if (items.includes("设为默认生图模型")) {
			await click(app, '[role="menu"] [role="menuitem"]', "设为默认生图模型");
			let saved: { imageModelId?: string; defaultModelId?: string } = {};
			for (let i = 0; i < 20 && saved.imageModelId === undefined; i++) {
				await pause(250);
				saved = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
			}
			check("点了以后存下的是默认生图模型，对话的默认模型不动", saved.imageModelId === "img/gpt-image-1" && saved.defaultModelId === "local/scripted", saved);
		} else await press(app, "Escape", 27);
		await pause(600);
	}

	// 四、模型编辑器：开关跟着名字走，打开时藏起上下文与思考、工具。
	await click(app, "[data-ly-add-model]");
	const ID = `[role="dialog"] input[placeholder="deepseek-v4-flash"]`;
	await until(app, `document.querySelector('${ID}')`);
	await type(app, ID, "dall-e-3");
	await pause(800);
	const drawn = await app.evaluate<{ on: string | null; context: boolean }>(`({ on: ${EDITOR_SWITCH}?.getAttribute("aria-checked") ?? null, context: ${CONTEXT_FIELD} })`);
	await capture("模型编辑器_dall-e-3");
	check("填 dall-e-3：「生图模型」自动打开，上下文窗口收起", drawn.on === "true" && !drawn.context, drawn);
	await type(app, ID, "my-chat-model");
	await pause(800);
	const talked = await app.evaluate<{ on: string | null; context: boolean }>(`({ on: ${EDITOR_SWITCH}?.getAttribute("aria-checked") ?? null, context: ${CONTEXT_FIELD} })`);
	await capture("模型编辑器_my-chat-model");
	check("改成 my-chat-model：开关跟着关上，上下文窗口回来", talked.on === "false" && talked.context, talked);
	await press(app, "Escape", 27);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_生图模型设置_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
