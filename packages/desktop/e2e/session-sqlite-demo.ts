/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 会话存进 SQLite 之后，在真窗口里验三件事，边验边录：
 *
 * 1. 删掉一条会话，用量页的「估算费用」一分不少——花掉的钱不跟着会话走。删除只在归档列表里
 *    有，所以要删的那条种成已归档的。
 * 2. 回复流到一半，主进程被 `kill -9`：重开之后那条回复还在，停在被杀之前流到的地方。
 * 3. 恢复出来的那条是正经历史：接着发一句，模型收到的请求里带着它，对话照常往下走。
 * 4. 正常退出之后没有留下 `sessions.db-wal`：退出后复制 `~/.plume`，拿到的就是完整的库。
 *
 * 假模型是本地的 Anthropic 流式接口。第一轮主请求一段一段地吐、永远不收尾，好让探针在中途
 * 动手；重开之后的那一轮正常答完。两次启动共用同一份 profile（`reuseHome`），结束时删掉。
 *
 * 用法：node --experimental-strip-types e2e/session-sqlite-demo.ts [输出目录]
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, SessionMeta } from "@plume/core";
import { startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";
import { fixtureStore, seedSessions, sessionsDbPath } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume会话存储测试");
const PORT = 9731;
const INSPECT = 9732;
const MODEL_PORT = 9733;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const KEPT = "a0000000-0000-4000-8000-00000000000a";
const DOOMED = "b0000000-0000-4000-8000-00000000000b";
const PROMPT = "把存储迁移的步骤一段一段写出来";
const FOLLOW_UP = "接着上面说";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------------------------
// 假模型
// ---------------------------------------------------------------------------------------------

let mainRequests = 0;
const bodies: string[] = [];

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += String(chunk); });
		req.on("end", () => {
			void (async () => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				let closed = false;
				res.on("close", () => { closed = true; });
				const turn = body.includes('"tools"');
				if (turn) { mainRequests++; bodies.push(body); }
				sse(res, { type: "message_start", message: { id: `msg_${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 1200, output_tokens: 0 } } });
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				if (turn && mainRequests === 1) {
					// 永不收尾：一段一段地吐，直到连接被掐断。
					// oxlint-disable-next-line no-unmodified-loop-condition -- `closed` is set by the response's close event while this loop awaits
					for (let n = 1; n <= 400 && !closed; n++) {
						sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `第 ${n} 段：把这一段写进库里，再往下走。\n\n` } });
						await pause(120);
					}
					return;
				}
				const text = turn ? "收到，上面那段接着说。" : "存储迁移";
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
				sse(res, { type: "content_block_stop", index: 0 });
				sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } });
				sse(res, { type: "message_stop" });
				res.end();
			})();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

// ---------------------------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------------------------

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# 存储演示\n");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 820 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "演示模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [],
		projects: [{ id: projectId, path: cwd, name: "存储演示", pinned: true, lastOpenedAt: 1 }],
	}));

	const now = Date.now();
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = (id: string, title: string, cost: number, at: number, archived = false) => {
		const usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200, cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } };
		const meta: SessionMeta = { id, title, cwd, projectId, projectName: "存储演示", createdAt: at, updatedAt: at, modelId: "qa/model", messageCount: 2, usage, seq: 0, ...(archived ? { archived } : {}) };
		const reply: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `${title}的回答。` }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: at };
		return { meta, records: [
			{ type: "meta" as const, meta: { ...meta, messageCount: 0, usage: zero }, ts: at },
			{ type: "message" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: `${title}的问题` }], timestamp: at }, ts: at },
			{ type: "message" as const, message: reply, ts: at },
		] };
	};
	seedSessions(home, [session(KEPT, "留下的会话", 1.25, now - 120_000), session(DOOMED, "要删的会话", 0.5, now - 60_000, true)]);
}

// ---------------------------------------------------------------------------------------------
// 窗口里的动作
// ---------------------------------------------------------------------------------------------

let app: RunningApp;
let shot = 0;

async function screenshot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shot++;
	await writeFile(join(OUT_DIR, `${STAMP}_${String(shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
}

/** 侧栏那颗归档按钮只有图标，名字在 aria-label 上。 */
const archiveLabel = () => app.evaluate<string>(`[...document.querySelectorAll("button[aria-label]")].map((b) => b.getAttribute("aria-label")).find((l) => /^(已归档的聊天|退出归档)/.test(l)) ?? ""`);
const markArchive = () => app.evaluate(`(() => { document.querySelector("[data-demo-archive]")?.removeAttribute("data-demo-archive"); [...document.querySelectorAll("button[aria-label]")].find((b) => /^(已归档的聊天|退出归档)/.test(b.getAttribute("aria-label")))?.setAttribute("data-demo-archive", ""); })()`);

const rowExists = (id: string) => app.evaluate<boolean>(`Boolean(document.querySelector('[data-ly-row="${id}"]'))`);
const mainText = () => app.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
const lastSegment = (text: string) => Math.max(0, ...[...text.matchAll(/第 (\d+) 段/g)].map((m) => Number(m[1])));

async function openUsage(): Promise<string> {
	const d = driver(app);
	await app.evaluate(`document.querySelector(".ly-sidebar-foot button").click()`);
	await pause(600);
	await app.evaluate(`[...document.querySelectorAll("nav button")].find((b) => b.innerText.trim() === "使用统计")?.click()`);
	await d.until(`document.querySelector('[data-usage-dashboard="true"]')`, 30000);
	// 数字是走过去的，等它停下。
	await pause(1500);
	return app.evaluate<string>(`(() => {
		const label = [...document.querySelectorAll("div")].find((el) => el.children.length === 0 && el.textContent.trim() === "估算费用");
		return label?.nextElementSibling?.textContent.trim() ?? "";
	})()`);
}

async function closeSettings(): Promise<void> {
	const d = driver(app);
	await d.markByText("/^返回工作区$/", "data-demo-back");
	await d.click("[data-demo-back]");
	await pause(800);
}

async function deleteRow(id: string): Promise<void> {
	const d = driver(app);
	await markArchive();
	await d.click("[data-demo-archive]");
	await d.until(`document.querySelector('[data-ly-row="${id}"]')`, 10000);
	await pause(800);
	await screenshot("归档列表里要删的那条");
	const point = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-ly-row="${id}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", clickCount: 1 });
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", clickCount: 1 });
	await pause(700);
	await d.markByText("/^删除$/", "data-demo-delete");
	await d.click("[data-demo-delete]");
	await pause(700);
	await screenshot("删除确认");
	await app.evaluate(`[...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => b.innerText.trim() === "删除")?.click()`);
	await pause(1000);
	check("被删的会话从归档列表消失", !(await rowExists(id)), "还在");
	await screenshot("删除之后的归档列表");
	await markArchive();
	await d.click("[data-demo-archive]");
	await pause(800);
}

async function openRow(id: string): Promise<void> {
	await driver(app).click(`[data-ly-row="${id}"] > button`);
	await pause(1000);
}

async function record(name: string, frames: Frame[]): Promise<void> {
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${name}_${passed}of${checks.length}.mp4`), undefined, 1500);
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const home = await mkdtemp(join(tmpdir(), "plume-sqlite-demo-"));
	const model = startModel();
	try {
		await seed(home);

		// ── 第一次启动 ───────────────────────────────────────────────────────────────
		app = await startApp({ port: PORT, inspectPort: INSPECT, reuseHome: home });
		const firstFrames: Frame[] = [];
		const stopFirst = await startRecording(PORT, firstFrames);
		const d = driver(app);
		await d.until(`document.querySelector('[data-ly-row="${KEPT}"]')`, 30000);
		await pause(1000);
		await screenshot("种好的会话");

		console.log("【一】删会话之前，用量页的估算费用");
		const before = await openUsage();
		await screenshot("删除前的估算费用");
		check("删除前的估算费用是两条会话之和 $1.75", before === "$1.75", before);
		await closeSettings();

		console.log("\n【二】从右键菜单删掉一条会话");
		await deleteRow(DOOMED);
		check("另一条还在", await rowExists(KEPT), "也没了");
		await screenshot("删除之后的侧栏");

		console.log("\n【三】删完再看用量页");
		const after = await openUsage();
		await screenshot("删除后的估算费用");
		check("删除后估算费用不变，仍是 $1.75", after === before, after);
		await closeSettings();

		console.log("\n【四】开一轮会一直流下去的回复，流到一半杀掉主进程");
		await openRow(KEPT);
		await d.type(PROMPT);
		await pause(400);
		await d.submit();
		await d.until(`/第 12 段/.test(document.querySelector("main")?.innerText ?? "")`, 30000);
		const seenBeforeKill = lastSegment(await mainText());
		await screenshot("被杀之前流到的地方");
		console.log(`   杀之前屏幕上流到第 ${seenBeforeKill} 段`);
		const pid = await app.main<number>("process.pid");
		await stopFirst().catch(() => {});
		execFileSync("kill", ["-9", String(pid)]);
		await pause(1500);
		await app.stop();
		await record("删会话不删账_流到一半被杀", firstFrames);

		// ── 第二次启动 ───────────────────────────────────────────────────────────────
		console.log("\n【五】同一份 profile 重新打开");
		app = await startApp({ port: PORT, reuseHome: home });
		const secondFrames: Frame[] = [];
		const stopSecond = await startRecording(PORT, secondFrames);
		const d2 = driver(app);
		await d2.until(`document.querySelector('[data-ly-row="${KEPT}"]')`, 30000);
		const label = await archiveLabel();
		check("重开之后被删的会话没有回来（归档计数为空）", label === "已归档的聊天", label);
		await openRow(KEPT);
		await d2.until(`/第 1 段/.test(document.querySelector("main")?.innerText ?? "")`, 15000).catch(() => {});
		await pause(1000);
		const recoveredText = await mainText();
		const recoveredUpTo = lastSegment(recoveredText);
		await screenshot("重开后恢复出来的回复");
		console.log(`   重开后屏幕上有第 1 到第 ${recoveredUpTo} 段`);
		check("被杀那一轮的回复还在", recoveredUpTo > 0, "一段都没有");
		check("恢复到被杀之前屏幕上已有的地方（最多差一批 80ms）", recoveredUpTo >= seenBeforeKill - 1, `杀前 ${seenBeforeKill}，恢复 ${recoveredUpTo}`);
		const running = await app.evaluate<boolean>(`Boolean(document.querySelector('button[aria-label="停止"]'))`);
		check("输入框是发送态，不是还在跑的样子", !running, "停止按钮还在");

		console.log("\n【六】接着发一句，看恢复出来的那条是不是正经历史");
		await d2.type(FOLLOW_UP);
		await pause(400);
		await d2.submit();
		await d2.until(`/上面那段接着说/.test(document.querySelector("main")?.innerText ?? "")`, 30000);
		await pause(1200);
		await screenshot("接着发一句之后");
		const sent = bodies.at(-1) ?? "";
		check("模型收到的请求里带着恢复出来的回复", sent.includes(`第 ${Math.max(1, recoveredUpTo)} 段`), sent.slice(0, 200));
		check("新的一句答完了", /上面那段接着说/.test(await mainText()), "没看到回答");
		await pause(1000);
		await stopSecond();
		await app.stop();

		// Before anything here opens the database again, which would start a new WAL.
		const wal = `${sessionsDbPath(home)}-wal`;
		check("正常退出之后没有留下 sessions.db-wal", !existsSync(wal), `${statSync(wal, { throwIfNoEntry: false })?.size ?? 0} 字节`);

		// 库里的样子：终端上的数。
		const store = fixtureStore(home);
		const loaded = await store.load(KEPT);
		const recovered = loaded?.messages.find((m) => m.role === "assistant" && m.content.some((c) => c.type === "text" && c.text.includes("第 1 段"))) as AssistantMessage | undefined;
		check("库里那条回复的 stopReason 是 aborted", recovered?.stopReason === "aborted", String(recovered?.stopReason));
		// A streamed copy the commit failed to clear would be settled by this load into a second, stopped copy.
		const answers = loaded?.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.type === "text" && /上面那段接着说/.test(c.text))) ?? [];
		check("正常答完的那条只有一份，没有被当成残留再补一条", answers.length === 1 && (answers[0] as AssistantMessage).stopReason !== "aborted", answers.map((m) => (m as AssistantMessage).stopReason).join(","));
		const spend = await store.readSpend();
		check("删掉的那条会话的花销行还在 spend 表里", spend.some((row) => row.sessionId === DOOMED && row.kind === "call"), JSON.stringify(spend.map((r) => r.sessionId)));
		store.close();

		await record("重开后恢复并接着对话", secondFrames);
	} finally {
		await app?.stop().catch(() => {});
		model.close();
		await rm(home, { recursive: true, force: true });
	}
	const passed = checks.filter((c) => c.ok).length;
	console.log(`\n${passed}/${checks.length} 通过，录像与截图在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
