/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一段探索跑着时那一行说什么：最新那一次调用，每来一次滚一下；后面接上回答了，再滚成总的。
 *
 * 假模型一次一个调用：带说明的 read、带说明的 grep、带说明的 ls、不带说明的 read、不带说明的 grep，
 * 然后慢慢写出回答。每一帧记下探索那一行的字和滚进来的那一层，边验边录。
 *
 * 用法：先 `pnpm build`，再 `node --experimental-strip-types e2e/explore-head-demo.ts [输出目录]`
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume探索行测试");
const PORT = 9497;
const MODEL_PORT = 9597;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const ANSWER = "超时回复的处理在 src/one.ts，审批规则写在 docs/safety.md。";
const SCRIPT: ({ tool: string; args: Record<string, unknown> } | { text: string })[] = [
	{ tool: "read", args: { path: "docs/safety.md", description: "看审批规则怎么写" } },
	{ tool: "grep", args: { pattern: "timeout|overtime", description: "找超时相关的处理" } },
	{ tool: "ls", args: { path: "src", description: "看看 src 下有哪些文件" } },
	{ tool: "read", args: { path: "src/two.ts" } },
	{ tool: "grep", args: { pattern: "overtime" } },
	{ text: ANSWER },
];
/** 跑着时那一行应该依次说的话。 */
const LIVE = ["看审批规则怎么写", "找超时相关的处理", "看看 src 下有哪些文件", "读取文件 two.ts", "搜索内容 overtime"];
const TOTAL = "读取文件 2 个、搜索内容 2 个、列出目录 src";

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
			const block = titling ? { text: "探索行" } : SCRIPT[Math.min(request, SCRIPT.length - 1)];
			if (!titling) request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as never);
			// 一步一秒半上下：录下来要看得清每一次换字。
			if (!titling) await pause(1500);
			if ("text" in block) {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
				for (const char of block.text) {
					sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: char } } as never);
					if (!titling) await pause(70);
				}
			} else {
				sse(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${request}`, name: block.tool, input: {} } } as never);
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } } as never);
			}
			sse(res, { type: "content_block_stop", index: 0 } as never);
			sse(res, { type: "message_delta", delta: { stop_reason: "tool" in block ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } } as never);
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
	await mkdir(join(project, "docs"), { recursive: true });
	await writeFile(join(project, "src", "one.ts"), "export const timeout = 30 // overtime reply\n");
	await writeFile(join(project, "src", "two.ts"), "export const two = 2\n");
	await writeFile(join(project, "docs", "safety.md"), "# 审批\n\n只读命令不用审批。\n");
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

/**
 * 每一帧看一次探索那一行，变了才记：字、滚进来的是第几层、那一层带没带滚动、回答出来没有。
 *
 * 「第几层」靠给见过的节点编号：`RollWords` 换一句话是换一个带 key 的 span，同一句话里只缓宽度、节点不换。
 */
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
			answered: document.querySelector("main").innerText.includes(${JSON.stringify(ANSWER.slice(0, 6))}),
		};
		const key = JSON.stringify(now);
		if (key !== last) {
			log.push({ t: Math.round(performance.now()), ...now });
			last = key;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__exploreLog = log;
	return true;
})()`;

type Entry = { t: number; words: string; layer: number; rolled: boolean; answered: boolean };

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: unknown) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${JSON.stringify(saw)}`}`);
}

let app: RunningApp | undefined;
const model = startModel();
const frames: Frame[] = [];
let shot = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	const head = `[...document.querySelectorAll('main [data-ly-step="explore"]')].at(-1)?.querySelector(".ly-flow-row")?.textContent ?? ""`;

	await d.until(`document.querySelector("main textarea")`, 60000);
	await app.evaluate(WATCH);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await d.type("超时回复是在哪处理的？");
	await pause(400);
	await d.submit();

	await d.until(`(${head}).includes("找超时相关的处理")`, 30000);
	await pause(500);
	await capture("跑着_说的是最新那一次");
	await d.until(`(${head}).includes("读取文件 two.ts")`, 30000);
	await pause(500);
	await capture("跑着_没写说明的照旧");
	await d.until(`(${head}).includes(${JSON.stringify(TOTAL)})`, 30000);
	await pause(600);
	await capture("开始回答_滚成总的");
	await d.settled(60000);
	await pause(1400);

	// 跑完点开探索那一行，看每一次调用怎么说。
	await d.click('main [data-ly-step="explore"] .ly-flow-row');
	await pause(1400);
	await capture("跑完_展开探索那一行");
	const rows = await app.evaluate<string[]>(`[...document.querySelectorAll('main [data-ly-step="explore"] [data-ly-step-rail] .ly-flow-row')].map((row) => row.textContent.replace(/\\s+/g, " ").trim())`);
	await pause(800);
	await stop();

	const log = await app.evaluate<Entry[]>("window.__exploreLog");
	console.log("探索那一行的每一次变化：");
	for (const entry of log) console.log(`   ${entry.t}ms  第${entry.layer}层${entry.rolled ? "（滚）" : ""}  ${entry.answered ? "[回答中]" : ""}  ${entry.words}`);
	console.log("展开后的每一行：", rows);

	// 跑着 = 换成总的之前。模型的文字块一开始这一段就不在末尾了，那时回答的字可能还一个都没到。
	const turned = log.findIndex((entry) => entry.words === TOTAL);
	const live = log.slice(0, turned < 0 ? log.length : turned).filter((entry) => entry.words);
	const said = [...new Set(live.map((entry) => entry.words))];
	let from = 0;
	const inOrder = LIVE.every((text) => {
		const at = said.findIndex((words, index) => index >= from && words.startsWith(text));
		from = at + 1;
		return at >= 0;
	});
	check("跑着时依次说的是最新那一次调用，模型写了说明就是那句话", inOrder, said);
	check("跑着时从没说过总数", live.every((entry) => !/\d+ 个/.test(entry.words)), said);
	// 第一层是只有一次调用时的那一行自己，从第二次调用起才是一组。
	const grouped = live.filter((entry) => entry.layer > 1);
	const layersSeen = [...new Set(grouped.map((entry) => entry.layer))];
	check("成了一组之后每换一次调用都是滚进来的新一层", layersSeen.length === LIVE.length - 1 && grouped.every((entry) => entry.rolled), grouped);
	const total = log[turned];
	check("最后一次调用之后才滚成总的", turned > 0 && log[turned - 1].words.startsWith(LIVE.at(-1)!) && Boolean(total?.rolled) && total.layer > Math.max(...layersSeen), total);
	check("展开后带说明的调用说的是模型那句话，没带的照旧", rows[0]?.startsWith("看审批规则怎么写") && rows[2]?.startsWith("看看 src 下有哪些文件") && rows[3]?.startsWith("读取文件 two.ts") && rows[4]?.startsWith("搜索内容 overtime"), rows);

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_探索行跑着说最新一次_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
