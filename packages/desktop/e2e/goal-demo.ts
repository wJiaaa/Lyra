/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 持续目标在真窗口里走一遍：`/goal` 定目标 → 在做 → 在判定 → 在等（倒计时在走）→ 取消；再重启一次，
 * 看等着的目标没人点开也会自己醒。
 *
 * 模型是本地起的假服务（照 `plan-mode-demo.ts`）。裁判和主回合走同一个模型，按系统提示词认出裁判
 * 的那一次，回 `waiting`。两种请求都故意慢几秒回：在做、在判定各自只有那几秒，不拖住就拍不到。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/goal-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GoalState } from "@plume/core";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames as settle, openSettings, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume持续目标测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9873;
const SESSION = "goal";
const FIELD = "main textarea";
const BAR = "main [data-ly-goal]";
const GOAL_TEXT = "GOAL_ME 让 CI 变绿";
/** 两种请求各拖这么久再回，够拍一张、量一次。 */
const HOLD_MS = 4000;
const JUDGE_SYSTEM = "You judge whether an agent has reached a goal";

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const requests: { judge: boolean; tools: number; tail: string }[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: unknown[]; system?: unknown; tools?: unknown[] };
			const judge = JSON.stringify(body.system ?? "").includes(JUDGE_SYSTEM);
			const tail = JSON.stringify(body.messages.slice(-2));
			requests.push({ judge, tools: body.tools?.length ?? 0, tail });
			const text = judge
				? JSON.stringify({ verdict: "waiting", reason: "CI 还在跑，等它出结果" })
				: tail.includes("Goal check") ? "CI 还没跑完，接着等。" : "已经触发了 CI，等它跑完再看。";
			setTimeout(() => reply(res, text), HOLD_MS);
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

async function seed(home: string, modelPort: number, goal?: GoalState): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# goal\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "持续目标", cwd, projectId, projectName: "持续目标", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3, ...(goal ? { goal } : {}) };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "CI 一直是红的。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我看看是哪几个测试。" }], api: "anthropic-messages", provider: "qa", model: "model", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
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
	return app!.evaluate<{ status: string | null; text: string; said: string; rounds: string; cancel: boolean; color: string }>(`(()=>{
		const e=document.querySelector(${JSON.stringify(BAR)});
		if(!e) return {status:null,text:"",said:"",rounds:"",cancel:false,color:""};
		const said=e.querySelector('[data-ly-goal-status]');
		return {
			status:e.getAttribute('data-ly-goal'),
			text:(e.textContent||"").trim(),
			said:(said?.textContent||"").trim(),
			rounds:(e.querySelector('[data-ly-goal-rounds]')?.textContent||"").trim(),
			cancel:[...e.querySelectorAll('button')].some(b=>(b.textContent||"").includes("取消目标")),
			color:said?getComputedStyle(said).color:"",
		};
	})()`);
}

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");

	await click(app, `[data-ly-row="${SESSION}"] > button`);
	await until(app, `document.querySelector('[data-ly-row="${SESSION}"] > button[aria-current]')`);
	await pause(800);
	check("没有目标时没有状态条", (await bar()).status === null, await bar());
	await photo("00_没有目标");

	await type(app, FIELD, `/goal ${GOAL_TEXT}`);
	await pause(500);
	await press(app, "Enter", 13);
	await until(app, `document.querySelector('main [data-ly-goal="working"]')`);
	await pause(900);
	const working = await bar();
	check("/goal 之后出现状态条：目标原话、「在做」、取消按钮", working.text.includes(GOAL_TEXT) && working.said === "在做" && working.cancel && working.color === "rgb(51, 156, 255)", working);
	const bubble = await app.evaluate<string>(`[...document.querySelectorAll(".ly-user-bubble")].at(-1)?.textContent??""`);
	check("目标那句话以人的名义进了对话，不带 /goal", bubble.includes(GOAL_TEXT) && !bubble.includes("/goal"), bubble);
	check("输入框清空了", await app.evaluate<string>(`document.querySelector("main textarea").value`) === "", null);
	await photo("01_在做");

	await until(app, `document.querySelector('main [data-ly-goal="judging"]')`, 1500);
	await pause(900);
	const judging = await bar();
	check("一轮收尾后进入「在判定」，第 1/50 次", judging.said === "在判定" && judging.rounds === "第 1/50 次判定", judging);
	await photo("02_在判定");

	await until(app, `document.querySelector('main [data-ly-goal="waiting"]')`, 1500);
	await pause(600);
	const first = await bar();
	await pause(2200);
	const later = await bar();
	const seconds = (said: string) => { const m = /(\d+):(\d\d)/.exec(said); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
	check("裁判说要等：「在等，m:ss 后再看」，倒计时在走", /^在等，0:[23]\d 后再看$/.test(first.said) && seconds(later.said) <= seconds(first.said) - 2, { first: first.said, later: later.said });
	const judges = requests.filter((one) => one.judge);
	check("裁判是一次不带工具的单独请求", judges.length === 1 && judges[0]!.tools === 0, requests.map((one) => ({ judge: one.judge, tools: one.tools })));
	await photo("03_在等");

	await click(app, `${BAR} button`, "取消目标");
	await until(app, `!document.querySelector(${JSON.stringify(BAR)})`, 900);
	await pause(1200);
	check("点「取消目标」后状态条消失", (await bar()).status === null, await bar());
	await photo("04_取消后");
	const before = requests.length;
	await pause(1500);
	check("取消之后没有再判、也没有再续跑", requests.length === before, { before, after: requests.length });

	await openSettings(app, "智能体");
	await until(app, `document.querySelector('[data-agent-profile="goal"]')`);
	await app.evaluate(`document.querySelector('[data-agent-profile="goal"]').scrollIntoView({block:"center"})`);
	await settle(app, 30);
	const row = await app.evaluate<string>(`document.querySelector('[data-agent-profile="goal"]').textContent`);
	check("设置 › 智能体里有 goal 那一行（裁判模型）", row.includes("goal") && row.includes("判定持续目标做到没有"), row);
	await photo("05_设置裁判模型");

	await stopRecording();
	stopRecording = undefined;
	await app.stop();

	/*
	 * 重启：种一个到点已过的「在等」目标，不点开它。启动时主进程要把它叫起来，它自己续跑一轮——
	 * 假模型收到的那一次带着「Goal check: it is now」，就是它醒了的证据。
	 */
	requests.length = 0;
	const waiting: GoalState = { text: GOAL_TEXT, startedAt: 1, status: "waiting", rounds: 1, noProgress: 0, judgeFailures: 0, waits: 1, wakeAt: Date.now() - 1000, verdict: { kind: "waiting", reason: "CI 还在跑", at: 1 } };
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port, waiting) });
	const end = Date.now() + 20_000;
	while (Date.now() < end && !requests.some((one) => !one.judge && one.tail.includes("Goal check"))) await pause(250);
	const woke = requests.find((one) => !one.judge && one.tail.includes("Goal check"));
	check("启动后没人点开，等着的目标也自己醒了、续跑了一轮", Boolean(woke), requests.map((one) => one.tail.slice(0, 80)));
} catch (error) {
	check("验证脚本跑完", false, String(error));
	await photo("失败现场").catch(() => {});
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	await mkdir(out, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${stamp}_持续目标_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
