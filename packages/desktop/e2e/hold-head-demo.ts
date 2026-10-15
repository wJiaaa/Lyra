/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一段探索里调用来得很快时，那一行每一句至少挂 650ms（`useHeldKey`），到点直接换成最新的那一次。
 *
 * 假模型一百多毫秒一个调用，连着九个，然后停一下再写回答。每一帧记下探索那一行的字和滚进来的那一层，
 * 量每一句在屏幕上待了多久，边验边录。`explore-head-demo.ts` 是一步一秒半的慢版本，看的是说什么。
 *
 * 用法：先 `pnpm build`，再 `node --experimental-strip-types e2e/hold-head-demo.ts [输出目录] [标签]`
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume探索行停留测试");
const LABEL = process.argv[3] ?? "";
const PORT = 9498;
const MODEL_PORT = 9598;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
/** 和 `src/ui/motion/held.ts` 的 `HOLD_MS` 是同一个数；量的是屏幕，留一帧多的余量。 */
const HOLD_MS = 650;
const SLACK = 40;

const ANSWER = "超时的处理在 src/one.ts。";
const CALLS: { tool: string; args: Record<string, unknown> }[] = [
	{ tool: "read", args: { path: "src/one.ts" } },
	{ tool: "read", args: { path: "src/two.ts" } },
	{ tool: "grep", args: { pattern: "timeout" } },
	{ tool: "read", args: { path: "src/three.ts" } },
	{ tool: "ls", args: { path: "src" } },
	{ tool: "read", args: { path: "src/four.ts" } },
	{ tool: "grep", args: { pattern: "overtime" } },
	{ tool: "read", args: { path: "src/five.ts" } },
	{ tool: "read", args: { path: "src/six.ts" } },
];
const TOTAL = "读取文件 6 个、搜索内容 2 个、列出目录 src";

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			// 起标题的那一次不带工具，不能吃掉剧本的一步。
			const titling = !body.includes('"tools"');
			const step = titling ? null : request++;
			const call = step === null ? null : CALLS[step];
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as never);
			// 调用一百多毫秒一个；回答前停一秒半，那一段还是正在做的那一段，停留看得见。
			if (step !== null) await pause(call ? 120 : 1500);
			if (call) {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${step}`, name: call.tool, input: {} } } as never);
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } } as never);
			} else {
				const text = titling ? "探索行停留" : ANSWER;
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
				for (const char of text) {
					sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: char } } as never);
					if (!titling) await pause(60);
				}
			}
			sse(res, { type: "content_block_stop", index: 0 } as never);
			sse(res, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } } as never);
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(join(project, "src"), { recursive: true });
	for (const name of ["one", "two", "three", "four", "five", "six"]) await writeFile(join(project, "src", `${name}.ts`), `export const ${name} = 1 // timeout overtime\n`);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
		hooks: [],
		scheduledTasks: [],
		disabledPlugins: [],
		alwaysAllow: [],
		appearance: { theme: "light" },
	}));
}

/** 和 `explore-head-demo.ts` 的同一个观察：每一帧看一次探索那一行，变了才记。 */
const WATCH = `(() => {
	const layers = new WeakMap();
	let next = 0;
	const log = [];
	let last = "";
	const tick = () => {
		const step = [...document.querySelectorAll('main [data-ly-step="explore"]')].at(-1);
		const row = step?.querySelector(".ly-flow-row");
		const words = row?.querySelector(".ly-roll-words");
		const layer = words?.firstElementChild;
		if (layer && !layers.has(layer)) layers.set(layer, ++next);
		const now = {
			words: (words ?? row)?.textContent.replace(/\\s+/g, " ").trim() ?? "",
			layer: layer ? layers.get(layer) : 0,
			rolled: Boolean(layer?.classList.contains("ly-roll-soft")),
		};
		const key = JSON.stringify(now);
		if (key !== last) {
			log.push({ t: Math.round(performance.now()), ...now });
			last = key;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__holdLog = log;
	return true;
})()`;

type Entry = { t: number; words: string; layer: number; rolled: boolean };

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

let app: RunningApp | undefined;
const model = startModel();
const frames: Frame[] = [];

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const head = `[...document.querySelectorAll('main [data-ly-step="explore"]')].at(-1)?.querySelector(".ly-flow-row")?.textContent ?? ""`;

	await d.until(`document.querySelector("main textarea")`, 60000);
	await app.evaluate(WATCH);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await d.type("超时是在哪处理的？");
	await pause(400);
	await d.submit();
	await d.until(`(${head}).includes(${JSON.stringify(TOTAL)})`, 30000);
	await d.settled(60000);
	await pause(1400);
	await stop();

	const log = await app.evaluate<Entry[]>("window.__holdLog");
	console.log("探索那一行的每一次换字（t 是到下一次换字为止挂了多久）：");
	const changes = log.filter((entry, index) => entry.words && entry.words !== log[index - 1]?.words);
	for (const [index, entry] of changes.entries()) {
		const held = changes[index + 1] ? changes[index + 1].t - entry.t : null;
		console.log(`   第${entry.layer}层${entry.rolled ? "（滚）" : ""}  ${held === null ? "  —  " : `${held}ms`}  ${entry.words}`);
	}

	// 第一层是只有一次调用时的那一行自己（工具行，不归 `StepGroup` 管），从第二层起是一组。
	const grouped = changes.filter((entry) => entry.layer > 1);
	const turned = grouped.findIndex((entry) => entry.words === TOTAL);
	const live = grouped.slice(0, turned < 0 ? grouped.length : turned);
	const durations = live.map((entry, index) => (grouped[index + 1]?.t ?? Infinity) - entry.t);
	check(`跑着时每一句都至少挂了 ${HOLD_MS}ms（含换成总的那一下）`, live.length > 0 && durations.every((ms) => ms >= HOLD_MS - SLACK), durations);
	check("来得太快的调用不排队：说过的句数比调用少", live.length + 1 < CALLS.length, live.map((entry) => entry.words));
	check("每换一句都是滚进来的新一层", grouped.every((entry) => entry.rolled), grouped);
	check("最后滚成总的", turned > 0, grouped.at(-1));

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL ? `${LABEL}_` : ""}快速调用每句挂满_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
