/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 持续目标的两种「该停没停」在真窗口里走一遍：
 *
 * 1. 「在做」那一轮按停止：目标当场显示「已停下：已停止」，裁判一次也不问。从前那一轮以 aborted 收尾、
 *    会话却把它当 done 交给目标，于是进了「在判定」，接着续跑。
 * 2. 主模型回 HTTP 400：第一次失败就停在「已停下：这一轮出错了」，裁判一次也不问、不再续跑。从前
 *    每次都被当成 done 去问裁判，判「有进展」就续，续了又 400，一直撞到 50 次的上限。
 *
 * 模型是本地起的假服务（照 `goal-demo.ts`），按系统提示词认出裁判，分开计数。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/goal-stop-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, openSession, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume持续目标修复测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9872;
const FIELD = "main textarea";
const BAR = "main [data-ly-goal]";
const STOP = 'main [data-composer-send="stop"]';
const JUDGE_SYSTEM = "You judge whether an agent has reached a goal";

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

/** `hold`：主回合一直不回，等人按停；`reject`：主回合回 400。裁判总是回「有进展」。 */
let mode: "hold" | "reject" = "hold";
const count = { main: 0, judge: 0 };

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { system?: unknown };
			if (JSON.stringify(body.system ?? "").includes(JUDGE_SYSTEM)) {
				count.judge += 1;
				reply(res, JSON.stringify({ verdict: "progress", reason: "还没绿，接着修" }));
				return;
			}
			count.main += 1;
			if (mode === "reject") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.1: malformed content block" } }));
				return;
			}
			// 不回，直到窗口那头按停把连接掐掉；兜底一分钟。
			const timer = setTimeout(() => reply(res, "修好了一个。"), 60_000);
			res.on("close", () => clearTimeout(timer));
		});
	});
}

function reply(res: ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: "goal", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

const SESSIONS = ["goal-stop", "goal-400"] as const;

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# goal\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	seedSessions(home, SESSIONS.map((id, at) => {
		const meta = { id, title: id === "goal-stop" ? "按停止" : "服务商 400", cwd, projectId, projectName: "持续目标", createdAt: 1 + at, updatedAt: 2 + at, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
		return { meta, records: [
			{ type: "meta", meta, seq: 0, ts: 1 },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "CI 一直是红的。" }], timestamp: 1 }, seq: 1, ts: 1 },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我看看是哪几个测试。" }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
			{ type: "meta", meta, seq: 3, ts: 3 },
		] };
	}));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "auto",
		thinking: "off",
		projectMemory: false,
		autoSummarizeTitle: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "持续目标", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

async function photo(name: string) {
	await mkdir(out, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(image.data, "base64"));
}

/** 状态条此刻写着什么。 */
async function bar() {
	return app!.evaluate<{ status: string | null; said: string; rounds: string }>(`(()=>{
		const e=document.querySelector(${JSON.stringify(BAR)});
		if(!e) return {status:null,said:"",rounds:""};
		return {
			status:e.getAttribute('data-ly-goal'),
			said:(e.querySelector('[data-ly-goal-status]')?.textContent||"").trim(),
			rounds:(e.querySelector('[data-ly-goal-rounds]')?.textContent||"").trim(),
		};
	})()`);
}

/** 等到状态条变成某种状态；等不到不抛，留给后面的断言如实记下——修复前那一遍要两段都跑完。 */
async function settleTo(status: string, budget = 600): Promise<void> {
	await until(app!, `document.querySelector('main [data-ly-goal="${status}"]')`, budget).catch(() => {});
}

/** 在当前会话里定一个目标。 */
async function setGoal(text: string) {
	await type(app!, FIELD, `/goal ${text}`);
	await pause(500);
	await press(app!, "Enter", 13);
	// 任何状态都算出现了：400 那一段「在做」只有几毫秒，等它可能等不到。
	await until(app!, `document.querySelector(${JSON.stringify(BAR)})`);
}

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");

	// —— 一：「在做」那一轮按停止 ——
	mode = "hold";
	await openSession(app, "goal-stop");
	await pause(800);
	await setGoal("STOP_ME 让 CI 变绿");
	await until(app, `document.querySelector(${JSON.stringify(STOP)})`);
	await pause(1200);
	const working = await bar();
	check("定目标后在做，停止按钮在", working.status === "working" && working.said === "在做" && count.main === 1, { working, count });
	await photo("01_按停止之前_在做");

	await click(app, STOP);
	await settleTo("paused");
	// 停下以后再等一会儿：从前这几秒里它会进「在判定」、再续跑一轮。
	await pause(3000);
	const stopped = await bar();
	check("按停止后目标显示「已停下：已停止」", stopped.status === "paused" && stopped.said === "已停下：已停止", stopped);
	check("按停止后裁判一次也没问，也没有续跑", count.judge === 0 && count.main === 1, { ...count });
	await photo("02_按停止之后_已停下");

	// —— 二：主模型回 400 ——
	mode = "reject";
	count.main = 0;
	count.judge = 0;
	await openSession(app, "goal-400");
	await pause(800);
	await setGoal("REJECT_ME 让 CI 变绿");
	await settleTo("paused", 900);
	await pause(3000);
	const failed = await bar();
	check("主模型 400：目标停在「已停下：这一轮出错了」", failed.status === "paused" && failed.said === "已停下：这一轮出错了", failed);
	check("第一次失败就停：主模型只被请求一次，裁判一次也没问", count.main === 1 && count.judge === 0, { ...count });
	const transcript = await app.evaluate<string>(`document.querySelector("main")?.textContent ?? ""`);
	check("对话里看得见服务商的错误原文", transcript.includes("请求不被接受：messages.1: malformed"), transcript.slice(-300));
	await photo("03_主模型400_已停下");
} catch (error) {
	check("验证脚本跑完", false, String(error));
	await photo("失败现场").catch(() => {});
	console.log("count at failure", JSON.stringify(count), JSON.stringify(await bar().catch(() => null)));
	process.exitCode = 1;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	await mkdir(out, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_持续目标停止与报错_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
