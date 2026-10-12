/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 一轮收尾就越线时，趁缓存还热先压掉——在真窗口里走一遍，边验边录。
 *
 * core 的单测验过分叉请求的字节前缀（`compaction-fork.test.ts`）和会话层的时机（`idle-compaction.test.ts`）；
 * 这里补的是从界面看得见的那一段：回答一落地，「自动压缩」卡片就出现、输入框进入「进行中」；这时打的
 * 话排在压缩后面，压完才发出去，而且带的是压过之后的短历史。摘要请求本身照真实的 Anthropic 请求体
 * 比对：模型、系统提示词、工具都和上一次一样，上一次的消息原样是它的开头。
 *
 * 模型是本机起的假 Anthropic 接口，不碰任何真实凭据。摘要故意晚几秒才回，好让「进行中」看得见。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/idle-compaction-demo.ts [输出目录]`
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

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume压缩分叉测试");
const PORT = 9434;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION_ID = "idle-compact";
const PAIRS = 8;
// 窗口 128k，触发线 115200（90%）：最后一个回答报 117000，刚好越线，还给分叉的摘要留得下位置。
const WINDOW = 128_000;
const OVER_LINE = 117_000;
const SUMMARY_DELAY_MS = 5000;
const question = (n: number) => `第${n}个问题：${"把这一段需求再细化一下，".repeat(6)}`;
const answer = (n: number) => `第${n}个回答：${"已经按要求处理好了，涉及的文件、命令和输出都列在下面。".repeat(120)}`;
const ASK = "第9个问题：把整体结论汇总一下";
const QUEUED = "压缩期间打的这句";
const SUMMARY = "## Goal & Original User Intent\n把八个问题逐个细化，最后汇总结论。";

let app: RunningApp;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

interface Body { model: string; system?: unknown; tools?: unknown; thinking?: unknown; metadata?: unknown; messages: { role: string; content: string | { type: string; text?: string }[] }[] }
interface Seen { kind: "main" | "summary"; body: Body; at: number; done?: number }
const seen: Seen[] = [];

const textOf = (m: Body["messages"][number]) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(""));
/** 缓存断点会随末尾移动，它不属于前缀本身。 */
const bare = (value: unknown) => JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v));

function fakeModel() {
	return createServer((req, res) => {
		// 攒齐了再解码：逐块拼字符串会把跨块的汉字拆成乱码，前缀比对就成了在比假服务器自己的错。
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
			const last = textOf(body.messages.at(-1)!);
			const entry: Seen = { kind: last.includes("## Goal & Original User Intent") ? "summary" : "main", body, at: Date.now() };
			seen.push(entry);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (entry.kind === "summary") {
				setTimeout(() => { reply(res, SUMMARY, 300); entry.done = Date.now(); }, SUMMARY_DELAY_MS);
				return;
			}
			// 日期块是单独接在末尾的一条，人说的话是去掉它以后剩下的最后一段文字。
			const asked = body.messages.map((m) => textOf(m).replace(/<env>[\s\S]*?<\/env>/g, "").trim()).findLast((t) => t) ?? "";
			reply(res, `回答：${asked.slice(0, 12)}`, asked.includes("第9个问题") ? OVER_LINE : 2000);
			entry.done = Date.now();
		});
	});
}

function reply(res: ServerResponse, text: string, input: number) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: input, output_tokens: 0 } } });
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
	await writeFile(join(cwd, "README.md"), "# idle compact\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION_ID, title: "收尾时压缩", cwd, projectId, projectName: "演示", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: PAIRS * 2, usage, seq: 0 };
	const records: object[] = [{ type: "meta", meta, seq: 0, ts: 1 }];
	for (let n = 1; n <= PAIRS; n++) {
		records.push({ type: "message", message: { role: "user", content: [{ type: "text", text: question(n) }], timestamp: n * 10 }, seq: records.length, ts: n * 10 });
		records.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer(n) }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: n * 10 + 1 }, seq: records.length, ts: n * 10 + 1 });
	}
	seedSessions(home, [{ meta, records }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: WINDOW, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: 1 }],
	}));
}

const card = () => app.evaluate<{ status: string; phase: string; text: string } | null>(
	'(() => { const el = document.querySelector("[data-auto-compaction]"); return el ? { status: el.getAttribute("data-command-status"), phase: el.getAttribute("data-auto-compaction"), text: el.innerText } : null; })()',
);
const stopShown = () => app.evaluate<boolean>('Boolean(document.querySelector("main [data-composer-send=stop]"))');

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

	try {
		console.log("【一】打开一段八问八答的会话");
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1000);
		await d.click(`[data-ly-row="${SESSION_ID}"]`);
		await d.until(`document.body.innerText.includes("第8个回答")`, 20000);
		await pause(1200);
		check("会话里还没有自动压缩", (await card()) === null, JSON.stringify(await card()));
		await shoot("01_压缩之前");

		console.log("\n【二】问第九个问题，回答报出越线的用量");
		await d.type(ASK);
		await pause(700);
		await d.submit();
		await d.until(`document.body.innerText.includes("回答：第9个问题")`, 20000);
		await d.until('document.querySelector("[data-auto-compaction]")', 10000).catch(() => {});
		await pause(800);
		const running = await card();
		check("回答落地后出现「自动压缩」卡片", running !== null && running.text.includes("自动压缩"), JSON.stringify(running));
		check("卡片在生成摘要", running?.status === "running" && running.phase === "summarizing", JSON.stringify(running));
		check("输入框处于进行中（有停止按钮）", await stopShown(), "没有停止按钮");
		await shoot("02_收尾后自动压缩进行中");

		console.log("\n【三】压缩期间说一句，要排在压缩后面");
		await d.type(QUEUED);
		await pause(700);
		await d.submit();
		await pause(900);
		const waiting = await app.evaluate<{ field: string; row: boolean }>(`(() => ({
			field: document.querySelector("main textarea")?.value ?? "",
			row: [...document.querySelectorAll("[data-ly-tip]")].some((el) => el.getAttribute("data-ly-tip").includes(${JSON.stringify(QUEUED)}) && el.getAttribute("data-ly-tip").includes("等这一轮结束后发出")),
		}))()`);
		check("这句离开输入框、排进了队列，等压缩结束", waiting.row && !waiting.field, JSON.stringify(waiting));
		check("压缩还没结束时它没发给模型", !seen.some((s) => s.kind === "main" && s.body.messages.some((m) => textOf(m).includes(QUEUED))), `${seen.length} 次请求`);
		await shoot("03_压缩期间排队");

		console.log("\n【四】摘要回来，压缩结束，排队的那句发出");
		await d.until('document.querySelector("[data-auto-compaction][data-command-status=done]")', 20000).catch(() => {});
		await d.until(`document.body.innerText.includes("回答：${QUEUED.slice(0, 8)}")`, 20000).catch(() => {});
		await pause(1500);
		const finished = await card();
		check("卡片显示压缩完成及前后条数", finished?.status === "done" && /\d+ → \d+ 条消息/.test(finished.text), JSON.stringify(finished));
		check("排队那句得到了回答", (await app.evaluate<string>("document.body.innerText")).includes(`回答：${QUEUED.slice(0, 8)}`), "");
		await shoot("04_压缩完成后排队消息发出");

		console.log("\n【五】摘要请求是不是从上一次请求分叉出来的");
		const kinds = seen.map((s) => s.kind).join(",");
		check("请求顺序：回答、摘要、排队那句，各一次", kinds === "main,summary,main", kinds);
		const [ask, fork, queued] = seen;
		if (ask && fork) {
			check("模型相同", fork.body.model === ask.body.model, `${ask.body.model} / ${fork.body.model}`);
			check("系统提示词逐字节相同", bare(fork.body.system) === bare(ask.body.system), "不同");
			check("工具逐字节相同", bare(fork.body.tools) === bare(ask.body.tools) && Array.isArray(fork.body.tools) && fork.body.tools.length > 0, `工具数 ${Array.isArray(ask.body.tools) ? ask.body.tools.length : 0} / ${Array.isArray(fork.body.tools) ? fork.body.tools.length : 0}`);
			check("thinking 与 metadata 相同", bare(fork.body.thinking) === bare(ask.body.thinking) && bare(fork.body.metadata) === bare(ask.body.metadata), `${bare(ask.body.thinking)} ${bare(fork.body.metadata)}`);
			const prefix = ask.body.messages.every((m, i) => bare(m) === bare(fork.body.messages[i]));
			const firstDiff = ask.body.messages.findIndex((m, i) => bare(m) !== bare(fork.body.messages[i]));
			check(`上一次的 ${ask.body.messages.length} 条消息原样是摘要请求的开头`, prefix, `第 ${firstDiff} 条不同`);
			check("摘要请求只在末尾多了回答和指令两条", fork.body.messages.length === ask.body.messages.length + 2, `${ask.body.messages.length} → ${fork.body.messages.length}`);
		}
		if (ask && fork && queued) {
			check("排队那句在摘要回来之后才发出", fork.done !== undefined && queued.at >= fork.done, `摘要 ${fork.done}，排队 ${queued.at}`);
			check("它带的是压过的短历史", queued.body.messages.length < ask.body.messages.length && textOf(queued.body.messages[0]).includes("<session-summary>"), `${ask.body.messages.length} → ${queued.body.messages.length}：${textOf(queued.body.messages[0]).slice(0, 40)}`);
		}
		await pause(1200);
	} finally {
		grab.close();
		await stop();
		server.close();
		console.log(`\n采到 ${frames.length} 帧，正在合成 60fps…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_收尾时分叉压缩_${passed}of${checks.length}.mp4`);
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
