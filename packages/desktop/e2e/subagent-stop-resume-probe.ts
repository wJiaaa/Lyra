/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * 子代理跑到一半，整轮被停；人说「继续」——主会话续跑的是原来那一个，还是又派了一个。
 *
 * 真实会话（2026-10-03）：停下时 `task` 的结果只剩一句通用的「Tool execution was cancelled」，没有
 * id。人说「继续」，模型从零重派了同一件事，名单上多出一条同名的、把读过的文件全部重读一遍的子代理。
 *
 * 模型是假的，走真适配器（anthropic-messages）：
 *   - scout 每轮读一个文件；读完两个之后的那次请求挂住不回，等人按停止。被续上之后把剩下的读完。
 *   - 主会话第一次派 scout；人说「继续」之后，结果里有 `resume: "<id>"` 就续跑那一个，没有就照
 *     真实会话里的样子从零重派——修复前后走的是两条不同的路，名单上数得出来。
 *
 * 用法：node --experimental-strip-types e2e/subagent-stop-resume-probe.ts [输出目录]
 * 先 build：探针跑的是 out/ 里的产物。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { encode, frameGrabber, type Frame } from "./record.ts";
import { fixtureStore } from "./session-fixture.ts";

const out = process.argv[2] ?? join(process.env.HOME ?? "/tmp", "Desktop", "Plume子代理停止后续跑测试");
const MODEL_PORT = 9877;
const CDP_PORT = 9503;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FILES = ["a.ts", "b.ts", "c.ts", "d.ts"];
/** 挂住之前读几个——停下时它手上已经有的东西。 */
const READ_BEFORE_STOP = 2;
const RESUME_PROMPT = "接着把剩下的读完";

const scoutRequests: { resumed: boolean; sawResults: string[] }[] = [];
const scoutReads: string[] = [];
const mainPhases: string[] = [];
let scoutHung = false;

function sse(res: ServerResponse, events: [string, unknown][]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
}

function reply(res: ServerResponse, r: { text?: string; tool?: { name: string; input: Record<string, unknown> } }): void {
	const id = `t${Math.random().toString(36).slice(2, 8)}`;
	const blocks: [string, unknown][] = [
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text ?? "" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		...(r.tool
			? ([
					["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: r.tool.name, input: {} } }],
					["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(r.tool.input) } }],
					["content_block_stop", { type: "content_block_stop", index: 1 }],
				] as [string, unknown][])
			: []),
	];
	sse(res, [
		["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "scripted", stop_reason: null, usage: { input_tokens: 500, output_tokens: 0 } } }],
		...blocks,
		["message_delta", { type: "message_delta", delta: { stop_reason: r.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }],
		["message_stop", { type: "message_stop" }],
	]);
}

type Block = { type: string; text?: string; content?: unknown };
type Turn = { role: string; content: string | Block[] };

const blocksOf = (turn: Turn): Block[] => (Array.isArray(turn.content) ? turn.content : [{ type: "text", text: turn.content }]);
const textOf = (block: Block): string =>
	block.type === "text"
		? (block.text ?? "")
		: block.type === "tool_result"
			? (Array.isArray(block.content) ? (block.content as Block[]).map((b) => b.text ?? "").join("") : String(block.content ?? ""))
			: "";

function startModel(): Server {
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = JSON.parse(raw) as { system?: string | { text?: string }[]; messages?: Turn[]; tools?: { name: string }[] };
			const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
			const turns = body.messages ?? [];
			const tools = (body.tools ?? []).map((tool) => tool.name);
			const userSaid = turns
				.filter((turn) => turn.role === "user")
				.flatMap(blocksOf)
				.filter((block) => block.type === "text" && !(block.text ?? "").startsWith("<env>"))
				.map(textOf);
			const results = turns.flatMap(blocksOf).filter((block) => block.type === "tool_result").map(textOf);

			if (system.includes("PROBE-SCOUT")) {
				const resumed = userSaid.includes(RESUME_PROMPT);
				scoutRequests.push({ resumed, sawResults: results });
				const next = FILES.find((file) => !scoutReads.includes(file));
				if (!resumed && scoutReads.length >= READ_BEFORE_STOP) {
					// 挂住：等人按停止，连接由客户端断开。
					scoutHung = true;
					return;
				}
				if (next) {
					scoutReads.push(next);
					reply(res, { text: `读 ${next}`, tool: { name: "read", input: { path: next } } });
					return;
				}
				reply(res, { text: "PROBE-SCOUT-DONE 四个文件都读完了：登录在 a.ts:1，登出在 d.ts:1。" });
				return;
			}

			if (!tools.includes("task")) {
				mainPhases.push("aux");
				reply(res, { text: "" });
				return;
			}

			// 主会话。
			if (results.some((text) => text.includes("PROBE-SCOUT-DONE"))) {
				mainPhases.push("done");
				reply(res, { text: "PROBE-MAIN-DONE 子代理做完了。" });
				return;
			}
			if (results.length === 0) {
				mainPhases.push("dispatch");
				reply(res, { text: "派一个 scout 去梳理。", tool: { name: "task", input: { description: "梳理登录流程", prompt: "梳理登录流程：把四个文件都读一遍", subagent_type: "scout" } } });
				return;
			}
			const id = results.join("\n").match(/resume: "([\w-]+:sub:[0-9a-f]{8})"/)?.[1];
			if (id) {
				mainPhases.push(`resume ${id}`);
				reply(res, { text: "接着跑原来那一个。", tool: { name: "task", input: { description: "接着梳理", prompt: RESUME_PROMPT, resume: id } } });
				return;
			}
			// 修复前真实会话里模型的做法：只知道被取消了，从零再派一个。
			mainPhases.push("redispatch");
			reply(res, { text: "上一个被取消了，重新派一个。", tool: { name: "task", input: { description: "梳理登录流程", prompt: "梳理登录流程：把四个文件都读一遍", subagent_type: "scout" } } });
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(join(project, ".plume", "agents"), { recursive: true });
	for (const file of FILES) await writeFile(join(project, file), `export const ${file.replace(".ts", "")} = 1\n`);
	await writeFile(join(project, ".plume", "agents", "scout.md"), "---\nname: scout\ndescription: 只读梳理\ntools: [read, ls]\n---\n你是只读梳理助手 PROBE-SCOUT。\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "local",
					name: "Local",
					baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
					api: "anthropic-messages",
					apiKey: "not-a-key",
					enabled: true,
					models: [
						{
							id: "local/scripted",
							providerId: "local",
							modelId: "scripted",
							name: "Scripted",
							contextWindow: 200000,
							maxOutputTokens: 8192,
							supportsThinking: false,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			autoSummarizeTitle: false,
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 0,
			subAgentDelegation: "auto",
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
}

const model = startModel();
let home = "";
const app = await startApp({
	port: CDP_PORT,
	seed: async (dir) => {
		home = dir;
		await seed(dir);
	},
});

const grab = await frameGrabber(CDP_PORT);
const frames: Frame[] = [];
const filming = { on: true };
const film = (async () => {
	while (filming.on) {
		try {
			frames.push({ at: Date.now(), data: await grab.shot() });
		} catch {
			await pause(50);
		}
	}
})();

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};
const stamp = (() => {
	const now = new Date();
	const two = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}-${two(now.getMinutes())}`;
})();

async function shot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(data, "base64"));
	console.log(`  → ${stamp}_${name}.png`);
}

const mainText = () => app.evaluate<string>(`(document.querySelector("main")?.innerText ?? "")`);
async function until(probe: () => Promise<boolean>, tries = 120): Promise<boolean> {
	for (let index = 0; index < tries; index++) {
		if (await probe()) return true;
		await pause(250);
	}
	return false;
}

/** 真实鼠标：先确认落点就是那个元素，再按下去。 */
async function press(selector: string): Promise<boolean> {
	const at = await app.evaluate<{ x: number; y: number; lands: boolean } | null>(`(() => {
		const el = document.querySelector(${JSON.stringify(selector)});
		if (!el) return null;
		el.scrollIntoView({ block: "center" });
		const r = el.getBoundingClientRect();
		const x = r.left + r.width / 2, y = r.top + r.height / 2;
		const hit = document.elementFromPoint(x, y);
		return { x, y, lands: !!hit && (hit === el || el.contains(hit)) };
	})()`);
	if (!at?.lands) return false;
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
	return true;
}

async function send(text: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		if (!field) throw new Error("找不到输入框");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	})()`);
}

/** 面板顶上数名单：一个时是一张脸，不止一个时叠成一摞。 */
const rosterCount = () =>
	app.evaluate<number>(`(() => {
		const header = document.querySelector('[data-dock-pane="subagents"] [data-sub-header]');
		if (!header) return -1;
		return header.querySelectorAll("[data-pile-face]").length || 1;
	})()`);

async function persisted(): Promise<string> {
	const store = fixtureStore(home);
	const logs: string[] = [];
	try {
		for (const meta of await store.listSessions()) {
			for await (const record of store.read(meta.id)) logs.push(JSON.stringify(record));
		}
	} finally {
		store.close();
	}
	return logs.join("\n");
}

try {
	await mkdir(out, { recursive: true });
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await pause(1500);

	// 1. 派活，scout 读了两个文件后挂在第三次请求上。
	await send("梳理一下登录流程");
	const hung = await until(async () => scoutHung);
	check("scout 读完两个文件、正在等模型", hung, `读了 ${scoutReads.join("、")}`);
	await pause(1200);
	await shot("01_子代理跑到一半");

	// 2. 人按停止。
	const stopped = await press('[data-composer-send="stop"]');
	const idle = await until(async () => (await app.evaluate<boolean>(`!document.querySelector('[data-composer-send="stop"]')`)));
	check("按下停止，整轮停下", stopped && idle);
	await pause(1200);
	await shot("02_整轮停下之后");

	// 模型下一轮读到的那一条：落盘的 task 工具结果。
	const record = (await persisted()).split("\n").find((line) => line.includes('"role":"toolResult"') && line.includes('"toolName":"task"'));
	check("落盘的 task 结果是一次停止，且带着续跑那一个的 id", !!record && record.includes("Tool execution was cancelled") && /resume: \\"[\w-]+:sub:[0-9a-f]{8}\\"/.test(record));
	check("它的 details 仍标着已停止，并带着 subAgentId", !!record && record.includes('"cancelled":true') && /"subAgentId":"[\w-]+:sub:[0-9a-f]{8}"/.test(record));

	// 3. 人说「继续」。
	await send("继续");
	const done = await until(async () => (await mainText()).includes("PROBE-MAIN-DONE"));
	check("主会话续跑了原来那一个，没有重派", done && mainPhases.some((p) => p.startsWith("resume ")) && !mainPhases.includes("redispatch"), `主会话走过：${mainPhases.filter((p) => p !== "aux").join(" → ")}`);
	await pause(1000);

	const firstResumed = scoutRequests.find((r) => r.resumed);
	check(
		"续上的第一个请求里带着停下前读到的内容",
		!!firstResumed && ["export const a", "export const b"].every((text) => firstResumed.sawResults.some((r) => r.includes(text))),
		firstResumed ? `前面的工具结果 ${firstResumed.sawResults.length} 条` : "没有续跑请求",
	);
	const reread = scoutReads.filter((file, index) => scoutReads.indexOf(file) !== index);
	check("没有把读过的文件再读一遍", reread.length === 0, `scout 一共读了：${scoutReads.join("、")}`);

	await press('main button[aria-label^="在面板里看"]');
	await pause(1200);
	const count = await rosterCount();
	check("名单上始终只有一个子代理", count === 1, `名单：${count} 个`);
	await shot("03_继续之后同一个子代理做完");

	await pause(1200);
	const passed = checks.filter((c) => c.ok).length;
	filming.on = false;
	await film;
	const video = join(out, `${stamp}_停止后说继续续跑原子代理_${passed}of${checks.length}.mp4`);
	await encode(frames, video, 30, 1500);
	console.log(`  → ${frames.length} 帧 → ${video}`);
	console.log(`\n${passed}/${checks.length} 通过`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	filming.on = false;
	grab.close();
	await app.stop();
	await closeListeningServer(model);
}
