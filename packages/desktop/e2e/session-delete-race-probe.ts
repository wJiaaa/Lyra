/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * 删除和还在写的会话撞在一起时，真窗口里会发生什么。
 *
 * 两件只在时序上出错的事，单元测试只能各测一半：
 *
 *   清理撞上在跑的   「清除会话记录」按下时有一条会话正在回复。它必须被跳过、留在库里，回复写完
 *                    之后照样在——而不是在判断和删除之间被删掉，迟到的回复无处可写。
 *   写到一半删掉     回复写到一半把会话删了。停下来的那一轮收尾时还要写几条记录；侧边栏里它不能
 *                    再回来，库里也不能再有它。
 *
 * 第二条在这条路上从前也不出错：删除先停掉会话、等它收尾，行删掉时已经没有写入在路上。真正「落在
 * 删除之后」的写入在真窗口里造不出来，由 core 的 `session-db.test.ts` 和 desktop 的
 * `session-storage.test.ts` 在存储层直接守着；这里守的是改了删除路径之后，这两条还对。
 *
 * 模型是本地起的假服务：带 HOLD 的请求先吐半句，然后挂住，等探针放行再说完。
 *
 * Run: PLUME_E2E_ARTIFACTS=~/Desktop/Plume删除竞态测试 node --experimental-strip-types e2e/session-delete-race-probe.ts
 */

import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";
import { seededSessions, seedSessions } from "./session-fixture.ts";

const PORT = 9488;
const MODEL_PORT = 9589;
const MODEL = "scripted";
const PROJECT_ID = "dddddddddddddddd";
const DAY = 86_400_000;

/** Replies held open, waiting for `release`. */
const held: ServerResponse[] = [];
const sse = (res: ServerResponse, payload: { type: string }) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);

const model = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1000, output_tokens: 0 } } } as never);
		sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
		sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "正在写这一段，" } } as never);
		if (body.includes("HOLD")) return void held.push(res);
		finish(res);
	});
});

function finish(res: ServerResponse): void {
	if (res.writableEnded || res.destroyed) return;
	sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "写完了。" } } as never);
	sse(res, { type: "content_block_stop", index: 0 } as never);
	sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } } as never);
	sse(res, { type: "message_stop" } as never);
	res.end();
}

function release(): void {
	for (const res of held.splice(0)) finish(res);
}

model.listen(MODEL_PORT, "127.0.0.1");

let home = "";
const app = await startApp({
	port: PORT,
	seed: async (dir) => {
		home = dir;
		const project = join(dir, "project");
		await mkdir(project, { recursive: true });
		await writeFile(join(dir, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
		const at = Date.now() - 10 * DAY;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		seedSessions(dir, ["old-1", "old-2"].map((id) => {
			const meta = { id, title: `旧会话 ${id}`, cwd: project, projectId: PROJECT_ID, projectName: "project", createdAt: at, updatedAt: at, modelId: `local/${MODEL}`, messageCount: 1, seq: 1, usage };
			return { meta, records: [{ type: "meta", meta }, { type: "message", message: { role: "user", content: [{ type: "text", text: "早先的一句" }], timestamp: at } }] };
		}));
		await writeFile(join(dir, "settings.json"), JSON.stringify({
			version: 1,
			providers: [{
				id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
				models: [{ id: `local/${MODEL}`, providerId: "local", modelId: MODEL, name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
			}],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: Date.now() }],
			defaultModelId: `local/${MODEL}`, permissionMode: "full", thinking: "off", autoSummarizeTitle: false,
			retryPolicy: {
				network: { retries: 0, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
				upstream: { retries: 0, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 },
			},
			hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [], appearance: { theme: "light" },
		}));
	},
});

const frames: Frame[] = [];
const grab = await frameGrabber(PORT);
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown = ""): void {
	results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
/** One frame now, so the video shows each state long enough to read. */
async function hold(ms = 1000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		frames.push({ at: Date.now(), data: await grab.shot() } as Frame);
		await pause(120);
	}
}
async function shot(name: string): Promise<void> {
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${name}.png`), Buffer.from((await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));
}
async function until(expression: string, ms = 20_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`)) return true;
		await hold(250);
	}
	return false;
}
async function ask(text: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		if (!field) throw new Error("找不到输入框");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	})()`);
}
const onDisk = async () => (await seededSessions(home)).map((meta) => ({ id: meta.id, messages: meta.messageCount }));
const rows = () => app.evaluate<string[]>(`[...document.querySelectorAll("[data-ly-row]")].map((el) => el.dataset.lyRow)`);

let failed = false;
try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
	await pause(2_000);
	await hold();

	// ---- 一、清理撞上正在回复的会话 ----
	await ask("HOLD 第一轮：慢慢写");
	check("回复开始流式输出", await until(`document.querySelector("main")?.innerText.includes("正在写这一段")`));
	await hold();
	const live = (await onDisk()).find((meta) => !meta.id.startsWith("old-"));
	if (!live) throw new Error("新会话没有落库");
	await shot("1-第一轮写到一半");

	const cleared = await app.evaluate<{ removed: number; skipped: number }>(`window.plume.usage.clear({ from: null, to: null })`);
	check("清除全部：两条旧会话删掉，正在回复的那条跳过", cleared.removed === 2 && cleared.skipped === 1, cleared);
	const afterClear = await onDisk();
	check("库里只剩正在回复的那条", afterClear.length === 1 && afterClear[0].id === live.id, afterClear);
	await hold();

	release();
	check("放行之后回复写完", await until(`document.querySelector("main")?.innerText.includes("写完了")`));
	await pause(600);
	const written = (await onDisk()).find((meta) => meta.id === live.id);
	check("写完的回复进了库", written?.messages === 2, written);
	check("侧边栏里还有它", (await rows()).includes(live.id), await rows());
	await hold();
	await shot("2-清理之后第一轮写完");

	// ---- 二、写到一半把会话删掉 ----
	await ask("HOLD 第二轮：写到一半会被删掉");
	check("第二轮开始流式输出", await until(`[...document.querySelectorAll("main")].some((m) => (m.innerText.match(/正在写这一段/g) ?? []).length >= 2)`));
	await hold();
	await shot("3-第二轮写到一半");
	await app.evaluate(`window.plume.sessions.remove(${JSON.stringify(live.id)})`);
	release();
	/*
	 * 逐帧问侧边栏：被删的那条有没有哪一刻又回来了。
	 *
	 * 幽灵是被一次迟到的广播放回去的，事后看一眼可能刚好看在它回来之前或者之后——要问的是这三秒里
	 * 的每一刻。
	 */
	let reappeared = 0;
	let samples = 0;
	const end = Date.now() + 3_000;
	while (Date.now() < end) {
		samples++;
		if ((await rows()).includes(live.id)) reappeared++;
		frames.push({ at: Date.now(), data: await grab.shot() } as Frame);
		await pause(80);
	}
	check("删掉之后侧边栏里再没出现过它", reappeared === 0, `${samples} 次采样里出现 ${reappeared} 次`);
	check("库里也没有它", !(await onDisk()).some((meta) => meta.id === live.id), await onDisk());
	await hold();
	await shot("4-删掉之后");

} catch (error) {
	failed = true;
	console.error(error);
} finally {
	grab.close();
	const passed = results.filter((each) => each.ok).length;
	const directory = process.env.PLUME_E2E_ARTIFACTS;
	if (directory && frames.length > 0) {
		const now = new Date();
		const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()].map((n) => String(n).padStart(2, "0")).join("-");
		const out = join(directory, `${stamp}_删除与在写的会话_${passed}of${results.length}.mp4`);
		await encode(frames, out, 30, 1500);
		console.log("录像:", out);
	}
	console.log(`\n${passed}/${results.length} 通过`);
	await app.stop();
	await closeListeningServer(model);
	if (failed || passed !== results.length) process.exitCode = 1;
}
