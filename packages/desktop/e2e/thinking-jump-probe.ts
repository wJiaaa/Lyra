/**
 * Whether the transcript jumps while a turn cycles between reasoning and tool calls.
 *
 * `node --experimental-strip-types e2e/thinking-jump-probe.ts`
 *
 * The report: the thinking line under a run of tools appears, vanishes when its call arrives,
 * and appears again with the next reply, and everything below it moves up and down with it.
 * Measured rather than watched: the y of the running indicator, sampled every 100ms through a
 * scripted turn of reason → call → result → reason → call → … → answer, with a model that pauses
 * before each reply as a real one does. A transcript that only
 * grows moves that line down and never up; every upward move is a jump, and its size is how
 * far the reader's eye was thrown.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { startApp } from "./app.ts";

const MODEL_PORT = 9574;
const OUT = "/tmp/lyra-thinking-probe";
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}

/** One reply per request: a stretch of reasoning, then a call — and finally, an answer. */
const TURN: { thinking: string; tool?: { name: string; args: Record<string, unknown> }; text?: string }[] = [
	{ thinking: "先看一下项目目录里有什么，再决定从哪个文件读起。目录结构会告诉我入口在哪。", tool: { name: "ls", args: { path: "." } } },
	{ thinking: "有一个 one.ts，看起来是唯一的源码文件，读一下它导出了什么。", tool: { name: "read", args: { path: "one.ts" } } },
	{ thinking: "只导出了一个常量。再确认一下有没有别的 ts 文件被我漏掉。", tool: { name: "glob", args: { pattern: "**/*.ts" } } },
	{ thinking: "没有别的了，可以总结。", text: "项目只有一个文件，导出常量 one。" },
];

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	let turn = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", async () => {
			const step = TURN[Math.min(turn, TURN.length - 1)];
			const id = turn++;
			// A real model takes a moment before its first token; that moment is where the jump lives.
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
				await settle(70);
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

interface Sample {
	t: number;
	/** Top of the running indicator, or of the last row once the turn is over. */
	y: number | null;
	running: boolean;
	thinking: number;
	rows: number;
	/** The final reply is on screen, which is the only honest end of the turn. */
	answered: boolean;
}

/** Where the bottom of the transcript is right now, and what is in it. */
const READ = `(() => {
	const running = document.querySelector("main [data-ly-running]");
	const rows = document.querySelectorAll("main [data-ly-thinking], main .group\\\\/run");
	return {
		y: running ? Math.round(running.getBoundingClientRect().top) : null,
		running: Boolean(running),
		thinking: document.querySelectorAll("main [data-ly-thinking]").length,
		rows: rows.length,
		answered: document.querySelector("main").innerText.includes("导出常量 one"),
	};
})()`;

await mkdir(OUT, { recursive: true });
const model = startModel();
const app = await startApp({ port: 9466, seed });

try {
	await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
	await settle(600);
	/*
	 * Every painted frame, not a sample of them and not every mutation either.
	 *
	 * A row that vanishes for one frame is invisible to a poll every 100ms and perfectly visible
	 * to the eye. A mutation observer sees too much the other way: it fires between React commits
	 * that the browser never paints, and reports states nobody could have seen. What the reader
	 * sees is what is laid out when a frame is painted, so that is what is recorded — one reading
	 * per animation frame, kept only when something changed.
	 */
	await app.evaluate(`(() => {
		const main = document.querySelector("main");
		const log = [];
		let last = null;
		const read = () => {
			const running = main.querySelector("[data-ly-running]");
			return {
				t: Math.round(performance.now()),
				thinking: main.querySelectorAll("[data-ly-thinking]").length,
				// Tool cards standing on their own (a call still running), and folded runs.
				cards: main.querySelectorAll(".ly-enter.mb-2.overflow-hidden").length,
				runs: main.querySelectorAll("[data-ly-run]").length,
				y: running ? Math.round(running.getBoundingClientRect().top) : null,
				// Heights of the things above the indicator, to say which of them moved it.
				h: [...main.querySelectorAll(".group\\\\/msg, [data-ly-run], .ly-enter.mb-2.overflow-hidden, .ly-reveal")]
					.map((el) => {
						const who = el.dataset.lyRun !== undefined ? "run" : el.dataset.lyThinking !== undefined ? "think" : el.className.split(" ")[0].slice(0, 12);
						const cs = getComputedStyle(el);
						const fold = el.lastElementChild;
						const fs = fold ? getComputedStyle(fold) : null;
						const tall = el.offsetHeight > 100
							? "{rect" + Math.round(el.getBoundingClientRect().height) + " kids" + [...el.children].map((c) => c.offsetHeight + "/" + Math.round(c.getBoundingClientRect().height) + "m" + getComputedStyle(c).marginTop + "," + getComputedStyle(c).marginBottom).join("+") +
								" root:" + cs.display + " h" + cs.height + " pad" + cs.paddingTop + "/" + cs.paddingBottom + " minH" + cs.minHeight + " scrollH" + el.scrollHeight +
								" fold:" + (fs ? fs.height + " ov" + fs.overflow + " disp" + fs.display + " tr" + fs.transitionProperty : "?") +
								" tops" + [...el.children].map((c) => c.offsetTop).join("/") + " nodes" + el.childNodes.length +
								" before:" + getComputedStyle(el, "::before").content + "/" + getComputedStyle(el, "::before").height +
								" after:" + getComputedStyle(el, "::after").content + "/" + getComputedStyle(el, "::after").height +
								" foldKidsH" + (fold ? [...fold.children].map((c) => c.offsetHeight + "@" + c.offsetTop).join(",") : "") + "}"
							: "";
						return who + ":" + el.offsetHeight + tall;
					})
					.join(" "),
				// The folded body of each run: what its style says, what it measures, whether it is open.
				groups: [...main.querySelectorAll("[data-ly-run]")]
					.map((el) => {
						const button = el.firstElementChild;
						const fold = el.lastElementChild;
						const parts = [...el.children].map((c) => c.tagName.toLowerCase() + c.offsetHeight + (c === button ? "[" + [...c.children].map((g) => g.tagName.toLowerCase() + g.offsetHeight + "x" + g.offsetWidth).join(",") + "]" : ""));
						return (button ? button.getAttribute("aria-expanded") : "?") + "/" + (fold ? fold.style.height + "/" + fold.offsetHeight + "/" + fold.scrollHeight : "?") + " 子元素 " + parts.join(" ");
					})
					.join(" "),
			};
		};
		const tick = () => {
			const now = read();
			if (!last || now.thinking !== last.thinking || now.y !== last.y || now.cards !== last.cards) {
				log.push(now);
				last = now;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		window.__jumpLog = log;
		return true;
	})()`);
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, "看看这个项目");
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	})()`);

	const started = Date.now();
	const samples: Sample[] = [];
	let seenRunning = false;
	let shotTaken = false;
	while (Date.now() - started < 25_000) {
		const reading = await app.evaluate<Omit<Sample, "t">>(READ);
		samples.push({ t: Date.now() - started, ...reading });
		if (reading.running) seenRunning = true;
		// One picture from the middle of the turn, with a run above and reasoning below it.
		if (!shotTaken && reading.thinking > 0 && reading.rows > 1) {
			const png = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
			await writeFile(join(OUT, "05-run-with-reasoning.png"), Buffer.from(png.data, "base64"));
			shotTaken = true;
		}
		if (reading.answered) break;
		await settle(50);
	}

	// From the first reasoning on: the transcript settling around the sent message is not the question.
	const log = await app.evaluate<{ t: number; thinking: number; cards: number; runs: number; y: number | null; h: string; groups: string }[]>(`window.__jumpLog`);
	// From a beat after the turn starts: the transcript settling around the sent message is not the question.
	const t0 = (log.find((e) => e.y !== null)?.t ?? 0) + 400;
	const events = log.filter((e) => e.t >= t0).map((e) => ({ ...e, t: e.t - t0 }));
	const ys = events.filter((e) => e.y !== null).map((e) => ({ ...e, y: e.y as number }));
	/** Every time the line moved up between two readings, by how much, and what changed around it. */
	const ups = ys
		.slice(1)
		.map((s, i) => ({ t: s.t, by: ys[i].y - s.y, before: ys[i], after: s }))
		.filter((u) => u.by > 2);
	const path = ys
		.filter((s, i) => i === 0 || s.y !== ys[i - 1].y)
		.map((s) => `${s.y}@${(s.t / 1000).toFixed(1)}s`)
		.join(" → ");
	check("整个回合跑完了", seenRunning && samples[samples.length - 1].answered, `${samples.length} 个样本，${(samples[samples.length - 1].t / 1000).toFixed(1)}s`);
	check(
		"转录只往下长，底下的行从不往上跳",
		ups.length === 0,
		`上跳 ${ups.length} 次${ups.length ? `：${ups.map((u) => `${(u.t / 1000).toFixed(1)}s ↑${u.by}px 卡片${u.before.cards}→${u.after.cards} 思考行${u.before.thinking}→${u.after.thinking} 之前[${u.before.h} | 组 ${u.before.groups}] 之后[${u.after.h} | 组 ${u.after.groups}]`).join("；")}` : ""}；轨迹 ${path}`,
	);
	const thinking = events.map((e) => e.thinking);
	check(
		"思考行一旦出现就不会再消失（直到回合结束）",
		thinking.every((n, i) => i === 0 || n >= Math.min(1, thinking[i - 1])),
		`思考行数序列 ${thinking.filter((n, i) => i === 0 || n !== thinking[i - 1]).join(" → ")}`,
	);
} finally {
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}

process.stdout.write(`\n${failures === 0 ? "全部通过" : `${failures} 项未通过`}\n`);
process.exit(failures === 0 ? 0 : 1);
