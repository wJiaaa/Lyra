/* oxlint-disable no-console -- a probe CLI whose entire output is what it printed */

/**
 * 子代理跑到一半，应用被强杀；重新打开、人说「继续」——续上的是原来那一个。
 *
 * 从前登记簿只在内存里：重开之后名单是空的，主会话那条 `task` 只剩一句「Plume exited while this
 * call was running」，没有 id；模型只好从零重派，把读过的文件再读一遍。
 *
 * 杀进程用 SIGKILL：`before-quit` 一行都不会跑，要验的正是这种退出（崩溃、强退、断电），照
 * `interrupted-calls-demo.ts` 的做法，两次启动共用一份 profile。
 *
 * 模型是假的，走真适配器（anthropic-messages）：
 *   - scout 每轮读一个文件；读完两个之后的那次请求挂住不回——这时强杀。被续上之后把剩下的读完。
 *     它的每条回复都带一段签过名的 thinking：续跑时原样发回去，前缀才和强杀前那个请求一样。
 *   - 主会话：结果里有 `resume: "<id>"` 就续跑那一个，没有就从零重派。修复前后走的是两条路。
 *
 * 后半段：再派一个 helper，在名单里把 scout 关掉，再强杀一次——重开后 scout 不该回来，helper 还在。
 *
 * 用法：node --experimental-strip-types e2e/subagent-restart-resume-probe.ts [输出目录]
 * 先 build：探针跑的是 out/ 里的产物。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { encode, frameGrabber, type Frame } from "./record.ts";
import { fixtureStore } from "./session-fixture.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume子代理重启后续跑测试");
const MODEL_PORT = 9878;
const CDP_PORT = 9504;
const INSPECT_PORT = 9534;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FILES = ["a.ts", "b.ts", "c.ts", "d.ts"];
const READ_BEFORE_KILL = 2;
const RESUME_PROMPT = "接着把剩下的读完";
const TITLE = "梳理一下登录流程";
const SCOUT = "梳理登录流程";
const HELPER = "帮手看一眼";
const HELPER_ASK = "再派一个帮手";
const STILL_THERE = "还在吗";

const scoutRequests: { resumed: boolean; sawResults: string[]; body: { system?: unknown; tools?: unknown; messages?: Turn[] } }[] = [];
const scoutReads: string[] = [];
const mainPhases: string[] = [];
let scoutHung = false;

function sse(res: ServerResponse, events: [string, unknown][]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
	res.end();
}

function reply(res: ServerResponse, r: { text?: string; tool?: { name: string; input: Record<string, unknown> }; signed?: boolean }): void {
	const id = `t${Math.random().toString(36).slice(2, 8)}`;
	const at = r.signed ? 1 : 0;
	const blocks: [string, unknown][] = [
		...(r.signed
			? ([
					["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
					["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先读下一个文件。" } }],
					["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `PROBE-SIG-${id}` } }],
					["content_block_stop", { type: "content_block_stop", index: 0 }],
				] as [string, unknown][])
			: []),
		["content_block_start", { type: "content_block_start", index: at, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: at, delta: { type: "text_delta", text: r.text ?? "" } }],
		["content_block_stop", { type: "content_block_stop", index: at }],
		...(r.tool
			? ([
					["content_block_start", { type: "content_block_start", index: at + 1, content_block: { type: "tool_use", id, name: r.tool.name, input: {} } }],
					["content_block_delta", { type: "content_block_delta", index: at + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(r.tool.input) } }],
					["content_block_stop", { type: "content_block_stop", index: at + 1 }],
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
			const userSaid = turns.filter((turn) => turn.role === "user").flatMap(blocksOf).filter((block) => block.type === "text").map(textOf);
			const results = turns.flatMap(blocksOf).filter((block) => block.type === "tool_result").map(textOf);
			const lastSaid = userSaid.at(-1) ?? "";

			if (system.includes("PROBE-HELPER")) {
				reply(res, { text: "PROBE-HELPER-DONE 看过了。" });
				return;
			}
			if (system.includes("PROBE-SCOUT")) {
				const resumed = userSaid.includes(RESUME_PROMPT);
				scoutRequests.push({ resumed, sawResults: results, body });
				if (!resumed && scoutReads.length >= READ_BEFORE_KILL) {
					// 挂住：这时候应用会被强杀。
					scoutHung = true;
					return;
				}
				const next = FILES.find((file) => !scoutReads.includes(file));
				if (next) {
					scoutReads.push(next);
					reply(res, { text: `读 ${next}`, tool: { name: "read", input: { path: next } }, signed: true });
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
			if (lastSaid === HELPER_ASK) {
				mainPhases.push(results.some((text) => text.includes("PROBE-HELPER-DONE")) ? "helper done" : "helper");
				if (results.some((text) => text.includes("PROBE-HELPER-DONE"))) reply(res, { text: "PROBE-MAIN-HELPED" });
				else reply(res, { text: "派个帮手。", tool: { name: "task", input: { description: HELPER, prompt: "看一眼 a.ts", subagent_type: "helper" } } });
				return;
			}
			if (lastSaid === STILL_THERE) {
				mainPhases.push("here");
				reply(res, { text: "PROBE-MAIN-HERE" });
				return;
			}
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
			mainPhases.push("redispatch");
			reply(res, { text: "上一个被打断了，重新派一个。", tool: { name: "task", input: { description: "梳理登录流程", prompt: "梳理登录流程：把四个文件都读一遍", subagent_type: "scout" } } });
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
	await writeFile(join(project, ".plume", "agents", "helper.md"), "---\nname: helper\ndescription: 帮手\ntools: [read]\n---\n你是帮手 PROBE-HELPER。\n");
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
					models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
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

const model = startModel();
const home = await mkdtemp(join(tmpdir(), "ly-sub-restart-"));
const frames: Frame[] = [];
let app: RunningApp | undefined;
/** Stops the frame loop, waits for its last frame, then lets go of the connection — closing it mid-frame leaves that frame waiting forever. */
let film: { stop: () => Promise<void> } | undefined;

async function launch() {
	const running = await startApp({ port: CDP_PORT, inspectPort: INSPECT_PORT, reuseHome: home });
	app = running;
	await running.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	const grab = await frameGrabber(CDP_PORT);
	const state = { on: true };
	const done = (async () => {
		while (state.on) {
			try {
				frames.push({ at: Date.now(), data: await grab.shot() });
			} catch {
				await pause(50);
			}
		}
	})();
	film = {
		stop: async () => {
			state.on = false;
			await done;
			grab.close();
		},
	};
	await pause(1500);

	const mainText = () => running.evaluate<string>(`(document.querySelector("main")?.innerText ?? "")`);
	const until = async (probe: () => Promise<boolean>, tries = 120) => {
		for (let index = 0; index < tries; index++) {
			if (await probe()) return true;
			await pause(250);
		}
		return false;
	};
	const shot = async (name: string) => {
		const { data } = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(data, "base64"));
		console.log(`  → ${stamp}_${name}.png`);
	};
	const send = (text: string) =>
		running.evaluate(`(() => {
			const field = document.querySelector("main textarea");
			if (!field) throw new Error("找不到输入框");
			const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
			setter.call(field, ${JSON.stringify(text)});
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		})()`);
	const press = async (selector: string) => {
		const at = await running.evaluate<{ x: number; y: number; lands: boolean } | null>(`(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!el) return null;
			el.scrollIntoView({ block: "center" });
			const r = el.getBoundingClientRect();
			const x = r.left + r.width / 2, y = r.top + r.height / 2;
			const hit = document.elementFromPoint(x, y);
			return { x, y, lands: !!hit && (hit === el || el.contains(hit)) };
		})()`);
		if (!at?.lands) return false;
		await running.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
		await running.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
		await running.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
		return true;
	};
	const rosterCount = () =>
		running.evaluate<number>(`(() => {
			const header = document.querySelector('[data-dock-pane="subagents"] [data-sub-header]');
			if (!header) return -1;
			return header.querySelectorAll("[data-pile-face]").length || 1;
		})()`);
	/** SIGKILL 主进程：`before-quit` 一行都不会跑。 */
	const crash = async () => {
		const pid = await running.main<number>("process.pid");
		await film?.stop();
		process.kill(pid, "SIGKILL");
		await pause(500);
		await running.stop();
		app = undefined;
	};
	return { running, mainText, until, shot, send, press, rosterCount, crash };
}

try {
	await mkdir(out, { recursive: true });
	await seed(home);

	// 1. 派活，scout 读完两个文件、挂在下一次请求上，强杀。
	let step = await launch();
	await step.send(TITLE);
	check("scout 读完两个文件、正在等模型", await step.until(async () => scoutHung), `读了 ${scoutReads.join("、")}`);
	await pause(1200);
	await step.shot("01_子代理跑到一半_即将强杀");
	await step.crash();

	// 2. 重开，打开那个会话。
	step = await launch();
	const opened = await step.until(async () =>
		step.running.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll("aside *")].find((node) => node.children.length === 0 && node.textContent?.trim() === ${JSON.stringify(TITLE)}); row?.click(); return !!row; })()`),
	);
	await step.until(async () => (await step.mainText()).includes("派一个 scout 去梳理"));
	check("重开后打开了那个会话", opened);
	await pause(1200);

	const store = fixtureStore(home);
	let record: string | undefined;
	try {
		for (const meta of await store.listSessions()) {
			for await (const one of store.read(meta.id)) {
				const line = JSON.stringify(one);
				if (line.includes('"role":"toolResult"') && line.includes('"toolName":"task"')) record = line;
			}
		}
	} finally {
		store.close();
	}
	check("落盘的 task 结果说应用退出时它在跑，且带着续跑那一个的 id", !!record && record.includes("Plume exited while this call was running") && /resume: \\"[\w-]+:sub:[0-9a-f]{8}\\"/.test(record));

	// 旧会话打开时只读日志、不起会话（`ensureLiveSession`），名单要等它真正起来——人说话的那一刻——才有。
	await step.shot("02_重开后_被打断的派发");

	// 3. 人说「继续」。
	await step.send("继续");
	const done = await step.until(async () => (await step.mainText()).includes("PROBE-MAIN-DONE"));
	check("主会话续跑了原来那一个，没有重派", done && mainPhases.some((p) => p.startsWith("resume ")) && !mainPhases.includes("redispatch"), `主会话走过：${mainPhases.filter((p) => p !== "aux").join(" → ")}`);
	const firstResumed = scoutRequests.find((r) => r.resumed);
	check(
		"续上的第一个请求里带着强杀前读到的内容",
		!!firstResumed && ["export const a", "export const b"].every((text) => firstResumed.sawResults.some((r) => r.includes(text))),
		firstResumed ? `前面的工具结果 ${firstResumed.sawResults.length} 条` : "没有续跑请求",
	);
	{
		// 缓存认的是前缀：续跑的第一个请求要以强杀前最后那个请求开头，一个字节都不差。缓存断点会挪，不算。
		const plain = (value: unknown) => JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner));
		const hung = scoutRequests.findLast((r) => !r.resumed)?.body;
		const resumed = firstResumed?.body;
		const before = (JSON.parse(plain(hung?.messages)) ?? []) as Turn[];
		const after = (JSON.parse(plain(resumed?.messages)) ?? []) as Turn[];
		const last = before.length - 1;
		// 最后一条是工具结果那一轮：续跑的那句话可能被并进同一个 user 轮，所以只比它开头那几块。
		const tail = last >= 0 && after[last]?.role === before[last]!.role && plain(blocksOf(after[last]!).slice(0, blocksOf(before[last]!).length)) === plain(blocksOf(before[last]!));
		const differs = before.findIndex((turn, index) => index < last && plain(turn) !== plain(after[index]));
		const sameSystem = plain(hung?.system) === plain(resumed?.system);
		const sameTools = plain(hung?.tools) === plain(resumed?.tools);
		const signatures = plain(after).match(/PROBE-SIG-/g)?.length ?? 0;
		check(
			"续跑的第一个请求以强杀前最后那个请求开头，逐字相同（系统提示、工具、消息，thinking 签名原样带着）",
			!!hung && !!resumed && differs < 0 && tail && sameSystem && sameTools && signatures === READ_BEFORE_KILL,
			`消息 ${before.length} 条 → ${after.length} 条；第一处不同：${differs < 0 ? (tail ? "无" : `第 ${last} 条`) : `第 ${differs} 条`}；系统提示${sameSystem ? "相同" : "不同"}、工具${sameTools ? "相同" : "不同"}；签名 ${signatures} 个`,
		);
	}
	const reread = scoutReads.filter((file, index) => scoutReads.indexOf(file) !== index);
	check("没有把读过的文件再读一遍", reread.length === 0, `scout 一共读了：${scoutReads.join("、")}`);
	await pause(1000);
	await step.press('main button[aria-label^="在面板里看"]');
	await pause(1200);
	const countAfter = await step.rosterCount();
	check("名单上始终只有一个子代理", countAfter === 1, `名单：${countAfter} 个`);
	const reads = await step.running.evaluate<string[]>(`document.querySelector('[data-dock-pane="subagents"]')?.innerText.match(/读取文件 [a-d]\\.ts/g) ?? []`);
	const sessionId = await (async () => {
		const store = fixtureStore(home);
		try {
			return (await store.listSessions())[0]!.id;
		} finally {
			store.close();
		}
	})();
	const kept = await step.running.evaluate<string[]>(`(async () => {
		const [one] = await window.plume.subAgents.list(${JSON.stringify(sessionId)});
		const detail = await window.plume.subAgents.detail(${JSON.stringify(sessionId)}, one.id);
		return detail.messages.map((m) => m.role + ":" + (m.role === "toolResult" ? m.content.map((p) => p.text ?? "").join("").slice(0, 24) : m.content.map((p) => p.type === "text" ? p.text.slice(0, 24) : p.type).join("|")));
	})()`);
	check("主进程登记簿里是一份转录，没有重复的消息", kept.length === 11 && new Set(kept).size === kept.length, `${kept.length} 条`);
	check("面板里是同一份转录：强杀前读的 a、b 接着强杀后读的 c、d", reads.join(",") === ["a", "b", "c", "d"].map((f) => `读取文件 ${f}.ts`).join(","), reads.join("、"));
	await step.shot("03_继续之后同一个子代理做完");
	await pause(1200);

	// 4. 再派一个 helper，然后在名单里把 scout 关掉。
	const scoutId = mainPhases.find((p) => p.startsWith("resume "))?.slice("resume ".length) ?? "";
	const roster = () => step.running.evaluate<string[]>(`window.plume.subAgents.list(${JSON.stringify(sessionId)}).then((all) => all.map((one) => one.id))`);
	await step.send(HELPER_ASK);
	check("helper 派出去、做完了", await step.until(async () => (await step.mainText()).includes("PROBE-MAIN-HELPED")));
	await pause(1000);
	// 面板开着时名单在面板标题上（两个以上才是下拉），关着时在输入框上面那一行。
	if (!(await step.press("[data-sub-header] button[data-sub-switch]"))) await step.press("button[data-ly-subagent-bar]");
	await step.until(async () => step.running.evaluate<boolean>(`Boolean(document.querySelector("[data-sub-menu] [data-sub-row]"))`), 40);
	await pause(800);
	await step.shot("04_名单里两个_关掉scout之前");
	const closed = await step.press(`[data-sub-menu] [data-sub-row="${scoutId}"] button[aria-label^="关闭"]`);
	await step.until(async () => !(await roster()).includes(scoutId), 40);
	const left = await roster();
	check("在名单里点 × 关掉了 scout，只剩 helper", closed && left.length === 1 && !left.includes(scoutId), `名单：${left.join("、")}`);
	await pause(1200);

	// 5. 再强杀一次，重开，说句话让会话起来——关掉的不该回来。
	await step.crash();
	step = await launch();
	await step.until(async () =>
		step.running.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll("aside *")].find((node) => node.children.length === 0 && node.textContent?.trim() === ${JSON.stringify(TITLE)}); row?.click(); return !!row; })()`),
	);
	await step.until(async () => (await step.mainText()).includes("PROBE-MAIN-HELPED"));
	await pause(800);
	await step.send(STILL_THERE);
	await step.until(async () => (await step.mainText()).includes("PROBE-MAIN-HERE"));
	await pause(1200);
	const reopened = await roster();
	check("重开后关掉的 scout 没有回来，helper 还在", reopened.length === 1 && !reopened.includes(scoutId), `名单：${reopened.join("、")}`);
	const bar = await step.running.evaluate<string>(`[document.querySelector("[data-sub-header]"), document.querySelector("button[data-ly-subagent-bar]")].map((node) => node?.innerText ?? "").join(" ")`);
	check("界面上只有 helper", bar.includes(HELPER) && !bar.includes(SCOUT), bar.replace(/\s+/g, " "));
	await step.shot("05_重开后_关掉的没有回来");
	await pause(1200);

	await film?.stop();
	const passed = checks.filter((c) => c.ok).length;
	const video = join(out, `${stamp}_强杀重开后说继续续跑原子代理_${passed}of${checks.length}.mp4`);
	await encode(frames, video, 30, 1500);
	console.log(`  → ${frames.length} 帧 → ${video}`);
	console.log(`\n${passed}/${checks.length} 通过`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await film?.stop();
	await app?.stop();
	await closeListeningServer(model);
	// 验完把测试数据清掉：profile 在临时目录里，不在用户的 ~/.plume。
	await rm(home, { recursive: true, force: true });
}
