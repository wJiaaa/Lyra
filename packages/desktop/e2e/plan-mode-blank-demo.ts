/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 空白对话里的计划模式：还没有会话时就能拨开，第一句话建出的会话、第一轮就在计划模式里。
 *
 * 假模型照 `plan-mode-demo.ts`：收到 `PLAN_ME` 就交计划，并记下每次请求的工具名——第一轮的工具表里
 * 有 `submit_plan`，才说明开关是随建会话一起到了 core，而不是建完才补、晚了一轮。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/plan-mode-blank-demo.ts [输出目录] [--before]`
 * `--before` 只拍空白对话里的开关，给改动前的构建用。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames as settle, press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const before = process.argv.includes("--before");
const out = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? join(homedir(), "Desktop", "Plume空白对话计划模式测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9872;
const OFF = 'main button[aria-label^="进入计划模式"]';
const ON = 'main button[aria-label="退出计划模式"]';
const FIELD = "main textarea";
const NEW_CHAT = "button:has(svg.ly-new-chat-icon)";

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

const PLAN = {
	title: "登录改成 OAuth",
	steps: [
		{ what: "读现有的登录流程", files: ["src/auth/login.ts"] },
		{ what: "加 OAuth 回调路由", files: ["src/auth/oauth.ts"] },
	],
	risks: [],
	unknowns: [],
};

const requests: { tools: string[]; tail: string }[] = [];
/** agent 那一轮的请求。新会话还会发一次不带工具的起标题请求，它不算。 */
const turns = () => requests.filter((request) => request.tools.length > 0);

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

/** 一个项目、零个会话：启动就停在这个项目的空白对话上。 */
async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# plan mode\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
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

async function chip() {
	return app!.evaluate<{ state: "on" | "off" | "none"; disabled: boolean; tip: string }>(`(()=>{
		const on=document.querySelector(${JSON.stringify(ON)});
		const off=document.querySelector(${JSON.stringify(OFF)});
		const e=on??off;
		if(!e) return {state:"none",disabled:false,tip:""};
		return {state:on?"on":"off",disabled:e.disabled||e.getAttribute("aria-disabled")==="true",tip:e.getAttribute("aria-label")||""};
	})()`);
}

const sessionRows = () => app!.evaluate<number>("document.querySelectorAll('[data-ly-row]').length");

async function say(text: string) {
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
	if (!before) stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
	await pause(900);

	const blank = await chip();
	check("启动停在空白对话上，还没有会话", await sessionRows() === 0, await sessionRows());
	if (before) {
		check("改动前：空白对话里的开关是禁用的", blank.disabled, blank);
		await photo("改动前_空白对话开关");
	} else {
		check("空白对话里的开关可以点", !blank.disabled && blank.tip.startsWith("进入计划模式"), blank);
		await photo("01_空白对话_关");

		await say("/plan");
		await until(app, `document.querySelector(${JSON.stringify(ON)})`);
		await pause(600);
		check("空白对话里 /plan 打开，不发消息也不建会话", (await chip()).state === "on" && requests.length === 0 && await sessionRows() === 0, { requests: requests.length, rows: await sessionRows() });
		await photo("02_空白对话_开");

		await say("/plan");
		await until(app, `document.querySelector(${JSON.stringify(OFF)})`);
		check("再输一次 /plan 关上", (await chip()).state === "off", await chip());
		await click(app, OFF);
		await until(app, `document.querySelector(${JSON.stringify(ON)})`);
		await pause(600);
		check("点开关打开", (await chip()).state === "on", await chip());

		await say("PLAN_ME 把登录改成 OAuth");
		await until(app, "document.querySelector('[data-approval-card]')", 1200);
		await pause(1200);
		check("第一句话那一轮的工具表里就有 submit_plan", turns()[0]?.tools.includes("submit_plan") === true, turns().map((request) => request.tools.includes("submit_plan")));
		check("建出的会话开关仍亮着", (await chip()).state === "on" && await sessionRows() === 1, { chip: await chip(), rows: await sessionRows() });
		await photo("03_第一轮就交计划");

		await click(app, "[data-ly-question-option]", "批准，开始执行");
		await pause(500);
		await click(app, '[data-ly-question-footer] button[type="submit"]');
		await until(app, "!document.querySelector('[data-approval-card]')", 1200);
		await until(app, `document.querySelector(${JSON.stringify(OFF)})`, 1200);
		await pause(1200);
		check("批准后照常熄灭", (await chip()).state === "off", await chip());
		await photo("04_批准后关");

		await click(app, NEW_CHAT);
		await until(app, `document.querySelector(${JSON.stringify(OFF)}) && document.querySelectorAll('.ly-user-bubble').length===0`);
		await pause(900);
		check("下一个空白对话从关着开始", (await chip()).state === "off", await chip());
		const sent = turns().length;
		await say("直接做");
		await until(app, `document.querySelectorAll('[data-ly-row]').length===2`, 1200);
		await pause(1500);
		const plain = turns()[sent];
		check("没拨开的空白对话照常建，工具表里没有 submit_plan", plain !== undefined && !plain.tools.includes("submit_plan") && (await chip()).state === "off", { tools: plain?.tools.length, plan: plain?.tools.includes("submit_plan"), chip: await chip() });
		await photo("05_普通新对话");
	}
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
	if (recorded.length) await encode(recorded, join(out, `${stamp}_空白对话计划模式_${pass}of${checks.length}.mp4`), 30);
	console.log(`Evidence: ${out} (${recorded.length} frames)`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
