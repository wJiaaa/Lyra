/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 后台命令什么也没打印时，任务面板展开它说「没有输出」；输出被重定向进了文件，就把文件名说出来。
 *
 * 从前展开是两行空白的终端，和面板同一个底色，挂在一个「退出码 1」底下，看上去像输出丢了——
 * 实际是 `go test … > run.log 2>&1`，输出全在那个文件里。
 *
 * 模型是本地一个假的 Anthropic 端点，命令是真的。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/background-job-empty-output-demo.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, MODIFIER, press, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume后台任务无输出测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9814;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

/** 三条命令：输出进了文件、真的什么都不打印、照常打印（对照组，终端要还在）。 */
const SCENES: Record<string, { command: string; description: string }> = {
	BG_REDIRECT: { command: "sleep 1; echo '--- FAIL: TestImages' > run.log 2>&1; exit 1", description: "复测图片行为" },
	BG_SILENT: { command: "sleep 1; true", description: "静默同步缓存" },
	BG_LOUD: { command: "sleep 1; echo 'src/a.ts(3,7): error TS2322'; exit 2", description: "运行类型检查" },
};

type Reply = { text: string } | { tool: { id: string; command: string; description: string } };

function decide(messages: unknown[]): Reply {
	const raw = messages.map((message) => JSON.stringify(message));
	let from = 0;
	raw.forEach((text, index) => { if (/BG_[A-Z]+/.test(text) && !text.includes("tool_result")) from = index; });
	const tail = raw.slice(from).join("\n");
	const scene = SCENES[tail.match(/BG_[A-Z]+/)?.[0] ?? ""];
	if (!scene) return { text: "好的。" };
	if (tail.includes("background_job")) return { text: `${scene.description}结束了。` };
	if (!tail.includes('"tool_result"')) return { tool: { id: "job", ...scene } };
	return { text: `${scene.description}在后台跑着。` };
}

function reply(res: ServerResponse, answer: Reply) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	const tool = "tool" in answer ? answer.tool : null;
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `${tool.id}-${Date.now()}`, name: "bash", input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", {
		index: 0,
		delta: tool
			? { type: "input_json_delta", partial_json: JSON.stringify({ command: tool.command, description: tool.description, run_in_background: true }) }
			: { type: "text_delta", text: "text" in answer ? answer.text : "" },
	});
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

const SESSION = "bg-empty";

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "后台任务无输出", cwd, projectId, projectName: "后台任务无输出", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
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
		projects: [{ id: projectId, path: cwd, name: "后台任务无输出", pinned: true, lastOpenedAt: 1 }],
	}));
}

const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body: unknown = JSON.parse(raw);
		assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
		reply(res, decide(body.messages));
	});
});
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
	const page = app;

	const shot = async (name: string) => {
		const picture = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	};
	const row = (description: string) => `[...document.querySelectorAll("[data-service-id]")].find((row)=>row.innerText.includes(${JSON.stringify(description)}))`;
	const run = async (scene: string) => {
		const { description } = SCENES[scene];
		await type(page, "main textarea", `${scene} ${description}`);
		await press(page, "Enter", 13);
		await until(page, `document.querySelector("main")?.innerText.includes(${JSON.stringify(`${description}结束了`)})`, 1200);
	};
	/**
	 * 点开一行，同时数这一行里有没有挂上过终端：没输出的任务不该先闪一块空白再换成字。
	 * 观察者在点之前装好，记的是展开以后发生的每一次挂载。
	 */
	const expand = async (description: string) => {
		const id = await page.evaluate<string>(`${row(description)}.getAttribute("data-service-id")`);
		await page.evaluate(`(()=>{const row=document.querySelector('[data-service-id="${id}"]');window.__terminals=0;new MutationObserver(()=>{if(row.querySelector("[data-output-terminal]"))window.__terminals++;}).observe(row,{childList:true,subtree:true});})()`);
		await click(page, `[data-service-id="${id}"] button[aria-expanded]`);
		await until(page, `document.querySelector('[data-service-id="${id}"] [data-job-output-empty], [data-service-id="${id}"] .xterm-rows > div')`);
		await pause(600);
		return page.evaluate<{ note: string | null; noteHeight: number; terminal: boolean; terminalLines: string[]; mountedTerminal: number }>(`(()=>{const row=document.querySelector('[data-service-id="${id}"]');const note=row.querySelector("[data-job-output-empty]");const view=row.querySelector("[data-output-terminal]");return {note:note?.textContent??null,noteHeight:note?Math.round(note.getBoundingClientRect().height):0,terminal:Boolean(view),terminalLines:view?[...view.querySelectorAll(".xterm-rows > div")].map((r)=>r.textContent.trimEnd()).filter(Boolean):[],mountedTerminal:window.__terminals};})()`);
	};

	// 启动就停在这个项目的新对话上，直接在这里说。
	await until(page, `document.querySelector("main textarea")`);
	await pause(800);
	for (const scene of Object.keys(SCENES)) await run(scene);
	await press(page, "j", 74, MODIFIER.meta);
	// 任务列表只在面板看得见时才去取，所以等面板开了再找行。
	for (const { description } of Object.values(SCENES)) await until(page, `${row(description)}?.hasAttribute("data-service-ended")`, 600);
	await pause(800);
	await shot("01_三个任务都结束了_都还没展开");

	const redirected = await expand("复测图片行为");
	await shot("02_输出进了文件_说出文件名");
	check("输出被重定向的任务，展开后说出它写进了哪个文件", redirected.note === "没有输出：命令把输出写进了 run.log", redirected);
	check("不再画那块空白终端", !redirected.terminal, { terminal: redirected.terminal });
	check("一行字的高度，不是两行终端的高度", redirected.noteHeight > 0 && redirected.noteHeight <= 20, { height: redirected.noteHeight });

	const silent = await expand("静默同步缓存");
	await shot("03_什么都没打印_说没有输出");
	check("什么都没打印的任务，展开后说「没有输出」", silent.note === "没有输出" && !silent.terminal, silent);

	const loud = await expand("运行类型检查");
	await shot("04_有输出的任务照旧是终端");
	check("有输出的任务照旧画终端，报错在里面", loud.terminal && loud.note === null && loud.terminalLines.some((line) => line.includes("TS2322")), loud);

	check("展开没输出的任务时不先挂一块空终端再换成字", redirected.mountedTerminal === 0 && silent.mountedTerminal === 0, { redirected: redirected.mountedTerminal, silent: silent.mountedTerminal });
	await pause(1000);
} catch (error) {
	if (app) {
		const picture = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_失败现场.png`), Buffer.from(picture.data, "base64"));
	}
	throw error;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_后台任务无输出提示_${passed}of${checks.length}.mp4`);
await encode(frames, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
