/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一轮工具活在转录里分成几行，以及外观页那三个「工具调用分组」开关管不管用——边验边录。
 *
 * 假模型按剧本：想一下、读文件、跑一条带管道的 grep；再搜一次、`sed -n` 看几行；改一处、写一个新
 * 文件；跑两条真正执行的命令；最后一句回答。
 *
 * 要看的是：只读的 shell 命令和读、搜合成同一行探索；文件更改默认一处一行；执行命令合成一行。然后在
 * 设置里关掉「合并探索」、打开「合并文件更改」，回到对话，同一轮按新的规则重新分行。
 *
 * 用法：node --experimental-strip-types e2e/tool-grouping-demo.ts [before|after] [输出目录]
 * `before` 只拍跑完那一下，那时还没有这三个开关。
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, openSettings } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume工具调用分组测试");
const PORT = 9493;
const MODEL_PORT = 9593;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

type Block = { tool: string; args: Record<string, unknown> } | { text: string } | { thinking: string };

const SCRIPT: Block[][] = [
	[{ thinking: "先找找 one 在哪。" }, { tool: "read", args: { path: "src/one.ts" } }, { tool: "bash", args: { command: "grep -rn 'one|two' src | head -5" } }],
	[{ tool: "grep", args: { pattern: "one" } }, { tool: "bash", args: { command: "sed -n 1,3p src/one.ts" } }],
	[
		{ tool: "edit", args: { path: "src/one.ts", old_string: "export const one = 1", new_string: "export const one = 2" } },
		{ tool: "write", args: { path: "src/two.ts", content: "export const two = 2\n" } },
	],
	[{ tool: "bash", args: { command: "sleep 1 && echo build-ok" } }, { tool: "bash", args: { command: "node -e \"console.log('tests-ok')\"" } }],
	[{ text: "改好了：`one` 改成 2，另加了 `src/two.ts`。" }],
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
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } } as never);
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
let shot = 0;

try {
	await mkdir(OUT_DIR, { recursive: true });
	app = await startApp({ port: PORT, seed });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
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
	const kinds = (list: { step: string }[]) => list.map((item) => item.step).join();

	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await d.type("把 one 改成 2，再加一个 two，跑一下确认");
	await pause(400);
	await d.submit();
	await d.settled(60000);
	await pause(1400);

	const defaults = await steps();
	console.log("跑完，默认设置：", defaults);
	await capture("跑完_默认设置");

	if (LABEL === "before") {
		console.log("改动前的分行：", kinds(defaults));
	} else {
		check("只读命令和读、搜合成一行探索；改文件一处一行；执行命令合成一行", kinds(defaults) === "explore,files,files,terminal", defaults);
		check("探索那一行把 grep 管道和 sed -n 也算进去", defaults[0]?.words === "思考 1 次 · 读取文件 one.ts、执行命令 2 个、搜索内容", defaults[0]);
		check("执行命令那一行是两条真正跑的命令", defaults.at(-1)?.words === "执行命令 2 个", defaults.at(-1));

		await pause(800);
		await openSettings(app, "外观");
		await app.evaluate(`(() => {
			// 给每一行的开关一个名字，好按名字点：开关本身没有可见的标签，标签是同一行的标题。
			for (const [text, key] of [["合并探索", "explore"], ["合并终端命令", "terminal"], ["合并文件更改", "changes"]]) {
				const label = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === text);
				let row = label;
				while (row && !row.querySelector('[role="switch"]')) row = row.parentElement;
				row?.querySelector('[role="switch"]')?.setAttribute("data-probe-toggle", key);
			}
		})()`);
		await pause(900);
		// 设置页挂上之后会把滚动放回顶上一次，等它停稳再滚到这一节。
		await app.evaluate(`document.querySelector('[data-probe-toggle="explore"]')?.scrollIntoView({ block: "center" })`);
		await pause(700);
		const before = await app.evaluate<Record<string, string | null>>(`Object.fromEntries([...document.querySelectorAll("[data-probe-toggle]")].map((el) => [el.dataset.probeToggle, el.getAttribute("aria-checked")]))`);
		await capture("设置_工具调用分组_默认");
		check("外观页有三个开关，默认：探索开、终端开、文件更改关", before.explore === "true" && before.terminal === "true" && before.changes === "false", before);

		await click(app, '[data-probe-toggle="explore"]');
		await pause(700);
		await click(app, '[data-probe-toggle="changes"]');
		await pause(900);
		const after = await app.evaluate<Record<string, string | null>>(`Object.fromEntries([...document.querySelectorAll("[data-probe-toggle]")].map((el) => [el.dataset.probeToggle, el.getAttribute("aria-checked")]))`);
		await capture("设置_关探索_开文件更改");
		check("点过之后：探索关、文件更改开", after.explore === "false" && after.changes === "true", after);

		await closeSettings(app);
		await pause(1400);
		const flipped = await steps();
		console.log("改了设置之后：", flipped);
		await capture("跑完_关探索_开文件更改");
		check("关了探索，读、grep 管道、搜、sed -n 各自一行；开了文件更改，改和写合成一行", kinds(flipped) === "explore,explore,explore,explore,files,terminal", flipped);
		check("文件更改那一行说的是两件事", flipped.find((item) => item.step === "files")?.words === "修改文件 one.ts、创建文件 two.ts", flipped.find((item) => item.step === "files"));
		await pause(800);
	}
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_工具调用分组_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
