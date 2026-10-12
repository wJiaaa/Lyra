/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * MCP 加固里看得见的几样，在真窗口里各走一遍：连不上的服务器在对话里说一次、在设置页给出原因和
 * stderr、「重新连接」能把它拉回来；跑着的服务器中途退出后自动重连、卡片上显示第几次；长任务的
 * 进度出现在工具卡片上；超过内联上限的图片卡片上照样显示、模型拿到的是路径。
 *
 * MCP 服务器是 `core/test/mcp-stress-server.ts`（Node 自己剥类型），由环境变量和标记文件决定它
 * 怎么坏；模型是本进程里一台说 Anthropic SSE 的假服务器。应用跑在 `startApp` 给的一次性
 * PLUME_HOME 里，不碰 `~/.plume`；标记文件放在临时目录，跑完连目录一起删。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/mcp-hardening-demo.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, expandLastTurn, frames as settleFrames, openSession, openSettings, press, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT = join(homedir(), "Desktop", "PlumeMCP加固测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9812;
const SESSION = "mcp-hardening";
const STRESS = join(import.meta.dirname, "..", "..", "core", "test", "mcp-stress-server.ts");

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

/** 模型每次收到的请求体，按先后。 */
const requests: { messages: { role: string; content: unknown }[] }[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as { messages: { role: string; content: unknown }[] };
			requests.push(body);
			const last = body.messages.findLastIndex((message) => message.role === "assistant");
			const tail = JSON.stringify(body.messages.slice(last + 1));
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes('"tool_result"')) reply(res, "工具那边回来了。");
			else if (tail.includes("PROGRESS")) reply(res, "", { id: "call-long", name: "mcp__stress__long", input: { steps: 8, interval: 700 } });
			else if (tail.includes("IMAGE")) reply(res, "", { id: "call-image", name: "mcp__stress__big_image", input: { png: 300 } });
			else if (tail.includes("EXIT")) reply(res, "", { id: "call-exit", name: "mcp__flaky__exit", input: {} });
			else reply(res, "收到。");
		});
	});
}

function reply(res: ServerResponse, text: string, tool?: { id: string; name: string; input: object }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 50, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } });
	emit("message_stop", {});
	res.end();
}

const scratch = await mkdtemp(join(tmpdir(), "plume-mcp-hardening-"));
/** 这两个文件在，对应的服务器一启动就往 stderr 写几行然后崩。 */
const BROKEN_MARK = join(scratch, "broken.crash");
const FLAKY_MARK = join(scratch, "flaky.crash");

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# mcp\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "MCP 加固", cwd, projectId, projectName: "MCP", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "开始吧。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	const stress = (id: string, name: string, env: Record<string, string>) => ({ id, name, transport: "stdio", command: process.execPath, args: [STRESS], env: { STRESS_DIR: scratch, ...env }, enabled: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [
			stress("stress", "Stress", { STRESS_ONLY: '["long","big_image"]' }),
			stress("broken", "Broken", { STRESS_CRASH_IF_EXISTS: BROKEN_MARK }),
			stress("flaky", "Flaky", { STRESS_ONLY: '["echo","exit"]', STRESS_CRASH_IF_EXISTS: FLAKY_MARK }),
		],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "MCP", pinned: true, lastOpenedAt: 1 }],
	}));
}

const modelServer = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];
let shots = 0;

/** 窗口截图，带时间戳和序号，落在 `OUT`。 */
async function snap(name: string): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shots += 1;
	await writeFile(join(OUT, `${STAMP}_${String(shots).padStart(2, "0")}_${name}.png`), Buffer.from(image.data, "base64"));
}

const beat = (ms = 1000) => pause(ms);
const mainText = () => app!.evaluate<string>(`document.querySelector('main')?.textContent ?? ''`);
const cardText = (id: string) => app!.evaluate<string>(`document.querySelector('[data-mcp-server="${id}"]')?.textContent ?? ''`);

async function send(text: string): Promise<void> {
	await click(app!, "main textarea");
	await app!.send("Input.insertText", { text });
	await settleFrames(app!, 4);
	await press(app!, "Enter", 13);
}

async function openMcpSettings(): Promise<void> {
	await openSettings(app!, "插件");
	await click(app!, '[data-tab="mcp"]');
	await until(app!, `document.querySelector('[data-mcp-server="stress"]')`, 1800);
}

/** 最后一次请求里，某个工具调用拿回来的结果原文。 */
function toolResult(id: string): string {
	for (const request of requests.toReversed()) {
		for (const message of request.messages) {
			if (!Array.isArray(message.content)) continue;
			const hit = (message.content as { type: string; tool_use_id?: string }[]).find((block) => block.type === "tool_result" && block.tool_use_id === id);
			if (hit) return JSON.stringify(hit);
		}
	}
	return "";
}

try {
	await writeFile(BROKEN_MARK, "");
	await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
	const address = modelServer.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await beat();

	console.log("— 1. 连不上的服务器：对话里说一次，设置页给原因、stderr 和重新连接");
	await send("你好");
	await until(app, `document.body.textContent.includes('Broken')`, 1800);
	await beat(1200);
	const body = await app.evaluate<string>(`document.body.textContent`);
	const notice = /MCP 服务器「Broken」没有连上[^。]*/.exec(body)?.[0] ?? "";
	check("对话里提示 Broken 没连上，带着 stderr 的最后一行", notice.includes("the marker file says crash"), notice);
	check("同一个错误只提示一次", body.split("MCP 服务器「Broken」没有连上").length - 1 === 1, body.split("MCP 服务器「Broken」没有连上").length - 1);
	await snap("对话里的连接失败提示");

	await openMcpSettings();
	await until(app, `document.querySelector('[data-mcp-server="broken"] [data-mcp-trouble]')`, 1800);
	await beat(1200);
	const trouble = await app.evaluate<{ text: string; stderr: string; button: boolean }>(`(()=>{
		const box=document.querySelector('[data-mcp-server="broken"] [data-mcp-trouble]');
		return { text: box.textContent, stderr: box.querySelector('[data-mcp-stderr]')?.textContent ?? '', button: [...box.querySelectorAll('button')].some(b=>b.textContent.includes('重新连接')) };
	})()`);
	check("设置页卡片写出错误原因", /closed|exit|Connection/i.test(trouble.text), trouble.text.slice(0, 200));
	check("stderr 原样显示在卡片上", trouble.stderr.includes("starting stress server") && trouble.stderr.includes("Error: the marker file says crash"), trouble.stderr);
	check("卡片上有「重新连接」按钮", trouble.button, trouble.button);
	check("正常的那两台照常连着", (await cardText("stress")).includes("2 个工具") && (await cardText("flaky")).includes("2 个工具"), { stress: await cardText("stress"), flaky: await cardText("flaky") });
	await snap("设置页失败原因与stderr");

	await rm(BROKEN_MARK);
	await click(app, '[data-mcp-server="broken"] [data-mcp-trouble] button', "重新连接", "starts");
	await until(app, `!document.querySelector('[data-mcp-server="broken"] [data-mcp-trouble]') && document.querySelector('[data-mcp-server="broken"]').textContent.includes('个工具')`, 1800);
	await beat(1200);
	check("修好以后点重新连接：连上，错误块收起", (await cardText("broken")).includes("13 个工具"), await cardText("broken"));
	await snap("手动重新连接成功");
	await closeSettings(app);
	await openSession(app, SESSION);

	console.log("— 2. 长任务的进度出现在工具卡片上");
	await send("PROGRESS 跑一个长任务");
	await expandLastTurn(app, `/\\d\\/8 · step/.test(document.querySelector('main').textContent)`);
	const seen: string[] = [];
	const started = Date.now();
	while (Date.now() - started < 12_000) {
		const progress = /(\d)\/8 · step \d/.exec(await mainText())?.[0];
		if (progress && seen.at(-1) !== progress) {
			seen.push(progress);
			if (seen.length === 3) await snap("工具卡片上的进度");
		}
		if ((await mainText()).includes("工具那边回来了")) break;
		await pause(150);
	}
	const steps = seen.map((one) => Number(one[0]));
	check("卡片上至少看到 3 个不同的进度，而且在往前走", steps.length >= 3 && steps.every((step, index) => index === 0 || step > steps[index - 1]!), seen);
	await until(app, `document.querySelector('main').textContent.includes('工具那边回来了')`, 1800);
	check("跑满 5.6 秒没有被 5 分钟超时之外的东西掐掉，拿到了结果", toolResult("call-long").includes("done after 8 steps"), toolResult("call-long").slice(0, 200));
	await beat(1200);
	await snap("长任务完成");

	console.log("— 3. 超过内联上限的图片：卡片上看得见，模型拿到的是路径");
	await send("IMAGE 给我一张大图");
	await until(app, `document.querySelectorAll('main').length && document.querySelector('main').textContent.split('工具那边回来了').length - 1 >= 2`, 1800);
	await expandLastTurn(app, `[...document.querySelectorAll('main img')].some(i=>i.naturalWidth===300)`);
	await beat(1500);
	const image = await app.evaluate<{ count: number; width: number; height: number }>(`(()=>{
		const imgs=[...document.querySelectorAll('main img')].filter(i=>i.naturalWidth===300);
		return { count: imgs.length, width: imgs[0]?.naturalWidth ?? 0, height: imgs[0]?.naturalHeight ?? 0 };
	})()`);
	check("卡片上显示了那张 300×300 的图，解码成功", image.count >= 1 && image.height === 300, image);
	const sent = toolResult("call-image");
	check("模型收到的是文字和路径，不是几百 KB 的图", sent.includes("mcp-images") && !sent.includes('"type":"image"') && sent.length < 4000, { length: sent.length, head: sent.slice(0, 300) });
	await snap("大图在卡片上");

	console.log("— 4. 服务器中途退出：调用失败带 stderr，自动重连、卡片显示第几次，恢复后连上");
	await writeFile(FLAKY_MARK, "");
	await send("EXIT 让它退出");
	await until(app, `document.querySelector('main').textContent.split('工具那边回来了').length - 1 >= 3`, 1800);
	const failed = toolResult("call-exit");
	check("工具调用失败，错误里带着服务器最后写的 stderr", failed.includes("fatal: the stress server was told to exit"), failed.slice(0, 400));
	await beat(800);
	await openMcpSettings();
	await until(app, `document.querySelector('[data-mcp-server="flaky"]').textContent.includes('重连中')`, 1800);
	await beat(2500);
	const reconnecting = await cardText("flaky");
	check("卡片显示重连中和第几次，stderr 是重启时崩的那几行", /重连中（第 \d+ 次）/.test(reconnecting) && reconnecting.includes("the marker file says crash"), reconnecting.slice(0, 300));
	await snap("自动重连中");
	await rm(FLAKY_MARK);
	await until(app, `!document.querySelector('[data-mcp-server="flaky"]').textContent.includes('重连中') && document.querySelector('[data-mcp-server="flaky"]').textContent.includes('2 个工具')`, 3600);
	await beat(1500);
	check("标记文件拿掉后，下一次退避重试就连上了", (await cardText("flaky")).includes("2 个工具"), await cardText("flaky"));
	await snap("自动重连成功");
} catch (error) {
	check("验证脚本跑完", false, String(error));
	console.error(error);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(modelServer);
	await rm(scratch, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${STAMP}_MCP加固_${pass}of${checks.length}`;
	await writeFile(join(OUT, `${name}.json`), JSON.stringify({ checks }, null, 2));
	if (recorded.length) await encode(recorded, join(OUT, `${name}.mp4`), 30);
	console.log(`证据：${join(OUT, name)}（${recorded.length} 帧）`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
