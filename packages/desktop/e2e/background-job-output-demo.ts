/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 后台命令的输出能在任务面板里看：跑着时实时滚动、带颜色，结束了还留着，对话里点那一行直接跳过去。
 *
 * 模型是本地一个假的 Anthropic 端点，命令是真的——输出真的写进日志文件、真的被一段一段读出来。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/background-job-output-demo.ts`
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

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume后台任务输出测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9813;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Reply = { text: string } | { tool: { id: string; command: string; description: string; background?: boolean } };

/** 只看最近一次人说的那句话之后的部分：同一个会话里跑两个场景，前面的不能串进后面。 */
function decide(messages: unknown[]): Reply {
	const raw = messages.map((message) => JSON.stringify(message));
	let from = 0;
	raw.forEach((text, index) => { if (/BG_[A-Z]+/.test(text) && !text.includes("tool_result")) from = index; });
	const tail = raw.slice(from).join("\n");
	const scene = tail.match(/BG_[A-Z]+/)?.[0];
	const delivered = tail.includes("background_job");
	const results = (tail.match(/"tool_result"/g) ?? []).length;
	if (scene === "BG_SERVER") {
		if (delivered) return { text: "开发服务器退出了。" };
		if (results === 0) {
			// 一行绿色的 ready、一行普通的请求日志，40 行，每行间隔 0.25 秒：够看它在长，也够看颜色。
			return { tool: { id: "server", command: "for i in $(seq 1 40); do printf '\\033[32mready\\033[0m GET /api/items %d 200\\n' $i; sleep 0.25; done", description: "启动开发服务器", background: true } };
		}
		return { text: "开发服务器在后台跑着，输出在任务面板里能看。" };
	}
	if (scene === "BG_FAIL") {
		if (delivered) return { text: "类型检查没过，我去修。" };
		if (results === 0) return { tool: { id: "typecheck", command: "sleep 1; echo 'src/a.ts(3,7): error TS2322: Type string is not assignable to type number.'; exit 2", description: "运行类型检查", background: true } };
		return { text: "类型检查在后台跑着。" };
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
	await writeFile(join(cwd, "README.md"), "# background output\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: "bg-output", title: "后台任务输出", cwd, projectId, projectName: "后台任务输出", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
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
		projects: [{ id: projectId, path: cwd, name: "后台任务输出", pinned: true, lastOpenedAt: 1 }],
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
	const click = async (selector: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)})`);
		const at = await running.evaluate<{ x: number; y: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+Math.min(r.width/2,120),y:r.y+r.height/2};})()`);
		await running.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
		for (const type of ["mousePressed", "mouseReleased"]) await running.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
	};
	/** What the terminal shows, read from xterm's rendered rows — what is on screen, not what was sent. */
	const screen = (job: string) => running.evaluate<{ lines: string[]; green: number }>(
		`(()=>{const view=document.querySelector('[data-service-id="${job}"] [data-output-terminal]');const rows=view?[...view.querySelectorAll(".xterm-rows > div")].map((row)=>row.textContent.trimEnd()).filter(Boolean):[];return {lines:rows,green:view?view.querySelectorAll(".xterm-rows span.xterm-fg-2").length:0};})()`,
	);
	const row = (job: string) => running.evaluate<{ label: string; outcome: string; outcomeColor: string; ended: boolean }>(
		`(()=>{const row=document.querySelector('[data-service-id="${job}"]');const outcome=row.querySelector("[data-service-outcome]");return {label:row.querySelector("button").innerText.trim(),outcome:outcome.textContent.trim(),outcomeColor:getComputedStyle(outcome).color,ended:row.hasAttribute("data-service-ended")};})()`,
	);
	const jobIdOf = (label: string) => running.evaluate<string>(`[...document.querySelectorAll("[data-service-id]")].find((row)=>row.innerText.includes(${JSON.stringify(label)}))?.getAttribute("data-service-id") ?? ""`);

	await until(`document.body.innerText.includes("后台任务输出")`);
	await running.evaluate(`[...document.querySelectorAll("a,button,[role=button]")].find((node)=>node.textContent?.trim()==="后台任务输出")?.click()`);
	await pause(1000);

	// 1. 开发服务器在跑：⌘J 打开任务面板，点开它，看输出在长。
	await say("BG_SERVER 在后台把开发服务器跑起来");
	await until(`document.querySelector("main")?.innerText.includes("输出在任务面板里能看")`);
	await running.send("Input.dispatchKeyEvent", { type: "keyDown", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: 4 });
	await running.send("Input.dispatchKeyEvent", { type: "keyUp", key: "j", code: "KeyJ", windowsVirtualKeyCode: 74, modifiers: 4 });
	await until(`[...document.querySelectorAll("[data-service-id]")].some((row)=>row.innerText.includes("启动开发服务器"))`);
	const devJob = await jobIdOf("启动开发服务器");
	await pause(800);
	await shot("01_任务面板里列着正在跑的开发服务器");
	const live = await row(devJob);
	check("跑着的任务用它的说明列出来，不是那串 shell", live.label === "启动开发服务器" && !live.ended, live);
	await click(`[data-service-id="${devJob}"] button`);
	await until(`document.querySelector('[data-service-id="${devJob}"] [data-output-terminal] .xterm-rows')`);
	await pause(1200);
	const early = await screen(devJob);
	await pause(2000);
	const later = await screen(devJob);
	await shot("02_点开后输出实时滚动");
	check("点开后能看到输出", early.lines.some((line) => /ready GET \/api\/items \d+ 200/.test(line)), early.lines.slice(-2));
	const lastRequest = (lines: string[]) => Number(lines.at(-1)?.match(/items (\d+)/)?.[1] ?? 0);
	check("两秒后最后一行往前走了——是实时的，不是一次性的快照", lastRequest(later.lines) > lastRequest(early.lines), { before: lastRequest(early.lines), after: lastRequest(later.lines) });
	check("颜色保留着：ready 是绿色", later.green > 0, { greenSpans: later.green });
	const tall = await running.evaluate<number>(`Math.round(document.querySelector('[data-service-id="${devJob}"] [data-output-terminal]').getBoundingClientRect().height)`);
	check("输出多了就长到上限 220px，然后在里面滚", tall === 220, { height: tall });

	// 跑完：还在列表里，标着「完成」，输出还能看。
	await until(`document.querySelector('[data-service-id="${devJob}"][data-service-ended]')`, 20_000);
	await pause(1500);
	const finished = await row(devJob);
	const final = await screen(devJob);
	await shot("03_跑完了还留着_标着完成");
	check("结束后没有从列表里消失，标着「完成」", finished.ended && finished.outcome === "完成", finished);
	check("最后一行输出也到了", final.lines.some((line) => line.includes("/api/items 40 200")), final.lines.slice(-1));

	// 2. 失败的命令：对话里点那一行，任务面板翻到它、展开它。
	await click(`[data-service-id="${devJob}"] button`);
	await say("BG_FAIL 后台跑一下类型检查");
	await until(`[...document.querySelectorAll('[data-delivery-kind="job"]')].some((row)=>row.innerText.includes("后台命令失败"))`, 15_000);
	await until(`document.querySelector("main")?.innerText.includes("我去修")`);
	await pause(800);
	await shot("04_对话里的失败行");
	await running.evaluate(`[...document.querySelectorAll('[data-delivery-kind="job"]')].filter((row)=>row.innerText.includes("后台命令失败")).at(-1).querySelector(".ly-flow-row").setAttribute("data-e2e-failed-row","")`);
	await click("[data-e2e-failed-row]");
	await until(`[...document.querySelectorAll("[data-service-id]")].some((row)=>row.innerText.includes("运行类型检查") && row.querySelector("[data-output-terminal]"))`, 10_000);
	const typecheck = await jobIdOf("运行类型检查");
	await until(`document.querySelector('[data-service-id="${typecheck}"] .xterm-rows')?.textContent.includes("TS2322")`, 10_000);
	await pause(1200);
	await shot("05_点失败行直接展开它的输出");
	const failed = await row(typecheck);
	const failedScreen = await screen(typecheck);
	const danger = await running.evaluate<string>(`(()=>{const probe=document.createElement("span");probe.style.color="var(--color-danger)";document.body.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color;})()`);
	check("点对话里的失败行，任务面板展开的正是那个任务，报错就在里面", failedScreen.lines.some((line) => line.includes("error TS2322")), failedScreen.lines);
	check("失败的任务标着退出码，用危险色", failed.outcome === "退出码 2" && failed.outcomeColor === danger, { ...failed, danger });
	// 两行报错不该顶着一整块空白：视图的高度跟着内容走，满了才在里面滚。
	const fit = await running.evaluate<{ short: number; tall: number; rows: number }>(`(()=>{const h=(id)=>document.querySelector('[data-service-id="'+id+'"] [data-output-terminal]')?.getBoundingClientRect().height??0;const row=document.querySelector('[data-service-id="${typecheck}"] .xterm-rows > div').getBoundingClientRect().height;return {short:Math.round(h("${typecheck}")),tall:0,rows:row};})()`);
	check("两行报错的视图只有两三行高，不是固定的 220px", fit.short > 0 && fit.short <= fit.rows * 3 + 16, fit);
	await pause(1000);
} catch (error) {
	if (app) {
		const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_失败现场.png`), Buffer.from(picture.data, "base64"));
		console.log(await app.evaluate<string>(`JSON.stringify([...document.querySelectorAll("[data-service-id]")].map((row)=>row.getAttribute("data-service-id")+" "+row.innerText.replace(/\\s+/g," ").slice(0,80)))`));
	}
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_任务面板看后台输出_${passed}of${checks.length}.mp4`);
await encode(frames, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
