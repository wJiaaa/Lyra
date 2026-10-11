/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 环境卡片，在真窗口里从头点一遍：标题栏开关、让位、用什么打开、后台任务、子 Agent、侧边聊天、
 * 摘要（含设置里选的摘要模型）、引用（缩略图、文件、跳回那一轮）、逐节开关。
 *
 * 模型是本地一个假的 Anthropic 端点：摘要请求按系统提示认出来，回一段固定的话，并记下它点的是
 * 哪个模型；主会话收到 ENV_GO 时派一个后台命令和一个子 Agent，子 Agent 每一步慢几秒，好让「在跑」
 * 停得够久。拉取请求那一节要 GitHub 账号，这里不验。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/environment-card-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, openSettings, until } from "./drive.ts";
import { seedSessions, sideSession, type FixtureRecord } from "./session-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume环境面板测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9827;
const SESSION = "env-demo";
const SUMMARY_ONE = "在给登录页做改版：已收下设计稿和需求文档，新建了 src/new-page.tsx，生成了一张图标；接下来对接接口。";
const SUMMARY_TWO = "登录页改版进行中：设计稿、需求文档已收，新页面和图标已出；开发服务器在后台跑，子 Agent 查到登录入口在 src/auth.ts。";
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

/** 一张纯色 PNG：缩略图要真能解出来，才量得到 naturalWidth。 */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3]!)]);
	const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- 假模型 ----------

const seen = { summaries: [] as { model: string; prompt: string }[] };
type Tool = { name: string; input: Record<string, unknown> };

function reply(res: ServerResponse, answer: { text?: string; tools?: Tool[] }) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, type: "message", role: "assistant", content: [], model: "qa", stop_reason: null, usage: { input_tokens: 80, output_tokens: 0 } } });
	const tools = answer.tools ?? [];
	if (tools.length) {
		tools.forEach((tool, index) => {
			emit("content_block_start", { index, content_block: { type: "tool_use", id: `t${Math.random().toString(36).slice(2, 10)}`, name: tool.name, input: {} } });
			emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
			emit("content_block_stop", { index });
		});
	} else {
		emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: answer.text ?? "" } });
		emit("content_block_stop", { index: 0 });
	}
	emit("message_delta", { delta: { stop_reason: tools.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { model: string; system?: unknown; messages: { content: unknown }[] };
		const text = JSON.stringify(body.messages);
		if (JSON.stringify(body.system ?? "").includes("实时摘要")) {
			seen.summaries.push({ model: body.model, prompt: text });
			reply(res, { text: seen.summaries.length === 1 ? SUMMARY_ONE : SUMMARY_TWO });
			return;
		}
		// 只看最近那句 ENV_GO 之后的：种进去的历史里本来就有工具结果，不能当成这一轮已经派过了。
		const from = body.messages.findLastIndex((message) => JSON.stringify(message).includes("ENV_GO"));
		const answered = JSON.stringify(from >= 0 ? body.messages.slice(from) : body.messages).includes("tool_result");
		if (text.includes("ENV_GO")) {
			if (!answered) {
				reply(res, { tools: [
					{ name: "bash", input: { command: "sleep 600", description: "启动开发服务器", run_in_background: true } },
					{ name: "task", input: { description: "查登录入口", prompt: "SUB_TASK 找登录入口在哪", subagent_type: "explore" } },
				] });
			} else if (text.includes("src/auth.ts")) reply(res, { text: "子 Agent 查到了：登录入口在 `src/auth.ts`。开发服务器在后台跑着。" });
			else reply(res, { text: "等子 Agent 回来。" });
			return;
		}
		if (text.includes("SUB_TASK")) {
			// 子 Agent 慢一点：卡片上那一行要在「在跑」停得够久。
			setTimeout(() => reply(res, answered ? { text: "登录入口在 src/auth.ts。" } : { tools: [{ name: "read", input: { path: "README.md" } }] }), 5000);
			return;
		}
		reply(res, { text: "好的。" });
	});
});

// ---------- 数据 ----------

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(join(cwd, "src"), { recursive: true });
	await mkdir(join(cwd, "assets"), { recursive: true });
	await mkdir(join(cwd, "docs"), { recursive: true });
	await writeFile(join(cwd, "README.md"), "# 登录页改版\n");
	await writeFile(join(cwd, "src", "app.ts"), "export const app = 1;\n");
	await writeFile(join(cwd, "src", "new-page.tsx"), "export function NewPage() { return null; }\n");
	await writeFile(join(cwd, "docs", "需求.md"), "# 需求\n\n登录页改版。\n");
	await writeFile(join(cwd, "assets", "icon.png"), png(96, 96, [64, 140, 230]));
	const design = png(160, 120, [235, 120, 80]).toString("base64");

	const base = Date.now() - 3 * 3600_000;
	let clock = base;
	const at = () => (clock += 60_000);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason, timestamp: at() });
	const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: [{ type: "text", text }], timestamp: at(), ...extra });
	const result = (id: string, name: string, content: unknown[], details?: unknown) => ({ role: "toolResult", toolCallId: id, toolName: name, content, isError: false, ...(details ? { details } : {}), timestamp: at() });
	const filler = "这一段是为了让对话够长：".repeat(1) + "把登录页的布局、表单校验、错误提示和第三方登录按钮逐一过了一遍，确认和设计稿一致。".repeat(6);

	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "\n\n### Attachment 1 of 2: 设计稿.png\n\n" },
				{ type: "image", data: design, mimeType: "image/png" },
				{ type: "text", text: `照设计稿改登录页，需求见附件，入口在 @"src/app.ts"` },
			],
			displayText: `照设计稿改登录页，需求见附件，入口在 @"src/app.ts"`,
			attachments: [
				{ name: "设计稿.png", kind: "image", mimeType: "image/png" },
				{ name: "需求.md", mimeType: "text/markdown", path: join(cwd, "docs", "需求.md") },
			],
			timestamp: at(),
		},
		assistant([{ type: "text", text: "看过设计稿和需求了，先读一下现在的入口。" }, { type: "toolCall", id: "r1", name: "read", arguments: { path: "README.md" } }], "toolUse"),
		result("r1", "read", [{ type: "text", text: "# 登录页改版" }]),
		assistant([{ type: "text", text: "入口清楚了。" }]),
		user("先出一个应用图标"),
		assistant([{ type: "toolCall", id: "g1", name: "generate_image", arguments: { prompt: "a blue app icon" } }], "toolUse"),
		result("g1", "generate_image", [{ type: "text", text: "已生成 1 张图" }], { paths: [join(cwd, "assets", "icon.png")] }),
		assistant([{ type: "text", text: "图标放在 assets/icon.png。" }]),
		user("新建登录页组件，顺便把 README 改一下"),
		assistant([
			{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/new-page.tsx", content: "export function NewPage() { return null; }\n" } },
			{ type: "toolCall", id: "w2", name: "write", arguments: { path: "README.md", content: "# 登录页改版\n\n进行中。\n" } },
		], "toolUse"),
		result("w1", "write", [{ type: "text", text: "Created src/new-page.tsx" }], { created: true }),
		result("w2", "write", [{ type: "text", text: "Updated README.md" }], { created: false }),
		assistant([{ type: "text", text: "新页面建好了，README 也更新了。" }]),
		...Array.from({ length: 6 }, (_, n) => [user(`第 ${n + 4} 轮：再检查一遍细节`), assistant([{ type: "text", text: filler }])]).flat(),
	];
	const records: FixtureRecord[] = [];
	const meta = { id: SESSION, title: "登录页改版", cwd, projectId, projectName: "登录页改版", createdAt: base, updatedAt: clock, modelId: "qa/model", messageCount: messages.length, usage, seq: 0 };
	records.push({ type: "meta", meta, seq: 0, ts: base } as FixtureRecord);
	for (const message of messages) records.push({ type: "message", message, ts: (message as { timestamp: number }).timestamp } as FixtureRecord);
	// 一段侧边聊天：它是挂在这个会话旁边的一个会话。卡片先问主进程这个会话旁边有哪几段，再写标题。
	const side = sideSession(meta as never, [
		{ role: "user", content: [{ type: "text", text: "第三方登录按钮放上面还是下面？" }], timestamp: base + 30 * 60_000 },
		{ role: "assistant", content: [{ type: "text", text: "放在表单下面，和设计稿一致。" }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: base + 31 * 60_000 },
	] as never, { createdAt: base + 30 * 60_000, updatedAt: base + 31 * 60_000 });
	seedSessions(home, [{ meta: meta as never, records }, side]);

	const model = (id: string, name: string) => ({ id: `qa/${id}`, providerId: "qa", modelId: id, name, contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true, models: [model("model", "QA 主模型"), model("summary", "QA 摘要模型")] }],
		defaultModelId: "qa/model",
		// 选一个这台机器装着的，图标才是从系统里取来的真图（核心默认的 zed 不一定装了）。
		editor: { defaultOpenTarget: "vscode", showBottomPanel: true },
		summaryModelId: "qa/summary",
		autoSummarizeTitle: false,
		retryAttempts: 0,
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "登录页改版", pinned: true, lastOpenedAt: 1 }],
	}));
}

// ---------- 跑 ----------

let app: RunningApp | undefined;
const film: Frame[] = [];
const camera = { rolling: true };
let filming: Promise<void> | undefined;
let grab: Awaited<ReturnType<typeof frameGrabber>> | undefined;

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	const page = app;
	await page.send("Page.bringToFront");
	await page.evaluate("document.fonts.ready");
	grab = await frameGrabber(PORT);
	const grabber = grab;
	// 一帧一帧拍而不是 screencast：终端盖在窗口前面时，被盖住的窗口不合成，screencast 只给第一帧。
	filming = (async () => {
		while (camera.rolling) film.push({ at: Date.now(), data: await grabber.shot() });
	})();

	const $ = <T>(expression: string) => page.evaluate<T>(expression);
	const waitFor = async (expression: string, ms = 30_000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (await $<boolean>(`Boolean(${expression})`)) return;
			await pause(150);
		}
		throw new Error(`等不到：${expression}`);
	};
	const shot = async (name: string) => {
		const picture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	};
	const say = async (text: string) => {
		await until(page, `document.querySelector('[data-ly-chat-surface="conversation"] textarea')`);
		await $(`(()=>{const field=document.querySelector('[data-ly-chat-surface="conversation"] textarea');field.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
		await pause(400);
		await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	};
	const escape = async () => {
		await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await frames(page, 20);
	};
	const sections = () => $<string[]>(`[...document.querySelectorAll("[data-ly-environment] [data-ly-environment-section]")].map((s)=>s.getAttribute("data-ly-environment-section"))`);
	const tabOn = (kind: string) => $<boolean>(`[...document.querySelectorAll('[data-panel-tab=${JSON.stringify(kind)}]')].some((t)=>t.querySelector('[aria-selected="true"]'))`);
	const toggle = "[data-ly-toolbar-button]:has([data-ly-environment-toggle])";

	await openSession(page, SESSION);
	await pause(800);

	// 1. 标题栏开关
	const before = await $<{ pressed: string | null; card: boolean }>(`({pressed:document.querySelector(${JSON.stringify(toggle)})?.getAttribute("aria-pressed"),card:Boolean(document.querySelector("[data-ly-environment]"))})`);
	check("开关默认是关着的，卡片不在", before.pressed === "false" && !before.card, before);
	await shot("01_打开之前");
	await click(page, toggle);
	await waitFor(`document.querySelector("[data-ly-environment]")`);
	await pause(1000);
	const opened = await $<{ pressed: string | null; title: string }>(`({pressed:document.querySelector(${JSON.stringify(toggle)}).getAttribute("aria-pressed"),title:document.querySelector("[data-ly-environment]").innerText.split("\\n")[0]})`);
	check("点一下开关：按钮亮起、卡片出现，标题是「环境」", opened.pressed === "true" && opened.title === "环境", opened);

	// 2. 宽窗口里让位：卡片站在对话右侧，对话和输入框都让出 324px，互不重叠
	const lane = await $<{ card: { left: number; width: number }; composer: { right: number }; transcriptMargin: string; inTranscript: boolean }>(`(()=>{const c=document.querySelector("[data-ly-environment]").getBoundingClientRect();const composer=document.querySelector("main .ly-composer")?.getBoundingClientRect();const box=document.querySelector("[data-ly-environment]").closest("main");const styled=[...document.querySelectorAll("main [style]")].find((e)=>e.style.marginRight==="324px");return {card:{left:Math.round(c.left),width:Math.round(c.width)},composer:{right:Math.round(composer?.right??0)},transcriptMargin:styled?styled.style.marginRight:"",inTranscript:false};})()`);
	check("卡片宽 300px，输入框右沿在卡片左沿之左（让位，不重叠）", lane.card.width === 300 && lane.composer.right > 0 && lane.composer.right <= lane.card.left, lane);

	// 3. 各节都在、顺序对
	await waitFor(`document.querySelector("[data-ly-environment-section=sideChats]")`);
	const order = await sections();
	check("各节按顺序出现：打开 → 侧边聊天 → 摘要 → 引用（还没有后台任务和子 Agent，那两节不占位）", JSON.stringify(order) === JSON.stringify(["openIn", "sideChats", "summary", "references"]), order);

	// 4. 用什么打开：图标是真图，菜单能列出目标；不点下去，免得真的拉起外部应用
	const openIn = await $<{ label: string; icon: number; id: string }>(`(()=>{const b=document.querySelector("[data-ly-open-in]");const img=b.querySelector("img");return {label:b.innerText.trim(),icon:img?img.naturalWidth:-1,id:b.getAttribute("data-ly-open-in")};})()`);
	check("打开那一行写着设置里选的目标，图标是解出来的真图", openIn.label === "在 Visual Studio Code 中打开" && openIn.icon > 0, openIn);
	await click(page, '[aria-label="换一个打开方式"]');
	await waitFor(`document.querySelectorAll('[role="dialog"] [role^="menuitem"], [role="menu"] [role^="menuitem"]').length>0`);
	await pause(900);
	await shot("02_换一个打开方式的菜单");
	const targets = await $<string[]>(`[...document.querySelectorAll('[role^="menuitem"]')].filter((e)=>e.checkVisibility()).map((e)=>e.innerText.trim())`);
	check("点箭头展开目标菜单，至少列出一个目标", targets.length >= 1, targets);
	await escape();

	// 5. 摘要：卡片一开、会话早就静下来了，立刻去要；用的是设置里选的摘要模型
	await waitFor(`document.querySelector("[data-ly-environment-summary]")`, 20_000);
	await pause(800);
	const summary = await $<{ text: string; foot: string }>(`(()=>{const p=document.querySelector("[data-ly-environment-summary]");return {text:p.innerText.trim(),foot:p.nextElementSibling?.innerText.trim()??""};})()`);
	check("摘要显示出来，是模型给的那段话", summary.text === SUMMARY_ONE, summary.text);
	check("刚生成的摘要底下写「刚刚更新」", summary.foot === "刚刚更新", summary.foot);
	check("摘要请求打到了设置里选的摘要模型（qa/summary），不是会话模型", seen.summaries.length === 1 && seen.summaries[0]!.model === "summary", seen.summaries.map((s) => s.model));
	check("第一次摘要的材料里没有上一份", seen.summaries[0]?.prompt.includes("（没有）") === true, seen.summaries[0]?.prompt.slice(0, 80));
	const stored = JSON.parse(await readFile(join(page.home, "summaries", `${SESSION}.json`), "utf8")) as { text: string };
	check("摘要落在旁挂文件 summaries/<会话>.json", stored.text === SUMMARY_ONE, stored);
	await shot("03_卡片全貌_摘要和引用");

	// 6. 引用：两张图（附件、生成的），三个文件（附件、@ 引用、新建），改过的 README 和读过的不算
	const refs = await $<{ images: { name: string; loaded: number }[]; files: { name: string; turn: string }[]; count: string }>(`(()=>{const s=document.querySelector("[data-ly-environment-section=references]");return {images:[...s.querySelectorAll("[data-ly-environment-image]")].map((b)=>({name:b.dataset.lyTip,loaded:b.querySelector("img").naturalWidth})),files:[...s.querySelectorAll("[data-ly-environment-file]")].map((r)=>({name:r.querySelector("button").innerText.trim(),turn:r.querySelectorAll("button")[1].innerText.trim()})),count:s.querySelector(".tabular-nums").innerText};})()`);
	check("引用里两张缩略图都加载出来了：附件的设计稿、生成的图标", refs.images.length === 2 && refs.images.every((image) => image.loaded > 0) && refs.images[0]!.name.startsWith("设计稿.png") && refs.images[1]!.name.startsWith("icon.png"), refs.images);
	check("文件是需求.md（附件）、app.ts（@ 引用）、new-page.tsx（新建），各标着第几轮；README（改过）和读过的不在", JSON.stringify(refs.files) === JSON.stringify([{ name: "需求.md", turn: "第 1 轮" }, { name: "app.ts", turn: "第 1 轮" }, { name: "new-page.tsx", turn: "第 3 轮" }]), refs.files);
	check("标题上的数是 5", refs.count === "5", refs.count);

	// 点缩略图：图片查看器打开
	await click(page, "[data-ly-environment-image]");
	await waitFor(`document.querySelector('[role="dialog"][aria-modal]')`);
	await pause(1000);
	await shot("04_点缩略图放大");
	const viewer = await $<number>(`document.querySelector('[role="dialog"][aria-modal] img')?.naturalWidth ?? 0`);
	check("点缩略图打开图片查看器，大图解出来了", viewer > 0, viewer);
	await escape();
	await waitFor(`!document.querySelector('[role="dialog"][aria-modal]')`);

	// 「第 1 轮」：对话滚回那一问
	// 对话是虚拟化的：滚远了，第一问根本不在 DOM 里，那也算不在视野里。
	const scrolled = async () => $<{ top: number; boxTop: number; boxBottom: number } | null>(`(()=>{const q=document.querySelector('[data-question-index="0"]');if(!q)return null;const r=q.getBoundingClientRect();const box=document.querySelector("main").getBoundingClientRect();return {top:Math.round(r.top),boxTop:Math.round(box.top),boxBottom:Math.round(box.bottom)};})()`);
	const away = await scrolled();
	await click(page, "[data-ly-environment-file] button:last-child", "第 1 轮");
	await pause(1500);
	const back = await scrolled();
	check("点「第 1 轮」前第一问不在视野里，点完它回到视野里", (!away || away.top < away.boxTop || away.top > away.boxBottom) && back !== null && back.top >= back.boxTop && back.top < back.boxBottom - 100, { away, back });
	await shot("05_第1轮_跳回那一问");

	// 点文件名：项目里的文本文件在右侧面板打开
	await click(page, '[data-ly-environment-file="src/app.ts"] button:first-child');
	await waitFor(`[...document.querySelectorAll("[data-panel-tab]")].some((t)=>t.innerText.includes("app.ts"))`, 10_000);
	await pause(1200);
	await shot("06_点文件名在面板里打开");
	check("点 app.ts，右侧面板打开了它", true, await $<string[]>(`[...document.querySelectorAll("[data-panel-tab]")].map((t)=>t.innerText.trim())`));

	// 窄了就浮在对话上：面板开着时对话列变窄，卡片改到对话框里
	const narrow = await $<{ column: number; docked: boolean }>(`(()=>{const c=document.querySelector("[data-ly-environment]");const styled=[...document.querySelectorAll("main [style]")].some((e)=>e.style.marginRight==="324px");return {column:document.querySelector('[data-ly-chat-surface="conversation"]').clientWidth,docked:styled};})()`);
	check("对话列不够宽（< 844px）时不让位，卡片浮在对话上", narrow.column >= 844 ? narrow.docked : !narrow.docked, narrow);

	// 7. 侧边聊天：这个会话旁边的那一段列出来，标题是它问的第一句；点了在右侧打开
	const side = await $<string>(`document.querySelector("[data-ly-environment-side-chat]")?.innerText.replace(/\\s+/g," ").trim() ?? ""`);
	check("侧边聊天一行，写着它问的那句话", side.startsWith("第三方登录按钮放上面还是下面？"), side);
	await click(page, "[data-ly-environment-side-chat]");
	await waitFor(`document.querySelector('[data-panel-tab="chat"]')`, 10_000);
	await pause(1000);
	check("点侧边聊天，右侧打开的是它", await tabOn("chat"), await $<string[]>(`[...document.querySelectorAll("[data-panel-tab]")].map((t)=>t.getAttribute("data-panel-tab"))`));
	await shot("07_点侧边聊天");

	// 8. 跑一轮：派出后台命令和子 Agent
	await say("ENV_GO 把开发服务器跑起来，再派人查登录入口");
	await waitFor(`document.querySelector("[data-ly-environment-job]")`, 20_000);
	await waitFor(`document.querySelector("[data-ly-environment-sub-agent]")`, 20_000);
	await pause(1500);
	const live = await $<{ job: string; agent: string; state: string; order: string[]; stale: string }>(`(()=>{const j=document.querySelector("[data-ly-environment-job]");const a=document.querySelector("[data-ly-environment-sub-agent]");const p=document.querySelector("[data-ly-environment-summary]");return {job:j.innerText.trim(),agent:a.querySelector(".truncate").innerText.trim(),state:a.lastElementChild.innerText.trim(),order:[...document.querySelectorAll("[data-ly-environment] [data-ly-environment-section]")].map((s)=>s.getAttribute("data-ly-environment-section")),stale:p?.nextElementSibling?.innerText.trim()??""};})()`);
	await shot("08_跑着时_后台任务和子Agent");
	check("后台任务一行，写着它的说明", live.job.startsWith("启动开发服务器"), live.job);
	check("子 Agent 一行，写着它领的任务，在跑时是秒表", live.agent === "查登录入口" && /^\d+s$|^\d+m \d+s$/.test(live.state), { agent: live.agent, state: live.state });
	check("新的两节排在「打开」之后：后台任务 → 子 Agent", JSON.stringify(live.order.slice(0, 3)) === JSON.stringify(["openIn", "jobs", "subAgents"]), live.order);
	check("这一轮在跑：摘要底下说「有新消息，这一轮结束后更新」", live.stale === "有新消息，这一轮结束后更新", live.stale);

	// 点子 Agent：面板翻到它
	await click(page, "[data-ly-environment-sub-agent]");
	await waitFor(`document.querySelector('[data-panel-tab="subagents"]')`, 10_000);
	await pause(1200);
	const subPane = await $<boolean>(`[...document.querySelectorAll("[data-panel-tab]")].some((t)=>t.getAttribute("data-panel-tab")==="subagents")`);
	check("点子 Agent，右侧打开子 Agent 面板", subPane && (await tabOn("subagents")), subPane);
	await shot("09_点子Agent打开面板");

	// 等它做完：卡片里那一行变成「完成 · 用时」
	await waitFor(`document.querySelector("main")?.innerText.includes("登录入口在 \`src/auth.ts\`") || document.querySelector("main")?.innerText.includes("登录入口在 src/auth.ts")`, 60_000);
	await waitFor(`/已完成/.test(document.querySelector("[data-ly-environment-sub-agent]")?.lastElementChild?.innerText ?? "")`, 20_000);
	const ended = await $<string>(`document.querySelector("[data-ly-environment-sub-agent]").lastElementChild.innerText.trim()`);
	check("子 Agent 做完后那一行留着，写「已完成 · 用时」", /^已完成 · \d+s$/.test(ended), ended);

	// 点后台任务：任务面板翻到它
	await click(page, "[data-ly-environment-job] button");
	await waitFor(`document.querySelector('[data-panel-tab="tasks"]')`, 10_000);
	await pause(1000);
	const jobId = await $<string>(`document.querySelector("[data-ly-environment-job]").getAttribute("data-ly-environment-job")`);
	check("点后台任务，任务面板打开，列着这个任务", (await tabOn("tasks")) && (await $<boolean>(`Boolean(document.querySelector('[data-service-id=${JSON.stringify(jobId)}]'))`)), jobId);
	await shot("10_点后台任务打开任务面板");

	// 悬停出停止，点了它从卡片上消失
	await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await $<{ x: number; y: number }>(`(()=>{const r=document.querySelector("[data-ly-environment-job]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)) });
	await pause(500);
	await click(page, "[data-ly-environment-job] [aria-label]", "停止", "starts");
	await waitFor(`!document.querySelector("[data-ly-environment-job]")`, 15_000);
	check("悬停点停止，那一行从卡片上消失", true, "gone");

	// 9. 这一轮结束、静下来 35 秒后摘要自己更新，材料带着上一份
	await waitFor(`document.querySelector("[data-ly-environment-summary]")?.innerText.trim() === ${JSON.stringify(SUMMARY_TWO)}`, 70_000);
	await pause(800);
	check("一轮结束后摘要在上一份上更新了", seen.summaries.length === 2 && seen.summaries[1]!.prompt.includes(SUMMARY_ONE.slice(0, 12)), seen.summaries.map((s) => s.prompt.slice(0, 60)));
	await shot("11_摘要更新后");

	// 10. 齿轮里逐节开关
	await click(page, '[data-ly-environment] [aria-label="显示哪几节"]');
	await waitFor(`[...document.querySelectorAll('[role^="menuitem"]')].some((e)=>e.innerText.trim()==="引用")`);
	await pause(800);
	await shot("12_齿轮菜单");
	await click(page, '[role^="menuitem"]', "引用");
	await frames(page, 20);
	const withoutRefs = await sections();
	check("在齿轮里关掉「引用」，那一节就不见了", !withoutRefs.includes("references"), withoutRefs);
	await click(page, '[role^="menuitem"]', "引用");
	await frames(page, 20);
	check("再勾上，它回来了", (await sections()).includes("references"), await sections());
	await escape();

	// 11. 设置里的摘要模型那一行
	await openSettings(page, "智能体");
	await waitFor(`document.body.innerText.includes("会话摘要模型")`, 10_000);
	await $(`[...document.querySelectorAll("*")].find((e)=>e.children.length===0&&e.textContent.trim()==="会话摘要模型")?.scrollIntoView({block:"center"})`);
	await pause(1000);
	await shot("13_设置里的会话摘要模型");
	const row = await $<string>(`(()=>{const label=[...document.querySelectorAll("*")].find((e)=>e.children.length===0&&e.textContent.trim()==="会话摘要模型");let n=label;for(let i=0;i<6&&n&&!n.querySelector("button");i++)n=n.parentElement;return n?n.innerText.replace(/\\s+/g," ").trim():"";})()`);
	check("设置「会话」分组里有「会话摘要模型」，选中的是 QA 摘要模型", row.includes("QA 摘要模型"), row);
	// 设置是整页，点导航里的「返回工作区」回到会话。
	await click(page, "nav button", "返回工作区", "includes");
	await until(page, `document.querySelector('[data-ly-chat-surface="conversation"]')`);
	await pause(800);

	// 12. 关掉卡片：对话收回让出的位置
	await click(page, toggle);
	await waitFor(`!document.querySelector("[data-ly-environment]")`);
	await pause(800);
	const closed = await $<{ pressed: string | null; margin: boolean }>(`({pressed:document.querySelector(${JSON.stringify(toggle)}).getAttribute("aria-pressed"),margin:[...document.querySelectorAll("main [style]")].some((e)=>e.style.marginRight==="324px")})`);
	check("再点开关：卡片收起，按钮熄灭，对话不再让位", closed.pressed === "false" && !closed.margin, closed);
	await shot("14_关掉之后");
} catch (error) {
	if (app) {
		const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_失败现场.png`), Buffer.from(picture.data, "base64"));
		console.log(await app.evaluate<string>(`document.querySelector("[data-ly-environment]")?.innerText ?? "(没有卡片)"`).catch(() => ""));
	}
	throw error;
} finally {
	camera.rolling = false;
	await filming?.catch(() => {});
	grab?.close();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_环境面板_${passed}of${checks.length}.mp4`);
await encode(film, video, 30, 1500);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
