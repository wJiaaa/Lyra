/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * agent 用 `browser_open` 打开本地 HTML 之后，拿它给回的 tabId 能不能接着操作那一页。
 *
 * 真实会话里是：打开成功、给回 tabId，紧接着 `browser_viewport` 拿这个 tabId 报「先调用 browser_open」。
 * 模型于是放弃浏览器，改为造一堆验证页逐份 `preview` 检查，26 次。
 *
 * 用法：node --experimental-strip-types e2e/browser-local-tab-probe.ts
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, pause } from "./record.ts";

const PORT = 9498;
const MODEL_PORT = 9598;
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>本地页</title></head><body><h1>本地页</h1></body></html>`;

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const results: string[] = [];
/** 上一个工具结果里的 tabId：请求体是 JSON 里套 JSON，引号带转义。 */
const tabOf = (body: string) => /tabId[\\"]*:\s*[\\"]*([0-9a-f-]{36})/.exec(body)?.[1] ?? "missing";
const STEPS: ((body: string) => Block[])[] = [
	() => [{ tool: "preview", args: { title: "本地页", path: "page.html", check: true } }],
	() => [{ tool: "browser_open", args: { url: "page.html" } }],
	(body) => [{ tool: "browser_viewport", args: { tabId: tabOf(body), width: 390, height: 800 } }],
	() => [{ tool: "browser_tabs", args: { action: "list" } }],
	() => [{ text: "看完了。" }],
];
function next(body: string): Block[] {
	const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
	const last = parsed.messages.at(-1);
	if (last && Array.isArray(last.content)) for (const part of last.content as { type: string; content?: unknown }[]) if (part.type === "tool_result") results.push(JSON.stringify(part.content).slice(0, 240));
	const replies = parsed.messages.filter((message) => message.role === "assistant").length;
	return STEPS[Math.min(replies, STEPS.length - 1)]!(body);
}

let request = 0;
function sse(res: ServerResponse, payload: Record<string, unknown>): void {
	res.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function startModel(): Server {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const blocks = next(Buffer.concat(chunks).toString("utf8"));
			request++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(300);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } });
				}
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "page.html"), PAGE);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted", autoSummarizeTitle: false, permissionMode: "full", thinking: "off",
		appearance: { theme: "light" },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

const model = startModel();
let app: RunningApp | undefined;
let failed = false;
try {
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	await d.until('document.querySelector("main textarea")', 30000);
	await d.type("打开本地页看看");
	await d.submit();
	await d.settled(60000);
	await pause(500);
	for (const [index, text] of results.entries()) console.log(`  结果 ${index + 1}：${text}`);
	const viewport = results[2] ?? "";
	failed = /先调用 browser_open/.test(viewport) || !/innerWidth|width/.test(viewport);
	console.log(failed ? "\n✗ 打开以后拿 tabId 操作不了那一页" : "\n✓ 打开以后拿 tabId 能接着操作");
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
process.exit(failed ? 1 : 0);
