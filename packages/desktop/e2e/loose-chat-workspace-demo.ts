/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 「新对话（不在项目中）」开出来的两段对话，各在自己的目录里：后一段看不到前一段写下的文件。边验边录。
 *
 * 从前它们都跑在同一个 `workspaces/general`。一段对话第一步 `ls`，看到的是之前每一段聊天留下的
 * 文件，模型把别人的宣传页当成了用户的设计偏好。
 *
 * 假模型是本地的 Anthropic 流式接口：第一段对话里它调 `write` 写一份笔记，第二段里它调 `ls`
 * 看工作目录，再把看到的照原样说出来。
 *
 * 用法：node --experimental-strip-types e2e/loose-chat-workspace-demo.ts [标签] [输出目录]
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "修复后";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume聊天各自目录测试");
const PORT = 9743;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const FIRST = "第一段对话：帮我记一份笔记";
const SECOND = "第二段对话：看看工作目录里有什么";
const NOTE = "第一段对话的笔记.md";
/** 修复前的一段旧聊天留在共享目录里的文件——原来那次就是一份宣传页。 */
const LEFTOVER = "旧聊天留下的宣传页.html";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------------------------
// 假模型
// ---------------------------------------------------------------------------------------------

/** 第二段对话里 `ls` 的结果，模型收到的原文。 */
let listing: string | null = null;

function sse(res: ServerResponse, type: string, data: object): void {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function reply(res: ServerResponse, turn: number, block: { text: string } | { tool: string; input: object }): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	sse(res, "message_start", { message: { id: `demo-${turn}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	if ("text" in block) {
		sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
	} else {
		sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: `call-${turn}`, name: block.tool, input: {} } });
		sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
	}
	sse(res, "content_block_stop", { index: 0 });
	sse(res, "message_delta", { delta: { stop_reason: "text" in block ? "end_turn" : "tool_use" }, usage: { output_tokens: 20 } });
	sse(res, "message_stop", {});
	res.end();
}

type Block = { type: string; text?: string; content?: unknown };

function startModel(): Server {
	let turn = 0;
	return createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			turn += 1;
			const { messages } = JSON.parse(body) as { messages: { role: string; content: string | Block[] }[] };
			const blocks = (m: (typeof messages)[number]): Block[] => typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
			const asked = blocks(messages[0]).map((b) => b.text ?? "").join("");
			const result = blocks(messages[messages.length - 1]).find((b) => b.type === "tool_result");
			if (!asked.includes(FIRST) && !asked.includes(SECOND)) return reply(res, turn, { text: "标题" });
			if (asked.includes(FIRST)) return reply(res, turn, result ? { text: `记好了：${NOTE}` } : { tool: "write", input: { path: NOTE, content: "第一段对话写下的内容\n" } });
			if (!result) return reply(res, turn, { tool: "ls", input: {} });
			listing = JSON.stringify(result.content);
			return reply(res, turn, { text: listing.includes(NOTE) ? `目录里有：${NOTE}` : "目录是空的，没有别的对话留下的文件。" });
		});
	});
}

// ---------------------------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------------------------

let app: RunningApp;
let shots = 0;

async function screenshot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shots++;
	await writeFile(join(OUT_DIR, `${STAMP}_${String(shots).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
}

const pane = () => app.evaluate<string>(`document.querySelector('[data-dock-pane="conversation"]')?.innerText ?? ""`);
const COMPOSER = '[data-dock-pane="conversation"] textarea';

async function newLooseChat(text: string, done: string): Promise<void> {
	await click(app, "button", "新对话（不在项目中）");
	await pause(800);
	await type(app, COMPOSER, text);
	await pause(500);
	await press(app, "Enter", 13);
	await until(app, `document.querySelector('[data-dock-pane="conversation"]')?.innerText.includes(${JSON.stringify(done)}) && !document.querySelector('[data-composer-send="stop"]')`, 1200);
	await pause(1200);
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const model = startModel();
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("假模型没起来");
	const frames: Frame[] = [];
	try {
		app = await startApp({
			port: PORT,
			seed: async (home) => {
				await seedInteractions(home, address.port);
				const path = join(home, "settings.json");
				const settings = JSON.parse(await readFile(path, "utf8"));
				await writeFile(path, JSON.stringify({ ...settings, uiLocale: "zh-CN", permissionMode: "full", projectMemory: false, thinking: "off" }));
				// 修复前就存在的一段聊天：跑在共享的 general 里，还在那儿留了个文件。「聊天」分组也要有它才显示。
				const general = join(home, "workspaces", "general");
				await mkdir(general, { recursive: true });
				await writeFile(join(general, LEFTOVER), "<h1>云舵</h1>\n");
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				const message = { role: "user" as const, content: [{ type: "text" as const, text: "做一个宣传页" }], timestamp: 1 };
				const meta = { id: "old-chat", title: "旧聊天：宣传页", projectId: createHash("sha256").update(general).digest("hex").slice(0, 16), projectName: "general",
					cwd: general, createdAt: 1, updatedAt: 3, modelId: "qa/model", messageCount: 1, usage, seq: 3 };
				seedSessions(home, [{ meta, records: [{ type: "meta", meta, ts: 1 }, { type: "message", message, ts: 1 }, { type: "meta", meta, ts: 2 }] }]);
			},
		});
		const stop = await startRecording(PORT, frames);
		const workspaces = join(app.home, "workspaces");

		console.log(`【${LABEL}】一、新开一段不在项目里的对话，模型写下一份笔记`);
		await newLooseChat(FIRST, "记好了");
		await screenshot("第一段对话写了笔记");

		console.log("二、再新开一段，模型看工作目录");
		await newLooseChat(SECOND, "目录");
		await screenshot("第二段对话看工作目录");
		const second = await pane();
		check("模型在第二段对话里 ls 到的结果没有第一段的笔记", listing !== null && !listing.includes(NOTE), listing ?? "没调 ls");
		check("也没有旧聊天留在 general 里的文件", listing !== null && !listing.includes(LEFTOVER), listing ?? "没调 ls");
		check("第二段对话的屏幕上说目录是空的", second.includes("目录是空的"), second.slice(-200).replace(/\s+/g, " "));

		console.log("三、磁盘上：两段对话各有一个目录，笔记只在第一段的那个里");
		const chats = join(workspaces, "chats");
		const dirs = existsSync(chats)
			? (await Promise.all((await readdir(chats)).map(async (day) => (await readdir(join(chats, day))).map((id) => join(chats, day, id))))).flat()
			: [];
		check("chats/ 下有两个目录", dirs.length === 2, `${dirs.length} 个：${dirs.join(", ")}`);
		check("笔记只在其中一个里", dirs.filter((dir) => existsSync(join(dir, NOTE))).length === 1, dirs.map((dir) => `${dir}: ${existsSync(join(dir, NOTE))}`).join("; "));
		check("共享的 general 里没有笔记", !existsSync(join(workspaces, "general", NOTE)), "general 里有笔记");
		check("旧聊天留下的文件原地未动", existsSync(join(workspaces, "general", LEFTOVER)), "不见了");

		console.log("四、侧边栏：两段都在「聊天」下，没有冒出新的项目分组");
		const sidebar = await app.evaluate<string>(`document.querySelector('nav, aside')?.innerText ?? ""`);
		check("侧边栏里新旧三段对话都在", sidebar.includes("第一段对话") && sidebar.includes("第二段对话") && sidebar.includes("旧聊天"), sidebar.replace(/\s+/g, " ").slice(0, 300));
		const ids = dirs.map((dir) => dir.split(/[/\\]/).pop() ?? "");
		check("侧边栏没有以目录名命名的分组", ids.every((id) => !sidebar.includes(id)), sidebar.replace(/\s+/g, " ").slice(0, 300));

		console.log("五、回到第一段对话、再打开旧聊天，都还能打开");
		await click(app, "[data-ly-row]", "第一段对话", "includes");
		await pause(1500);
		await screenshot("回到第一段对话");
		check("第一段对话打开后还能看到写笔记的那一轮", (await pane()).includes("记好了"), (await pane()).slice(-200).replace(/\s+/g, " "));
		await click(app, "[data-ly-row]", "旧聊天", "includes");
		await pause(1500);
		check("修复前那段旧聊天照常打开", (await pane()).includes("做一个宣传页"), (await pane()).slice(-200).replace(/\s+/g, " "));
		await pause(1000);
		await stop();
	} finally {
		await app?.stop().catch(() => {});
		await closeListeningServer(model);
	}
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_两段聊天各自的目录_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过，录像与截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
