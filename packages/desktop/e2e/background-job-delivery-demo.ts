/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 后台命令结束时自己送回会话：闲着时叫醒、失败时标红、跑着时插进同一轮。
 *
 * 模型是本地一个假的 Anthropic 端点，命令是真的 `sleep`——要验的是进程真的退出之后，那一行真的
 * 出现在窗口里，模型真的接着说了话；而不是测试里替它调一下 `exit`。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/background-job-delivery-demo.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume后台命令通知测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9811;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Reply = { text: string } | { tool: { id: string; command: string; description: string; background?: boolean } };

/** 只看最近一次人说的那句话之后的部分：同一个会话里跑三个场景，前面的不能串进后面。 */
function decide(messages: unknown[]): Reply {
	const raw = messages.map((message) => JSON.stringify(message));
	let from = 0;
	raw.forEach((text, index) => { if (/BG_[A-Z]+/.test(text) && !text.includes("tool_result")) from = index; });
	const tail = raw.slice(from).join("\n");
	const scene = tail.match(/BG_[A-Z]+/)?.[0];
	const delivered = tail.includes("background_job");
	const results = (tail.match(/"tool_result"/g) ?? []).length;
	if (scene === "BG_BUILD") {
		if (delivered) return { text: "构建通过了：built in 3.0s。可以发版了。" };
		if (results === 0) return { tool: { id: "build", command: "sleep 3; echo 'built in 3.0s'", description: "构建项目", background: true } };
		return { text: "构建在后台跑着，跑完我会接着看结果。" };
	}
	if (scene === "BG_FAIL") {
		if (delivered) return { text: "类型检查没过：src/a.ts 第 3 行类型不匹配，我去修。" };
		if (results === 0) return { tool: { id: "typecheck", command: "sleep 2; echo 'src/a.ts(3,7): error TS2322'; exit 1", description: "运行类型检查", background: true } };
		return { text: "类型检查在后台跑着。" };
	}
	if (scene === "BG_STEER") {
		if (delivered) return { text: "测试跑完了，文档也改好了。两件事都做完了。" };
		if (results === 0) return { tool: { id: "tests", command: "sleep 2; echo '42 passed'", description: "跑单元测试", background: true } };
		if (results === 1) return { tool: { id: "docs", command: "sleep 5; echo 'docs updated'", description: "更新文档" } };
		return { text: "文档改好了，测试还没回来。" };
	}
	return { text: "好的。" };
}

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body: unknown = JSON.parse(raw);
			assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
			reply(res, decide(body.messages));
		});
	});
}

function reply(res: ServerResponse, answer: Reply) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	const tool = "tool" in answer ? answer.tool : null;
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `${tool.id}-${Date.now()}`, name: "bash", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", {
		index: 0,
		delta: tool
			? { type: "input_json_delta", partial_json: JSON.stringify({ command: tool.command, description: tool.description, ...(tool.background ? { run_in_background: true } : {}) }) }
			: { type: "text_delta", text: "text" in answer ? answer.text : "" },
	});
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# background jobs\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: "bg-jobs", title: "后台命令", cwd, projectId, projectName: "后台命令", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, seq: 0, ts: 1 }] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "后台命令", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const frames: Frame[] = [];

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	const running = app;

	const until = async (expression: string, ms = 30_000) => {
		for (let i = 0; i < ms / 100; i++) {
			if (await running.evaluate(`Boolean(${expression})`)) return;
			await pause(100);
		}
		throw new Error(`UI condition not reached: ${expression}`);
	};
	const shot = async (name: string) => {
		// 截图要拍到这一步说的那几行：把对话滚到底，等平滑滚动停下。
		await running.evaluate(`[...document.querySelectorAll("main *")].filter((node)=>node.scrollHeight>node.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)).forEach((node)=>{node.scrollTop=node.scrollHeight;})`);
		await pause(500);
		const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	};
	const say = async (text: string) => {
		await until(`document.querySelector("main textarea")`);
		await running.evaluate(`(()=>{const field=document.querySelector("main textarea");field.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
		await pause(400);
		await running.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await running.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	};
	const transcript = () => running.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
	// 量图标真的画出来的颜色，不看类名：类名在、颜色被别的规则盖掉，是上一版踩到的。
	const jobRows = () => running.evaluate<{ text: string; tip: string; iconColor: string }[]>(
		`[...document.querySelectorAll('[data-delivery-kind="job"]')].map((row)=>({text:row.innerText.replace(/\\s+/g," ").trim(),tip:row.querySelector('[data-ly-tip]')?.getAttribute('data-ly-tip')??"",iconColor:getComputedStyle(row.querySelector('.ly-flow-lead svg')).color}))`,
	);
	const danger = await running.evaluate<string>(`(()=>{const probe=document.createElement("span");probe.style.color="var(--color-danger)";document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;})()`);
	// 送达的原文是写给模型的；它一旦被画成人说的话，这两句里总有一句会出现在屏幕上。
	const leaked = async () => /运行时送达|<background_job/.test(await transcript());

	await until(`document.body.innerText.includes("后台命令")`);
	await running.evaluate(`[...document.querySelectorAll("a,button,[role=button]")].find((node)=>node.textContent?.trim()==="后台命令")?.click()`);
	await pause(1200);
	await shot("00_改动前空会话");

	// 1. 闲着时结束：这一轮先说完，3 秒后命令退出，会话自己被叫醒。
	await say("BG_BUILD 在后台跑一下构建");
	await until(`document.querySelector("main")?.innerText.includes("跑完我会接着看结果")`);
	const idleAt = Date.now();
	await pause(800);
	await shot("01_构建在后台_这一轮已说完");
	check("这一轮说完时还没有送达行", (await jobRows()).length === 0, await jobRows());
	await until(`document.querySelector('[data-delivery-kind="job"]')`, 15_000);
	const wokeAfter = Date.now() - idleAt;
	await until(`document.querySelector("main")?.innerText.includes("构建通过了")`);
	await pause(1000);
	await shot("02_命令结束_会话被叫醒");
	const first = await jobRows();
	check("命令退出后出现一行：先说结果，再说是哪件事", first.length === 1 && first[0].text === "后台命令完成 构建项目", first);
	check("那串 shell 不摊在行上，只在悬停提示里", !first[0]?.text.includes("sleep") && first[0]?.tip === "sleep 3; echo 'built in 3.0s'", first[0]);
	check("叫醒发生在命令跑完之后（3 秒 sleep，减去这一轮自己花的时间）", wokeAfter > 500 && wokeAfter < 8000, { ms: wokeAfter });
	check("成功的那行图标不是红的", first[0] !== undefined && first[0].iconColor !== danger, { icon: first[0]?.iconColor, danger });
	check("模型拿到结果接着说了话", (await transcript()).includes("构建通过了：built in 3.0s"), "构建通过了");
	check("送达的原文没有被画成人说的话", !(await leaked()), "no 运行时送达 / <background_job> on screen");

	// 2. 失败的命令：那一行标红。
	await say("BG_FAIL 后台跑一下类型检查");
	await until(`document.querySelectorAll('[data-delivery-kind="job"]').length === 2`, 15_000);
	await until(`document.querySelector("main")?.innerText.includes("类型检查没过")`);
	await pause(1000);
	await shot("03_失败的命令标红");
	const failed = (await jobRows())[1];
	check("失败的那一行说「失败」和退出码", failed?.text === "后台命令失败 运行类型检查 退出码 1", failed);
	check("失败的那一行，图标量出来是危险色", failed !== undefined && failed.iconColor === danger, { icon: failed?.iconColor, danger });

	// 3. 跑着时结束：模型在跑 5 秒的活，2 秒的测试先结束——插进同一轮，不另开一轮。
	await say("BG_STEER 后台跑测试，同时去改文档");
	await until(`document.querySelectorAll('[data-delivery-kind="job"]').length === 3`, 20_000);
	await until(`document.querySelector("main")?.innerText.includes("两件事都做完了")`, 20_000);
	await pause(1200);
	await shot("04_跑着时结束_插进同一轮");
	const text = await transcript();
	const at = { work: text.lastIndexOf("执行命令 2 个"), row: text.lastIndexOf("后台命令完成"), done: text.indexOf("两件事都做完了") };
	check("测试的结束行排在「执行命令 2 个」之后、最终回答之前", at.work >= 0 && at.work < at.row && at.row < at.done, at);
	check("中间没有出现「测试还没回来」——它在这一轮里就被读到了", !text.includes("测试还没回来"), "absent");

	await pause(1000);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_后台命令结束自动送回_${passed}of${checks.length}.mp4`);
await encode(frames, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
