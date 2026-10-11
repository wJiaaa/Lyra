/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 计划模式在真窗口里走一遍：芯片的关与开、`/plan` 两种用法、计划审批卡片、批准后芯片自己熄掉。
 *
 * 模型是本地起的假服务（照 `ask-user-card-demo.ts`）：收到 `PLAN_ME` 就调 `submit_plan` 交一份五步计划，
 * 收到那次调用的结果就说一句话收尾。它同时记下每次请求带了哪些工具——`submit_plan` 只在计划模式那一轮
 * 才装进工具表，这是开关真的到了 core 的证据，不是只在界面上亮了一下。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/plan-mode-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames as settle, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume计划模式测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9871;
const SESSION = "plan-mode";
const OFF = 'main button[aria-label^="进入计划模式"]';
const ON = 'main button[aria-label="退出计划模式"]';
const FIELD = "main textarea";
/** 芯片所在那一排工具栏的高度：开关来回时它不该跳。 */
const ROW_HEIGHT = `Math.round((document.querySelector(${JSON.stringify(ON)})??document.querySelector(${JSON.stringify(OFF)})).parentElement.getBoundingClientRect().height)`;

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const PLAN = {
	title: "登录改成 OAuth",
	steps: [
		{ what: "读现有的账号密码登录流程，列出调用点", files: ["src/auth/login.ts"] },
		{ what: "加 OAuth 回调路由，换取 token 后写会话", files: ["src/auth/oauth.ts", "src/routes.ts"] },
		{ what: "登录页把表单换成「用 GitHub 登录」按钮", files: ["src/pages/Login.tsx"] },
		{ what: "旧的密码登录保留一个版本，打开开关才走", files: ["src/config.ts"] },
		{ what: "补回调和会话写入的测试", files: ["test/oauth.test.ts"] },
	],
	risks: ["回调地址在本地和线上不同，配错了登录直接失败"],
	unknowns: ["线上用的是哪个 OAuth 应用"],
};

/** 每次请求带着的工具名，按到达顺序。 */
const requests: { tools: string[]; tail: string }[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: unknown[]; tools?: { name: string }[] };
			const tail = JSON.stringify(body.messages.slice(-2));
			requests.push({ tools: (body.tools ?? []).map((tool) => tool.name), tail });
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes('"tool_result"')) reply(res, "计划已批准，开始第一步。");
			else if (tail.includes("PLAN_ME")) reply(res, "", PLAN);
			else reply(res, "好的。");
		});
	});
}

function reply(res: ServerResponse, text: string, plan?: typeof PLAN) {
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	emit("message_start", { message: { id: "plan", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: plan ? { type: "tool_use", id: "plan-1", name: "submit_plan", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: plan ? { type: "input_json_delta", partial_json: JSON.stringify(plan) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: plan ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number, height = 860): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# plan mode\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "计划模式", cwd, projectId, projectName: "计划模式", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "登录这块想换掉。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "可以，先说说想换成什么。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "auto",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "计划模式", pinned: true, lastOpenedAt: 1 }],
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

/** 芯片此刻的样子：哪一种、写着什么、什么颜色、多宽。 */
async function chip() {
	return app!.evaluate<{ state: "on" | "off" | "none"; text: string; color: string; background: string; width: number; height: number }>(`(()=>{
		const on=document.querySelector(${JSON.stringify(ON)});
		const off=document.querySelector(${JSON.stringify(OFF)});
		const e=on??off;
		if(!e) return {state:"none",text:"",color:"",background:"",width:0,height:0};
		const s=getComputedStyle(e);const r=e.getBoundingClientRect();
		return {state:on?"on":"off",text:(e.textContent||"").trim(),color:s.color,background:s.backgroundColor,width:Math.round(r.width),height:Math.round(r.height)};
	})()`);
}

async function command(text: string) {
	await type(app!, FIELD, text);
	await pause(500);
	await press(app!, "Enter", 13);
	await settle(app!, 30);
	await pause(700);
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
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await pause(900);

	const off = await chip();
	const sendRow = await app.evaluate<number>(ROW_HEIGHT);
	check("关着时是一颗不带字的淡色图标", off.state === "off" && off.text === "" && off.width === off.height, off);
	await photo("01_关");

	await command("/plan");
	await until(app, `document.querySelector(${JSON.stringify(ON)})`);
	await pause(600);
	const on = await chip();
	check("/plan 之后芯片亮起，写着「计划模式」", on.state === "on" && on.text === "计划模式" && on.color !== off.color && on.background !== "rgba(0, 0, 0, 0)", on);
	check("输入框清空了，没有把 /plan 当消息发出去", await app.evaluate<string>(`document.querySelector("main textarea").value`) === "" && requests.length === 0, { requests: requests.length });
	await photo("02_开");

	await command("/plan");
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await pause(600);
	check("再输一次 /plan 熄灭", (await chip()).state === "off", await chip());
	await photo("03_再次关");

	await click(app, OFF);
	await until(app, `document.querySelector(${JSON.stringify(ON)})`);
	await pause(600);
	check("点芯片能打开", (await chip()).state === "on", await chip());
	await click(app, ON);
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await pause(600);
	check("再点一下关上", (await chip()).state === "off", await chip());
	check("开关来回之后工具栏高度没变", await app.evaluate<number>(ROW_HEIGHT) === sendRow, sendRow);

	await command("/plan PLAN_ME 把登录改成 OAuth");
	await until(app, `document.querySelector(${JSON.stringify(ON)})`);
	await until(app, "document.querySelector('[data-approval-card]')", 1200);
	await pause(1200);
	const bubble = await app.evaluate<string>(`[...document.querySelectorAll(".ly-user-bubble")].at(-1)?.textContent??""`);
	check("带话的 /plan 只发出后半句", bubble.includes("PLAN_ME 把登录改成 OAuth") && !bubble.includes("/plan"), bubble);
	check("那一轮的工具表里有 submit_plan，之前的没有", requests.length >= 1 && requests[0]!.tools.includes("submit_plan"), requests.map((request) => request.tools.includes("submit_plan")));

	const card = await app.evaluate<{ title: string; pre: number; h1: string; h2: string[]; steps: number; labels: string[]; other: boolean; overflow: number; content: number; card: number; viewport: number; covered: boolean }>(`(()=>{
		const card=document.querySelector('[data-approval-card]');
		const view=card.querySelector('.ly-approval-scroll > .ly-scroll-view');
		const submit=card.querySelector('button[type=submit]');
		const scroll=card.querySelector('.ly-approval-scroll').getBoundingClientRect();
		return {
			title:card.querySelector('[data-approval-title]').textContent,
			pre:card.querySelectorAll('pre').length,
			h1:card.querySelector('.ly-approval-scroll h1')?.textContent??"",
			h2:[...card.querySelectorAll('.ly-approval-scroll h2')].map(e=>e.textContent),
			steps:card.querySelectorAll('.ly-approval-scroll ol > li').length,
			labels:[...card.querySelectorAll('[data-ly-question-label]')].map(e=>e.textContent),
			other:Boolean(card.querySelector('[data-ly-question-other] input')),
			overflow:Math.round(view.scrollHeight-view.clientHeight),
			content:Math.round(view.scrollHeight),
			card:Math.round(card.getBoundingClientRect().height),
			viewport:innerHeight,
			covered:submit.getBoundingClientRect().top+1<scroll.bottom,
		};
	})()`);
	check("卡片标题是「审批计划」", card.title === "审批计划", card.title);
	check("计划正文按 Markdown 画：标题、小节、五条有序步骤，没有 <pre>", card.pre === 0 && card.h1 === PLAN.title && card.h2.join("|") === "步骤|风险|未确定" && card.steps === 5, card);
	check("选项和自由输入照业务提问那一套", card.labels.join("|") === "批准，开始执行|要改" && card.other, card.labels);
	check("五步计划（连风险、未确定）在卡片里最多再滚一行", card.overflow <= 24 && !card.covered, { overflow: card.overflow, content: card.content, card: card.card, viewport: card.viewport });
	await photo("04_审批计划");


	await click(app, "[data-ly-question-option]", "批准，开始执行");
	await pause(500);
	await click(app, '[data-ly-question-footer] button[type="submit"]');
	await until(app, "!document.querySelector('[data-approval-card]')", 1200);
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`, 1200);
	await pause(1200);
	check("批准计划后 core 关掉计划模式，芯片跟着熄灭", (await chip()).state === "off", await chip());
	check("批准之后的那次请求照常进行", requests.some((request) => request.tail.includes('"tool_result"')), requests.length);
	await photo("05_批准后自动关");
	await stopRecording();
	stopRecording = undefined;
	await app.stop();

	/*
	 * 矮窗口另起一次：窗口大小只能在启动时种进 `window.json`。`Emulation` 在 Electron 里只改 innerHeight，
	 * 布局仍按原窗口排，量到的不算数；页面目标上也没有 `Browser.setWindowBounds`。
	 */
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port, 640) });
	await app.evaluate("document.fonts.ready");
	await click(app, `[data-ly-row="${SESSION}"] > button`);
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await command("/plan PLAN_ME 把登录改成 OAuth");
	await until(app, "document.querySelector('[data-approval-card]')", 1200);
	await pause(1200);
	const short = await app.evaluate<{ height: number; covered: boolean; submit: number; cardBottom: number; overflow: number; composer: number }>(`(()=>{
		const card=document.querySelector('[data-approval-card]');
		const submit=card.querySelector('button[type=submit]').getBoundingClientRect();
		const scroll=card.querySelector('.ly-approval-scroll').getBoundingClientRect();
		const view=card.querySelector('.ly-approval-scroll > .ly-scroll-view');
		return {height:innerHeight,covered:submit.top+1<scroll.bottom,submit:Math.round(submit.bottom),cardBottom:Math.round(card.getBoundingClientRect().bottom),overflow:Math.round(view.scrollHeight-view.clientHeight),composer:Math.round(document.querySelector("main textarea").closest("main").querySelector('button[aria-label="退出计划模式"]').getBoundingClientRect().bottom)};
	})()`);
	check("矮窗口里计划正文自己滚，底栏按钮仍在卡片内、在窗口内", !short.covered && short.submit <= short.cardBottom && short.cardBottom <= short.height, short);
	check("矮窗口里输入框那一排没被卡片挤出窗口", short.composer <= short.height, { composer: short.composer, height: short.height });
	await photo("06_矮窗口审批计划");
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
	const name = `${stamp}_计划模式_${pass}of${checks.length}`;
	if (recorded.length) await encode(recorded, join(out, `${name}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
