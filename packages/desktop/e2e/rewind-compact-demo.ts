/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 撤回、编辑重发、手动压缩——在真窗口里各走一遍，边验边录。
 *
 * 这三样在 core 里刚从 `session.ts` 搬到 `session-rewind.ts` 和 `manual-compaction.ts`，单测从会话
 * 对象往下验过；这里补的是从按钮往下的那一段：点「撤回」之后转录真的少了那两条、话回到输入框；
 * 编辑重发之后，模型收到的请求里**没有**被截掉的那条旧回答；`/compact` 之后下一次请求真的变短了。
 *
 * 模型是本机起的一个假的 Anthropic 接口（照 `ask-user-card-demo.ts`），不碰任何真实凭据；它记下
 * 每一次请求带了哪些消息，后面几条断言读的就是它。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/rewind-compact-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";
import { driver, encode, frameGrabber, pause, startRecording, type Frame } from "./record.ts";
import { zhCN as zh } from "../src/i18n/messages/zh-CN.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume撤回与压缩测试");
const PORT = 9433;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION_ID = "rewind-compact";
const PAIRS = 8;
const question = (n: number) => `第${n}个问题：${"把这一段需求再细化一下，".repeat(6)}`;
/** Long enough that a summary is smaller than what it replaces — otherwise compaction rightly declines. */
const answer = (n: number) => `第${n}个回答：${"已经按要求处理好了，涉及的文件、命令和输出都列在下面。".repeat(120)}`;
const EDITED = "第7个问题（改过）：只要结论";

let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** Every request the fake model received: the text of each message, in order. */
const requests: string[][] = [];

function fakeModel() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: { content: string | { type: string; text?: string }[] }[] };
			// The runtime sends an <env> block, as its own trailing message; what the person said is the last text left.
			const texts = body.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")).replace(/<env>[\s\S]*?<\/env>/g, "").trim());
			requests.push(texts);
			res.writeHead(200, { "content-type": "text/event-stream" });
			reply(res, `回答：${(texts.findLast((t) => t) ?? "").slice(0, 20)}`);
		});
	});
}

function reply(res: ServerResponse, text: string) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# rewind\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION_ID, title: "撤回与压缩", cwd, projectId, projectName: "演示", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: PAIRS * 2, usage, seq: 0 };
	const records: object[] = [{ type: "meta", meta, seq: 0, ts: 1 }];
	for (let n = 1; n <= PAIRS; n++) {
		records.push({ type: "message", message: { role: "user", content: [{ type: "text", text: question(n) }], timestamp: n * 10 }, seq: records.length, ts: n * 10 });
		records.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer(n) }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: n * 10 + 1 }, seq: records.length, ts: n * 10 + 1 });
	}
	seedSessions(home, [{ meta, records }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: 1 }],
	}));
}

const text = () => app.evaluate<string>("document.body.innerText");
const userIndices = () => app.evaluate<number[]>('[...document.querySelectorAll("[data-question-index]")].map((el) => Number(el.getAttribute("data-question-index")))');

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	const server = fakeModel();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port), scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	const grab = await frameGrabber(PORT);
	const shoot = async (name: string) => {
		const { data } = await grab.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(data, "base64"));
	};
	const field = () => app.evaluate<string>('(() => document.querySelector("main textarea")?.value ?? "")()');
	/** A real mouse only reaches what is on screen: bring the target into view first. */
	const clickInView = async (selector: string) => {
		await d.until(`document.querySelector(${JSON.stringify(selector)})`, 15000);
		await app.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
		await pause(500);
		await d.click(selector);
	};

	try {
		console.log("【一】打开一段八问八答的会话");
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1000);
		await d.click(`[data-ly-row="${SESSION_ID}"]`);
		await d.until(`document.body.innerText.includes("第8个回答")`, 20000);
		await pause(1200);
		check("八问八答都在", (await userIndices()).length === PAIRS, JSON.stringify(await userIndices()));
		await shoot("01_打开会话");

		console.log("\n【二】撤回最后一问");
		const last = Math.max(...(await userIndices()));
		await clickInView(`[data-question-index="${last}"] [data-message-undo]`);
		await d.until(`!document.body.innerText.includes("第8个回答")`, 10000).catch(() => {});
		await pause(1200);
		const afterUndo = await text();
		check("最后一问和它的回答都不在转录里了", !afterUndo.includes("第8个问题") && !afterUndo.includes("第8个回答"), afterUndo.slice(-300));
		check("撤回的那句话回到了输入框", (await field()).startsWith("第8个问题"), (await field()).slice(0, 40));
		check("没有因此去问模型", requests.length === 0, `请求了 ${requests.length} 次`);
		await shoot("02_撤回之后");
		await d.type("");
		await pause(800);

		console.log("\n【三】编辑第七问再发");
		const seventh = Math.max(...(await userIndices()));
		await clickInView(`[data-question-index="${seventh}"] button[aria-label="${zh["userMessage.editResend"]}"]`);
		await d.until(`document.querySelector('[data-question-index="${seventh}"] textarea')`, 10000);
		await pause(800);
		await app.evaluate(`(() => {
			const el = document.querySelector('[data-question-index="${seventh}"] textarea');
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(EDITED)});
			el.dispatchEvent(new Event("input", { bubbles: true }));
		})()`);
		await pause(900);
		await app.evaluate(`document.querySelector('[data-question-index="${seventh}"] textarea').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
		await d.until(`document.body.innerText.includes("回答：第7个问题（改过）")`, 20000).catch(() => {});
		await pause(1500);
		const afterEdit = await text();
		check("改过的那问在转录里，旧的第七问答不在了", afterEdit.includes(EDITED) && !afterEdit.includes("第7个回答"), afterEdit.slice(-300));
		check("模型回答了改过的那问", afterEdit.includes("回答：第7个问题（改过）"), afterEdit.slice(-200));
		const sent = requests.at(-1) ?? [];
		const spoken = sent.findLast((t) => t) ?? "";
		check("发给模型的最后一句人话是改过的那句", spoken.includes(EDITED), spoken.slice(0, 40));
		check("发给模型的历史里没有被截掉的旧回答", !sent.some((t) => t.includes("第7个回答") || t.includes("第8个")), `${sent.length} 条`);
		const beforeCompact = sent.length;
		await shoot("03_编辑重发之后");

		console.log("\n【四】/compact");
		const asked = requests.length;
		await d.type("/compact");
		await pause(900);
		await d.submit();
		await pause(800);
		if ((await field()).trim()) await d.submit();
		await d.until('document.querySelector("[data-command-status=done], [data-command-status=skipped], [data-command-status=failed]")', 30000).catch(() => {});
		await pause(1500);
		const status = await app.evaluate<string>('document.querySelector("[data-command-run]")?.getAttribute("data-command-status") ?? "(没有命令行)"');
		const line = await app.evaluate<string>('document.querySelector("[data-command-run]")?.innerText ?? ""');
		check("压缩成功", status === "done", `${status}：${line}`);
		check("命令行说的是压缩前后各几条", /已压缩上下文：\d+ 条消息整理为 \d+ 条/.test(line), line);
		check("压缩真的问过模型一次（生成摘要）", requests.length === asked + 1, `请求从 ${asked} 到 ${requests.length}`);
		await shoot("04_压缩之后");

		console.log("\n【五】压缩之后再说一句，请求要比压缩前短");
		await d.type("继续");
		await pause(600);
		await d.submit();
		await d.until(`document.body.innerText.includes("回答：继续")`, 20000).catch(() => {});
		await pause(1500);
		const after = requests.at(-1) ?? [];
		check("模型回答了", (await text()).includes("回答：继续"), "");
		check("下一次请求带的消息比压缩前少", after.length < beforeCompact, `压缩前 ${beforeCompact} 条，之后 ${after.length} 条`);
		await shoot("05_压缩后再发");
		await pause(1200);
	} finally {
		grab.close();
		await stop();
		server.close();
		console.log(`\n采到 ${frames.length} 帧，正在合成 60fps…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_撤回编辑重发与手动压缩_${passed}of${checks.length}.mp4`);
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
