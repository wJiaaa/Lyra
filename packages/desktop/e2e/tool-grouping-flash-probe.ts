/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一条只读的 bash 在命令生成的那几百毫秒里，会不会先在底下冒一行、再并进上面的探索——逐次采样锚下面的分行。
 *
 * 假模型把参数分四段、隔 250ms 吐出来，和真模型一样：参数没吐完时 `arguments` 是空的，只有 `argumentsText`
 * 在长。改之前看到的是「探索 | 终端」两行，几百毫秒后合成一行；改之后从头到尾只有探索那一行。
 * 见 `grouping.ts` 的 `unclassified`。
 *
 * 用法：node --experimental-strip-types e2e/tool-grouping-flash-probe.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume工具调用分组测试");
const PORT = 9493;
const MODEL_PORT = 9593;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

type Block = { tool: string; args: Record<string, unknown> } | { text: string } | { thinking: string };

const SCRIPT: Block[][] = [
	[{ thinking: "先看看文件。" }, { tool: "read", args: { path: "src/one.ts" } }],
	[{ tool: "bash", args: { command: "sed -n 1,3p src/one.ts" } }],
	[{ text: "看完了。" }],
];
const BLOCK_DELAY_MS = 700;

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			// The session-title request carries no tools; answering it from the script would eat a step.
			const titling = !body.includes('"tools"');
			const at = Math.min(request, SCRIPT.length - 1);
			const blocks: Block[] = titling ? [{ text: "工具调用分组" }] : SCRIPT[at];
			if (!titling) request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as never);
			for (const [index, block] of blocks.entries()) {
				await pause(BLOCK_DELAY_MS);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } } as never);
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } as never);
				} else if ("thinking" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } } as never);
					sse(res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } } as never);
					sse(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } } as never);
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } } as never);
					// 参数分四段、隔 250ms 吐出来，和真模型一样：参数没吐完时 \`arguments\` 还是空的。
					const json = JSON.stringify(block.args);
					const size = Math.ceil(json.length / 4);
					for (let at = 0; at < json.length; at += size) {
						sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + size) } } as never);
						await pause(250);
					}
				}
				sse(res, { type: "content_block_stop", index } as never);
			}
			const stop = blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn";
			sse(res, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 40 } } as never);
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
	await writeFile(join(project, "src", "one.ts"), "export const one = 1\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
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
	}));
}

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
	// 锚下面每一段活：哪一类、那一行写着什么。只数画出来的行，回答不算。
	const steps = () => app!.evaluate<{ step: string; words: string }[]>(`(() => {
		const turn = document.querySelector("main [data-ly-turn-process]");
		return [...(turn?.querySelectorAll(":scope > .ly-freeze") ?? [])].flatMap((item) => {
			const step = item.querySelector("[data-ly-step]");
			if (!step || item.getBoundingClientRect().height === 0) return [];
			const row = step.querySelector(".ly-flow-row");
			return [{ step: step.getAttribute("data-ly-step"), words: (row?.querySelector(".ly-roll-words") ?? row ?? step).textContent.replace(/\\s+/g, " ").trim() }];
		});
	})()`);

	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames);
	await d.type("看一下 one.ts");
	await d.submit();
	const seen: string[] = [];
	for (let i = 0; i < 300; i++) {
		const now = (await steps()).map((item) => `${item.step}「${item.words}」`).join(" | ");
		if (now && now !== seen.at(-1)) seen.push(now);
		if (seen.length > 0 && (await app.evaluate<boolean>(`!document.querySelector('main button[aria-label="停止"]')`))) break;
		await pause(40);
	}
	console.log("跑的过程中依次出现过：");
	for (const line of seen) console.log("  ", line);
	check("只读命令从出现起就在探索那一行里，下面没有先冒出一行", seen.length > 0 && seen.every((line) => line.split(" | ").length === 1), seen);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_分行闪动复现_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
