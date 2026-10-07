/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 一轮外面那一行「已工作 Ns」：跑的时候表在走，跑完收起回答之前的一切——真窗口里录下来、量一遍。
 *
 * 单测管得到分块，管不到画面：表是不是贴在人发的话底下、收场后中间的汇报是不是真的看不见了、
 * 点开后过程是不是还按调用链的排法画，都只能在窗口里看。
 *
 * 模型是脚本：先说一句再干活，再说一句再干活，最后回答。
 *
 * Usage: node --experimental-strip-types e2e/whole-turn-fold-demo.ts [output directory] [label] [collapsed|expanded]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { shot } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume整轮折叠测试");
const LABEL = process.argv[3] ?? "改动后";
const CALL_CHAIN = process.argv[4] === "expanded" ? "expanded" : "collapsed";
const PORT = 9482;
const MODEL_PORT = 9584;
const BLOCK_DELAY_MS = 700;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = OUT_DIR;

const FIRST = "我先看一下目录结构。";
const SECOND = "找到两个文件，逐个读一下。";
const ANSWER = "两个文件都看过了：one.ts 导出 1，two.ts 导出 2。改动可以从 one.ts 开始。";

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
/** One entry per request, in order. */
const SCRIPT: Block[][] = [
	[{ text: FIRST }, { tool: "ls", args: { path: "." } }, { tool: "glob", args: { pattern: "**/*.ts" } }],
	[{ text: SECOND }, { tool: "read", args: { path: "one.ts" } }],
	[{ tool: "read", args: { path: "two.ts" } }],
	[{ text: ANSWER }],
];

let app: RunningApp;
let model: Server;
const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let request = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", async () => {
			const blocks = SCRIPT[Math.min(request, SCRIPT.length - 1)];
			request++;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as { type: string });
			for (const [index, block] of blocks.entries()) {
				await pause(BLOCK_DELAY_MS);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } } as { type: string });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } as { type: string });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } } as { type: string });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } } as { type: string });
				}
				sse(res, { type: "content_block_stop", index } as { type: string });
			}
			const stop = blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn";
			sse(res, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 40 } } as { type: string });
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
	await writeFile(join(project, "one.ts"), "export const one = 1\n");
	await writeFile(join(project, "two.ts"), "export const two = 2\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 760, x: 0, y: 0 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [{
			id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
			models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
		}],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		autoSummarizeTitle: false,
		permissionMode: "full",
		thinking: "off",
		appearance: { callChain: CALL_CHAIN },
		hooks: [], scheduledTasks: [], disabledPlugins: [], alwaysAllow: [],
		sync: { enabled: false, port: 4531, token: null },
	}));
}

interface Sample {
	running: boolean;
	/** 那一行上写的字，和它的状态。 */
	head: string;
	state: string;
	/** 那一行是不是紧贴在人发的那句话底下：中间没有别的行。 */
	underAsk: boolean;
	/** 收起的那一行里面画着几段过程行——点开后应当和没有这一行时一样多。 */
	segments: number;
	/** 看得见的那几句话。 */
	first: boolean;
	second: boolean;
	answer: boolean;
}

const SAMPLE = `(() => {
	const shown = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && el.getBoundingClientRect().height > 0;
	const said = (text) => [...document.querySelectorAll("main p")].some((el) => el.innerText.includes(text) && shown(el));
	const elapsed = document.querySelector("main [data-ly-turn-elapsed]");
	const rows = [...document.querySelectorAll("main [data-ly-transcript-rows] > *")];
	const at = rows.indexOf(elapsed);
	return {
		running: Boolean(document.querySelector('main button[aria-label="停止"]')),
		head: elapsed?.querySelector(":scope > .ly-flow-row .ly-flow-summary, :scope > [data-ly-turn-head] > .ly-flow-row .ly-flow-summary")?.innerText.trim() ?? "",
		state: elapsed?.dataset.lyTurnElapsed ?? "",
		underAsk: at > 0 && rows[at - 1].innerText.includes("看看这两个文件"),
		segments: elapsed ? [...elapsed.querySelectorAll("[data-ly-turn-process]")].filter(shown).length : 0,
		first: said(${JSON.stringify(FIRST)}),
		second: said(${JSON.stringify(SECOND)}),
		answer: said(${JSON.stringify(ANSWER.slice(0, 12))}),
	};
})()`;

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	model = startModel();
	const frames: Frame[] = [];
	app = await startApp({ port: PORT, seed, scaleFactor: 2 });
	const d = driver(app);
	const stop = await startRecording(PORT, frames);
	const samples: Sample[] = [];
	try {
		console.log(`【${LABEL}】发一句话：模型说一句、干活、再说一句、再干活，最后回答`);
		await d.until('document.querySelector("main textarea")', 30000);
		await pause(1200);
		await d.type("看看这两个文件");
		await pause(600);
		await d.submit();

		const end = Date.now() + 60_000;
		let started = false;
		let quiet = 0;
		let midShot = false;
		while (Date.now() < end) {
			const sample = await app.evaluate<Sample>(SAMPLE);
			samples.push(sample);
			if (sample.running && sample.second && !midShot) {
				midShot = true;
				await shot(app, `${STAMP}_${LABEL}_01_运行中`);
			}
			if (sample.running) { started = true; quiet = 0; }
			else if (started && ++quiet > 16) break;
			await pause(120);
		}

		const running = samples.filter((s) => s.running && s.state === "running");
		check("跑的时候那一行贴在人发的话底下", running.length > 0 && running.every((s) => s.underAsk), JSON.stringify(running.at(-1)));
		const ticks = [...new Set(running.map((s) => s.head))];
		check("跑的时候那一行的秒数在走", ticks.length >= 2 && ticks.every((t) => /^已工作 \d+s$/.test(t)), ticks.join(", ") || "（没有读数）");
		check("跑的时候中间那几句话照常看得见", running.some((s) => s.first && s.second), JSON.stringify(running.at(-1)));
		const last = samples.at(-1);
		await pause(1000);
		await shot(app, `${STAMP}_${LABEL}_02_跑完收起`);
		check("跑完之后那一行只说花了多久", Boolean(last && last.state === "done" && /^已工作 \d+\.\ds$/.test(last.head)), JSON.stringify(last));
		check("中间那两句话收进去了，回答露在外面", Boolean(last && !last.first && !last.second && last.answer), JSON.stringify(last));
		const rule = await app.evaluate<{ width: number; gap: number; chevron: boolean }>(`(() => {
			const line = document.querySelector("main [data-ly-turn-elapsed] > [data-ly-turn-rule]");
			const answer = [...document.querySelectorAll("main p")].find((el) => el.innerText.includes(${JSON.stringify(ANSWER.slice(0, 12))}));
			const chevron = document.querySelector("main [data-ly-turn-head] > .ly-flow-row .ly-flow-chevron");
			if (!line || !answer) return { width: 0, gap: -1, chevron: false };
			return { width: parseFloat(getComputedStyle(line).borderBottomWidth), gap: Math.round(answer.getBoundingClientRect().top - line.getBoundingClientRect().bottom), chevron: Boolean(chevron?.checkVisibility()) };
		})()`);
		check("那一行底下有一条细线、带着箭头，回答在线下面", rule.width > 0 && rule.width <= 1 && rule.gap >= 0 && rule.chevron, JSON.stringify(rule));
		const stamp = `(() => { const el = document.querySelector("main [data-ly-turn-started]"); const head = document.querySelector("main [data-ly-turn-head]")?.getBoundingClientRect(); const box = el?.getBoundingClientRect(); return { opacity: el ? getComputedStyle(el).opacity : "", text: el?.innerText.trim() ?? "", right: head && box ? Math.round(head.right - box.right) : -1 }; })()`;
		const idle = await app.evaluate<{ opacity: string; text: string; right: number }>(stamp);
		await d.hover("main [data-ly-turn-head] > button");
		await pause(600);
		const hovered = await app.evaluate<{ opacity: string; text: string; right: number }>(stamp);
		await shot(app, `${STAMP}_${LABEL}_02b_悬停看开始时间`);
		check("开始时间平时藏着，悬停才在最右边出来", idle.opacity === "0" && hovered.opacity === "1" && /\d{2}:\d{2}/.test(hovered.text) && hovered.right === 0, JSON.stringify({ idle, hovered }));
		await pause(1200);
		await pause(1800);

		console.log("【二】点开那一行：里面和没有这一行时一样，按调用链的排法画");
		await d.click("main [data-ly-turn-head] > button");
		await pause(1600);
		const opened = await app.evaluate<Sample>(SAMPLE);
		const inside = await app.evaluate<string>(`document.querySelector("main [data-ly-turn-elapsed]")?.innerText ?? ""`);
		await shot(app, `${STAMP}_${LABEL}_03_点开`);
		check("点开后中间那两句话回来了", opened.first && opened.second, JSON.stringify(opened));
		check("点开后两段过程各自还是一行，没有被并成一块", opened.segments === 2, `${opened.segments} 段`);
		// 两种排法各有自己的摘要写法：「折叠」说做了什么，「展开」数调用了几个。
		const summaries = CALL_CHAIN === "collapsed" ? /查找文件/.test(inside) && /读取文件/.test(inside) : (inside.match(/调用工具 2 个/g) ?? []).length === 2;
		check("两段过程的摘要照调用链的排法写", summaries, inside.replace(/\s+/g, " "));
		await pause(1800);

		console.log("【三】再点一次，收回去");
		await d.click("main [data-ly-turn-head] > button");
		await pause(1600);
		const closed = await app.evaluate<Sample>(SAMPLE);
		await shot(app, `${STAMP}_${LABEL}_04_收回`);
		check("再点一次收回去，回答还在", !closed.first && !closed.second && closed.answer && closed.segments === 0, JSON.stringify(closed));
		await pause(1200);
	} finally {
		await stop();
		console.log(`\n采到 ${frames.length} 帧，正在合成…`);
	}

	if (frames.length === 0) throw new Error("一帧都没采到");
	const passed = checks.filter((c) => c.ok).length;
	const out = join(OUT_DIR, `${STAMP}_${LABEL}_整轮折叠_${passed}of${checks.length}.mp4`);
	await app.stop();
	await closeListeningServer(model);
	await encode(frames, out, 60, 1200);
	console.log(`\n${passed}/${checks.length} 项通过`);
	console.log(`视频：${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error) => {
	console.error(error);
	await app?.stop().catch(() => {});
	if (model) await closeListeningServer(model).catch(() => {});
	process.exitCode = 1;
});
