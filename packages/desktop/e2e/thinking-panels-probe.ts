/**
 * The thinking line in the two other transcripts: a sub-agent's and the side chat's.
 *
 * `node --experimental-strip-types e2e/thinking-panels-probe.ts`
 *
 * Both draw the same `ThinkingBlock`, and the sub-agent panel groups its transcript with the
 * same `runs()` as the main conversation — so what was fixed there (a reasoning row that came
 * and went with every call, moving everything under it) has to hold here too, and what was
 * built there (the ticker) has to show here too. One scripted model answers all three
 * conversations, telling them apart by what the user asked.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { startApp } from "./app.ts";

const MODEL_PORT = 9575;
const OUT = "/tmp/lyra-thinking-probe";
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}

interface Step {
	thinking: string;
	tool?: { name: string; args: Record<string, unknown> };
	text?: string;
}

/** The main agent: hands the work to a sub-agent, then sums up what it heard back. */
const MAIN: Step[] = [
	{
		thinking: "先派一个子 agent 去看目录，我自己不读文件，免得把内容都装进上下文。",
		tool: { name: "task", args: { description: "列出项目文件", prompt: "子任务：列出项目里的文件并读一下 one.ts" } },
	},
	{ thinking: "子 agent 说只有一个文件，可以总结了。", text: "项目只有一个文件 one.ts。" },
];

/** The sub-agent: two calls with reasoning before each, then its report. */
const SUB: Step[] = [
	{ thinking: "子任务先看目录，目录结构会告诉我入口在哪，然后再决定读哪个文件。", tool: { name: "ls", args: { path: "." } } },
	{ thinking: "只有 one.ts 一个源码文件，读一下它导出了什么。", tool: { name: "read", args: { path: "one.ts" } } },
	{ thinking: "看完了，可以回报。", text: "只有 one.ts，导出常量 one。" },
];

/** The side chat: reasoning about the main transcript, then an answer. */
const SIDE: Step = {
	thinking: "用户在问主会话在做什么。看一下转录里最近的动作：主 agent 派了一个子 agent 去看目录。",
	text: "主会话在看项目文件。",
};

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** Which conversation is asking, from what its user said, and how far along it is. */
function scriptFor(body: { messages?: { role: string; content: unknown }[] }): Step {
	const messages = body.messages ?? [];
	const said = messages
		.filter((m) => m.role === "user")
		.map((m) =>
			typeof m.content === "string"
				? m.content
				: (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""),
		)
		.join("\n");
	const replies = messages.filter((m) => m.role === "assistant").length;
	if (said.includes("在干嘛")) return SIDE;
	if (said.includes("子任务")) return SUB[Math.min(replies, SUB.length - 1)];
	return MAIN[Math.min(replies, MAIN.length - 1)];
}

function startModel(): Server {
	let calls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			const step = scriptFor(JSON.parse(body));
			const id = calls++;
			// A real model takes a moment before its first token; that moment is where a jump lives.
			await settle(700);
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			sse(res, {
				type: "message_start",
				message: { id: `msg_${id}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } },
			});
			sse(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
			for (let at = 0; at < step.thinking.length; at += 6) {
				sse(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: step.thinking.slice(at, at + 6) } });
				await settle(80);
			}
			sse(res, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
			sse(res, { type: "content_block_stop", index: 0 });
			if (step.tool) {
				sse(res, {
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: `call_${id}`, name: step.tool.name, input: {} },
				});
				sse(res, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.args) } });
				sse(res, { type: "content_block_stop", index: 1 });
				sse(res, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } });
			} else {
				sse(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
				sse(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: step.text } });
				sse(res, { type: "content_block_stop", index: 1 });
				sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } });
			}
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
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 900, x: 0, y: 0 }));
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
							supportsThinking: true,
							supportsImages: false,
							supportsTools: true,
						},
					],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: "local/scripted",
			permissionMode: "full",
			thinking: "medium",
			retryAttempts: 1,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "dark" },
		}),
	);
}

interface PanelSample {
	t: number;
	found: boolean;
	thinking: number;
	ticker: boolean;
	tools: number;
	/** The lowest edge of anything in the transcript, which only ever moves down if nothing vanishes. */
	bottom: number | null;
	/** Each row's top and height, to say which one moved. */
	geom: string;
	done: boolean;
}

/** The sub-agent pane; what its transcript holds and how far down it reaches. */
const READ_SUB = `(() => {
	const panel = document.querySelector('[data-pane="subagents"]');
	if (!panel) return { found: false, thinking: 0, ticker: false, tools: 0, bottom: null, done: false };
	const rows = [...panel.querySelectorAll("[data-ly-thinking], .group\\\\/run")];
	// Layout position, not the painted one: a row arriving plays a 4px rise, and that is not the transcript moving.
	const top = (el) => {
		let y = 0;
		for (let e = el; e && e !== panel; e = e.offsetParent) y += e.offsetTop;
		return y;
	};
	return {
		found: true,
		thinking: panel.querySelectorAll("[data-ly-thinking]").length,
		ticker: Boolean(panel.querySelector(".ly-think-track")),
		tools: panel.querySelectorAll(".group\\\\/run").length,
		bottom: rows.length ? Math.round(Math.max(...rows.map((r) => top(r) + r.offsetHeight))) : null,
		geom: rows.map((r) => (r.matches("[data-ly-thinking]") ? "思考" : "工具") + top(r) + "+" + r.offsetHeight).join(" "),
		done: panel.innerText.includes("导出常量 one"),
	};
})()`;

interface SideSample {
	found: boolean;
	ticker: boolean;
	tx: number | null;
	runs: boolean;
	heading: boolean;
	chevron: boolean;
	answered: boolean;
}

/** The side chat pane. */
const READ_SIDE = `(() => {
	const panel = document.querySelector('[data-pane="chat"]');
	if (!panel) return { found: false, ticker: false, tx: null, runs: false, heading: false, chevron: false, answered: false };
	const track = panel.querySelector("[data-ly-thinking] .ly-think-track");
	let tx = null;
	if (track) {
		const cs = getComputedStyle(track);
		tx = Math.round(new DOMMatrixReadOnly(cs.transform === "none" ? "" : cs.transform).e * 10) / 10;
	}
	const line = panel.querySelector("[data-ly-thinking]");
	return {
		found: true,
		ticker: Boolean(track),
		tx,
		runs: Boolean(panel.querySelector("[data-ly-thinking] .ly-think-runs")),
		heading: Boolean(line && line.innerText.includes("思考过程")),
		chevron: Boolean(line && line.querySelector("svg.lucide-chevron-right")),
		answered: panel.innerText.includes("主会话在看项目文件"),
	};
})()`;

await mkdir(OUT, { recursive: true });
const model = startModel();
const app = await startApp({ port: 9467, seed });

async function type(selector: string, text: string): Promise<boolean> {
	return app.evaluate<boolean>(`(() => {
		const field = document.querySelector(${JSON.stringify(selector)});
		if (!field) return false;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	})()`);
}

async function shot(name: string): Promise<void> {
	const png = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT, name), Buffer.from(png.data, "base64"));
}

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
	await settle(600);
	await type("main textarea", "看看这个项目");

	/* ---------- the sub-agent panel ---------- */
	let bar = false;
	for (let i = 0; i < 80 && !bar; i++) {
		bar = await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-subagent-bar]"))`);
		if (!bar) await settle(100);
	}
	check("主 agent 派出了子 agent", bar, bar ? "子 Agent 条出现" : "没等到子 Agent 条");
	await app.evaluate(`document.querySelector("[data-ly-subagent-bar]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);

	const started = Date.now();
	const subs: PanelSample[] = [];
	let shotSub = false;
	while (Date.now() - started < 20_000) {
		const reading = await app.evaluate<Omit<PanelSample, "t">>(READ_SUB);
		subs.push({ t: Date.now() - started, ...reading });
		if (!shotSub && reading.thinking > 0 && reading.tools > 0 && reading.ticker) {
			await shot("06-subagent-panel.png");
			shotSub = true;
		}
		if (reading.done) break;
		await settle(50);
	}
	const seen = subs.filter((s) => s.found);
	check("子 Agent 面板打开了，并跑完了子任务", seen.length > 0 && subs[subs.length - 1].done, `${seen.length} 个样本，${(subs[subs.length - 1].t / 1000).toFixed(1)}s`);
	const firstThinking = seen.findIndex((s) => s.thinking > 0);
	const after = seen.slice(Math.max(0, firstThinking));
	check("子 Agent 面板里吐思考时是滚动条", seen.some((s) => s.ticker), `${seen.filter((s) => s.ticker).length} 个样本看到 .ly-think-track`);
	const thinking = after.map((s) => s.thinking);
	check(
		"子 Agent 面板里思考行一旦出现就不消失",
		firstThinking >= 0 && thinking.every((n) => n >= 1),
		`思考行数序列 ${thinking.filter((n, i) => i === 0 || n !== thinking[i - 1]).join(" → ")}`,
	);
	const bottoms = after.filter((s) => s.bottom !== null).map((s) => ({ t: s.t, y: s.bottom as number, geom: s.geom }));
	const ups = bottoms.slice(1).map((s, i) => ({ t: s.t, by: bottoms[i].y - s.y, before: bottoms[i].geom, after: s.geom })).filter((u) => u.by > 2);
	check(
		"子 Agent 面板的转录只往下长，不上跳",
		ups.length === 0,
		`上跳 ${ups.length} 次${ups.length ? `：${ups.map((u) => `${(u.t / 1000).toFixed(1)}s ↑${u.by}px [${u.before}] → [${u.after}]`).join("；")}` : ""}；轨迹 ${bottoms.filter((s, i) => i === 0 || s.y !== bottoms[i - 1].y).map((s) => `${s.y}@${(s.t / 1000).toFixed(1)}s`).join(" → ")}`,
	);

	/* ---------- the side chat ---------- */
	let mainDone = false;
	for (let i = 0; i < 100 && !mainDone; i++) {
		mainDone = await app.evaluate<boolean>(`document.querySelector("main").innerText.includes("项目只有一个文件")`);
		if (!mainDone) await settle(100);
	}
	check("主会话收到子 agent 的结果并作答", mainDone, mainDone ? "看到总结" : "没等到总结");

	await app.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "ß", code: "KeyS", metaKey: true, altKey: true, bubbles: true, cancelable: true }))`);
	let field = false;
	for (let i = 0; i < 30 && !field; i++) {
		field = await app.evaluate<boolean>(`Boolean(document.querySelector('textarea[placeholder="问点关于这个会话的事"]'))`);
		if (!field) await settle(100);
	}
	check("⌥⌘S 打开了侧边聊天", field, field ? "找到侧边聊天的输入框" : "没找到输入框");
	await type('textarea[placeholder="问点关于这个会话的事"]', "这个会话在干嘛");

	const sides: SideSample[] = [];
	let shotSide = false;
	const sideStart = Date.now();
	while (Date.now() - sideStart < 15_000) {
		const reading = await app.evaluate<SideSample>(READ_SIDE);
		sides.push(reading);
		if (!shotSide && reading.ticker && (reading.tx ?? 0) < -20) {
			await shot("07-sidechat.png");
			shotSide = true;
		}
		if (reading.answered) break;
		await settle(100);
	}
	const txs = sides.filter((s) => s.ticker && s.tx !== null).map((s) => s.tx as number);
	check("侧边聊天里吐思考时是滚动条，而且在往左滚", txs.length > 1 && txs[txs.length - 1] < txs[0] - 20, `tx 序列 ${txs.slice(0, 8).join(" → ")}${txs.length > 8 ? " …" : ""}`);
	const last = sides[sides.length - 1];
	check(
		"侧边聊天回答后思考行还在，停在开头，没有「思考过程」和箭头",
		last.answered && last.runs && !last.heading && !last.chevron,
		JSON.stringify(last),
	);
	await shot("08-sidechat-done.png");
} finally {
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}

process.stdout.write(`\n${failures === 0 ? "全部通过" : `${failures} 项未通过`}，截图在 ${OUT}\n`);
process.exit(failures === 0 ? 0 : 1);
