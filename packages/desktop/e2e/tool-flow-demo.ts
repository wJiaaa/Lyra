/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一轮工具活在真窗口里怎么长出来、跑完之后停在哪儿——边验边录。
 *
 * 模型是本地一个按剧本吐 SSE 的假服务：先想一下、列目录找文件，再想、读文件搜引用，说一句话、改一处，
 * 想一下、跑两条命令，最后给出回答。第二轮只想一下、跑一条命令。每块之间留够停顿，好让录像看得清。
 *
 * 要看的是 `TurnWork` 和 `WorkStep`：锚从第一步起就在；同一类连着做的合成一行，从第一次调用起就说
 * 总的「思考 N 次 · …」，新的调用接在句尾、前面的字不动，末尾的推理接在句尾说「正在思考」；跑的时候
 * 已经出现的行一像素都不动、一行都不少；跑完不收，一行一行留着；点锚收起是动画不是硬切。
 *
 * 用法：node --experimental-strip-types e2e/tool-flow-demo.ts [标签] [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { closeSettings, openSettings } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume调用链重设计测试");
const PORT = 9491;
const MODEL_PORT = 9591;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

type Block = { tool: string; args: Record<string, unknown> } | { text: string } | { thinking: string };

// 要的是一条真正执行的命令。`cat` 这类只读命令在转录里和读文件归成同一段探索（`isShellRead`）。
const READ_BACK = "node -e \"process.stdout.write(require('fs').readFileSync('src/one.ts', 'utf8'))\"";

const SCRIPT: Block[][] = [
	[{ thinking: "先看看项目有多大。" }, { tool: "ls", args: { path: "." } }, { tool: "glob", args: { pattern: "**/*.ts" } }],
	[{ thinking: "目录很小，入口应该就是 src/one.ts，读一下再搜引用。" }, { tool: "read", args: { path: "src/one.ts" } }, { tool: "grep", args: { pattern: "one" } }],
	[{ text: "找到了，常量在 `src/one.ts` 里，改一下。" }, { tool: "edit", args: { path: "src/one.ts", old_string: "export const one = 1", new_string: "export const one = 2" } }],
	[{ thinking: "改完跑一下确认。" }, { tool: "bash", args: { command: "sleep 2 && echo toolcheck-complete" } }, { tool: "bash", args: { command: READ_BACK } }],
	[{ text: "改好了：`src/one.ts` 里的常量从 1 改成了 2，" }, { text: "命令也跑通了。" }],
	[{ thinking: "再读一遍文件确认。" }, { tool: "bash", args: { command: READ_BACK } }],
	[{ text: "确认过了，现在是 2。" }],
];
const BLOCK_DELAY_MS = 900;

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
			const blocks: Block[] = titling ? [{ text: "工具调用演示" }] : SCRIPT[at];
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
		// 这段要验的是「思考 N 次」怎么写进那一行，推理得画出来。
		showThinking: true,
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
	// 一轮（默认第一轮）：锚、锚下面每一行的位置和字、回答。位置都从锚的下沿量，转录自己滚动不算。
	const state = (which = 0) => app!.evaluate<{
		anchor: string | null; expanded: string | null; disabled: boolean;
		items: { top: number; height: number; text: string; words: string | null; step: string | null }[];
		glides: number;
	}>(`(() => {
		const all = document.querySelectorAll("main [data-ly-turn-process]");
		const turn = all[${which} < 0 ? all.length + ${which} : ${which}];
		const anchor = turn?.querySelector(":scope > .ly-turn-anchor");
		const base = anchor?.getBoundingClientRect().bottom ?? 0;
		return {
			anchor: anchor?.innerText.replace(/\\s+/g, " ").trim() ?? null,
			expanded: anchor?.getAttribute("aria-expanded") ?? null,
			disabled: Boolean(anchor?.disabled),
			items: [...(turn?.querySelectorAll(":scope > .ly-freeze") ?? [])].map((item) => {
				const box = item.getBoundingClientRect();
				const row = item.querySelector(".ly-flow-row");
				return { top: Math.round(box.top - base), height: Math.round(box.height), text: (row ?? item).innerText.replace(/\\s+/g, " ").trim().slice(0, 60), words: row?.querySelector(".ly-roll-words")?.textContent ?? null, step: item.querySelector("[data-ly-step]")?.getAttribute("data-ly-step") ?? null };
			}),
			glides: document.querySelectorAll("main .ly-glide:not([data-ly-scroll-dup])").length,
		};
	})()`);

	await d.until(`document.querySelector("main textarea")`, 60000);
	const stop = await startRecording(PORT, frames);
	await pause(800);
	await d.type("把 one 改成 2，顺便跑一下命令确认");
	await pause(400);
	await d.submit();

	/*
	 * 跑着的整段时间里一直采样：已经出现的行不许挪、不许少，行高不许变。
	 *
	 * 回答开始流式输出之后就停：那之后变的是回答自己的高度，不是过程。
	 */
	type Sample = Awaited<ReturnType<typeof state>>;
	/*
	 * 逐帧记每一段那一行行尾箭头的横坐标：句子变长时它是被推过去还是跳过去。
	 *
	 * 在每一帧 ResizeObserver 那一步的最后读，不在 rAF 里读。rAF 在布局之前：React 刚提交的那一帧，
	 * 行尾的附注还没被 `FlowTrail` 钉回旧宽，读到的是一个从来没画到屏幕上的位置——量出过 44px 的「跳」，
	 * 而逐帧看画出来的宽度是 0→5→9→…→44。每帧新建的观察者排在所有已有观察者后面，轮到它时钉宽已经做完。
	 */
	await app.evaluate(`(() => {
		window.__chevron = 0; window.__chevronAt = null; let id = 0; const last = new Map();
		const measure = () => {
			for (const step of document.querySelectorAll("main [data-ly-step]")) {
				const chevron = step.querySelector(":scope .ly-flow-row .ly-flow-chevron");
				if (!chevron) continue;
				// 按锚下面那一格认：一次调用的那一行换成合在一起的那一行时，格子还是那一格，换的那一下也要量。
				const slot = step.closest(".ly-freeze") ?? step;
				slot.dataset.probe ??= String(id++);
				const x = chevron.getBoundingClientRect().left;
				const before = last.get(slot.dataset.probe);
				if (before !== undefined && Math.abs(x - before) > window.__chevron) { window.__chevron = Math.abs(x - before); window.__chevronAt = step.innerText.slice(0, 40); }
				last.set(slot.dataset.probe, x);
			}
		};
		const tick = () => {
			const after = new ResizeObserver(() => { after.disconnect(); measure(); });
			after.observe(document.body);
			if (!window.__stopChevron) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	})()`);
	const samples: Sample[] = [];
	await d.until(`document.querySelector("main [data-ly-turn-process] > .ly-turn-anchor")`, 20000);
	let pictured = false;
	for (let i = 0; i < 400; i++) {
		const now = await state();
		samples.push(now);
		if (!now.disabled) break;
		// 两条命令跑着的时候拍一张：「终端」那一行在扫光，上面几段已经做完。
		if (!pictured && now.items.some((item) => item.step === "terminal")) {
			pictured = true;
			await capture("运行中");
		}
		await pause(60);
	}
	const live = samples.filter((sample) => sample.disabled);
	console.log(`运行中采样 ${live.length} 次`);
	const ticks = [...new Set(live.map((sample) => sample.anchor))];
	console.log("锚跑着时说过：", ticks);
	check("锚从第一步起就在、不能点，跑着时秒数一直往上走", live.length > 10 && live.every((sample) => /已工作|工作中/.test(sample.anchor ?? "")) && ticks.filter((text) => /已工作 \d+ 秒/.test(text ?? "")).length >= 3, ticks);

	let moved: unknown = null;
	let shrank: unknown = null;
	for (let i = 1; i < live.length; i++) {
		const [before, after] = [live[i - 1], live[i]];
		if (after.items.length < before.items.length) shrank ??= { before: before.items, after: after.items };
		// 最后一行可能是正在流式输出的话，它下面没有别的，长高不推动任何东西；比较的是它上面那些。
		for (let at = 0; at < Math.min(before.items.length, after.items.length) - 1; at++) {
			if (Math.abs(before.items[at].top - after.items[at].top) > 1 || Math.abs(before.items[at].height - after.items[at].height) > 1) moved ??= { at, before: before.items[at], after: after.items[at] };
		}
	}
	check("跑着的时候已经出现的行一行都没少", shrank === null, shrank);
	check("跑着的时候已经出现的行一像素都没挪、没变高", moved === null, moved);

	// 读代码那一行跑着时说过的每一句：后一句是前一句往后接的——数字原地变、一类只有一个时点名的文件换成个数，
	// 除此之外前一句的每一截都还在原位。
	const said = (step: string) => [...new Set(live.flatMap((sample) => sample.items.filter((item) => item.step === step && item.words).map((item) => item.words!)))];
	const pieces = (text: string) => text.split(/ · |、/).map((part) => part.replace(/ .*$/, ""));
	const grows = (texts: string[]) => texts.every((text, at) => at === 0 || pieces(texts[at - 1]).every((part, n) => pieces(text)[n] === part));
	const explore = said("explore");
	console.log("读代码那一行跑着时说过：", explore);
	check("列目录、找文件、读文件、搜索合成一行，一出来就说总的", live.every((sample) => sample.items.filter((item) => item.step === "explore").length <= 1) && explore.length >= 3 && /^思考 \d 次 · 列出目录/.test(explore[0]), explore);
	check("跑着时新的调用接在句尾，前面的字不动", grows(explore) && grows(said("terminal")), { explore, terminal: said("terminal") });
	await app.evaluate("window.__stopChevron = true");
	const jump = await app.evaluate<{ px: number; at: string | null }>("({ px: Math.round(window.__chevron), at: window.__chevronAt })");
	console.log("句子变长时行尾箭头一帧里最多挪了：", jump);
	check("句子变长时行尾被推过去：箭头一帧里挪不到 20px", jump.px < 20, jump);
	check("末尾还在写的推理接在句尾，句子本身不换", live.some((sample) => sample.items.some((item) => item.step && /正在思考/.test(item.text) && item.words && !/正在思考/.test(item.words))), live.map((sample) => sample.items.map((item) => item.text)));
	check("跑着的那一行在扫光", live.some((sample) => sample.glides > 0), live.map((sample) => sample.glides));

	await d.settled(60000);
	await pause(1400);
	const done = await state();
	console.log("跑完：", done.items.map((item) => `${item.step ?? "-"} ${item.text}`));
	await capture("跑完_一行一行留着");
	check("跑完锚写「已工作 N 秒」，不自动收", /已工作 \d+ 秒/.test(done.anchor ?? "") && done.expanded === "true", done.anchor);
	const visible = done.items.filter((item) => item.height > 0);
	check("跑完是一行一行的：读代码、一句话、改文件、跑命令、回答", visible.length === 5 && visible.filter((item) => item.step).map((item) => item.step).join() === "explore,files,terminal" && /改好了/.test(visible[4].text), visible);
	check("读代码那一行说想了几次、做了什么", /^思考 2 次 · 列出目录.*读取文件 one\.ts.*搜索内容/.test(done.items.find((item) => item.step === "explore")?.words ?? ""), done.items);
	check("改完之后想的那一次算在改文件那一行，不跟着去跑命令那一行", done.items.find((item) => item.step === "files")?.words === "修改文件 one.ts · 思考 1 次" && /\+1/.test(done.items.find((item) => item.step === "files")?.text ?? "") && done.items.find((item) => item.step === "terminal")?.words === "执行命令 2 个", done.items);
	check("跑完之后没有东西还在扫光", done.glides === 0, done.glides);

	// 点开读代码那一行：四次调用和两段推理挂在竖线下面。
	await d.click('main [data-ly-step="explore"] > .ly-flow-row');
	await pause(900);
	const rail = await app.evaluate<{ tools: string[]; thinking: number; border: string }>(`(() => {
		const rail = document.querySelector('main [data-ly-step="explore"] [data-ly-step-rail]');
		return { tools: [...(rail?.querySelectorAll("[data-ly-tool]") ?? [])].map((row) => row.innerText.replace(/\\s+/g, " ").trim()), thinking: rail?.querySelectorAll("[data-ly-thinking]").length ?? 0, border: rail ? getComputedStyle(rail).borderLeftWidth : "" };
	})()`);
	console.log("点开读代码那一行：", rail);
	await capture("点开读代码那一行");
	check("点开它是挂在竖线上的四次调用和两段推理", rail.tools.length === 4 && rail.thinking === 2 && rail.border === "1px", rail);
	await d.click('main [data-ly-step="explore"] > .ly-flow-row');
	await pause(700);

	/*
	 * 收起锚的那一下逐帧量：回答从下面一路上来，中间有过渡，不是一帧跳过去。
	 */
	await app.evaluate(`(() => {
		window.__fold = [];
		const turn = document.querySelector("main [data-ly-turn-process]");
		const anchor = turn.querySelector(".ly-turn-anchor");
		const answer = [...turn.querySelectorAll(":scope > .ly-freeze")].at(-1);
		const start = performance.now();
		const tick = () => { window.__fold.push(Math.round(answer.getBoundingClientRect().top - anchor.getBoundingClientRect().bottom)); if (performance.now() - start < 900) requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
	})()`);
	await d.click("main [data-ly-turn-process] > .ly-turn-anchor");
	await pause(1200);
	const fold = await app.evaluate<number[]>("window.__fold");
	const steps = new Set(fold);
	console.log("收起时回答到锚的距离，逐帧：", fold.join(" "));
	check("收起是动画：回答一路上来，中间至少经过 5 个位置", steps.size >= 5 && fold[fold.length - 1] < fold[0], fold);

	// 第二轮：想一下、跑一条命令。推理算进命令那一行，不另起一行。
	await d.type("再看一眼文件");
	await pause(400);
	await d.submit();
	await d.settled(60000);
	await pause(1400);
	const single = await state(-1);
	console.log("第二轮：", single.items);
	await capture("第二轮");
	check("一次推理加一次调用是一行「思考 1 次 · 执行命令」，跑完摊着", single.expanded === "true" && single.items.filter((item) => item.height > 0).length === 2 && single.items.some((item) => item.step === "terminal" && item.words === "思考 1 次 · 执行命令"), single.items);
	check("点锚收起的那一轮还收着", (await state()).expanded === "false", (await state()).anchor);

	// 设置 › 外观里不再有「调用链」这一行。
	await openSettings(app, "外观");
	// 「调用链」原来排在「出错时显示」下面，拍那一块，看删掉一行后上下的分隔线和留白。
	await app.evaluate(`[...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === "出错时显示")?.scrollIntoView({ block: "center" })`);
	await pause(600);
	const option = await app.evaluate<boolean>(`[...document.querySelectorAll("*")].some((el) => el.children.length === 0 && el.textContent?.trim() === "调用链")`);
	await capture("设置_外观");
	check("外观页没有「调用链」那一行", !option, option);
	await closeSettings(app);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_工具调用交互_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
}
