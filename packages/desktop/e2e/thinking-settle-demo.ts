/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 思考行什么时候算写完、每一句在行上留多久。边验边录。
 *
 * 假模型是本地的 Anthropic 流式接口，一轮里依次是：
 *   - 一段推理，接着说一句话，再跑一条要六秒的命令——推理早写完了，这一轮还在跑；
 *   - 六段又短又快的推理，每段一句，各跟一次很快的 `ls`；
 *   - 收尾的一句话。
 * 要看的是：
 *   - 命令跑着的时候，第一段推理的行已经收起（不再顶着渐隐写、摘要是第一句）；
 *   - 短推理的每一行都把自己那句写完、停够了才收，不被下一条回复一刀切断。
 *
 * 用法：pnpm build 之后 node --experimental-strip-types e2e/thinking-settle-demo.ts [输出目录]
 * 输出目录默认是桌面上的「Plume思考行收尾测试」；`PLUME_TAKE` 给文件名加个后缀，用来区分改前改后。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume思考行收尾测试");
const TAKE = process.env.PLUME_TAKE ? `_${process.env.PLUME_TAKE}` : "";
const PORT = 9771;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PANE = '[data-dock-pane="conversation"]';
const FIRST_LINE = "先把要改的地方列出来，再派一条命令去跑测试。";
const SHORT = ["看 a.ts 的导出", "b.ts 没有引用它", "再看 c.ts", "c.ts 里改过名", "确认 d.ts 没用到", "可以收尾了"];

interface Step {
	thinking: string;
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
	/** 第一个 token 之前的等待。短推理连成串的情形就是这里很短。 */
	latency: number;
}

const STEPS: Step[] = [
	{
		thinking: `${FIRST_LINE}\n测试要跑一会儿，跑的时候这段推理已经写完了。`,
		text: "我先跑一遍测试，大概要几秒。",
		tool: { name: "bash", args: { command: "sleep 6 && echo done", description: "跑测试" } },
		latency: 500,
	},
	...SHORT.map((thinking) => ({ thinking, tool: { name: "ls", args: { path: "." } }, latency: 120 })),
	// 收尾慢一点：一轮结束时整段过程收成一行，最后那条短推理的停留要在那之前量完。
	{ thinking: "都看完了。", text: "改完了：`a.ts` 的导出只在 `c.ts` 里用到，已经一起改名。", latency: 1500 },
];

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function stream(res: ServerResponse, index: number, kind: "thinking" | "text", value: string): Promise<void> {
	for (let at = 0; at < value.length; at += 3) {
		const slice = value.slice(at, at + 3);
		const delta = kind === "thinking" ? { type: "thinking_delta", thinking: slice } : { type: "text_delta", text: slice };
		sse(res, { type: "content_block_delta", index, delta } as never);
		await pause(25);
	}
}

function startModel(): Server {
	return createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", async () => {
			// 走到第几步，数的是这一轮自己的工具结果：会话里本来就有别的回复，按回复数会一上来就跳到末尾。
			const at = body.match(/"tool_use_id":"settle_\d+"/g)?.length ?? 0;
			const step = STEPS[Math.min(at, STEPS.length - 1)];
			await pause(step.latency);
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, { type: "message_start", message: { id: `msg_${at}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } } as never);
			let index = 0;
			sse(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } } as never);
			await stream(res, index, "thinking", step.thinking);
			sse(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } } as never);
			sse(res, { type: "content_block_stop", index } as never);
			index++;
			if (step.text) {
				sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } } as never);
				await stream(res, index, "text", step.text);
				sse(res, { type: "content_block_stop", index } as never);
				index++;
			}
			if (step.tool) {
				sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `settle_${at}`, name: step.tool.name, input: {} } } as never);
				sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.args) } } as never);
				sse(res, { type: "content_block_stop", index } as never);
			}
			sse(res, { type: "message_delta", delta: { stop_reason: step.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 40 } } as never);
			sse(res, { type: "message_stop" } as never);
			res.end();
		});
	});
}

/**
 * 每一帧记下每条思考行的摘要和它是不是还在跟着写。量的是看得见的东西：行上的字、那个属性。
 */
const SAMPLER = `(() => {
	const samples = [];
	window.__thinkSamples = samples;
	const tick = () => {
		const rows = [...document.querySelectorAll(${JSON.stringify(`${PANE} [data-ly-thinking]`)})];
		samples.push([Math.round(performance.now()), rows.map((r) => [r.querySelector(".ly-flow-summary")?.textContent ?? "", !!r.querySelector("[data-follow-end]")])]);
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
})()`;

type Sample = [number, [string, boolean][]];

/** 一条行从出现到收起：最后跟着写的那一句是什么、整句在行上停了多久。 */
function follow(samples: Sample[], row: number): { last: string; held: number; settled: string } {
	const track = samples.filter(([, rows]) => rows[row]).map(([t, rows]) => [t, ...rows[row]] as const);
	const live = track.filter(([, , following]) => following);
	const last = live.length > 0 ? live[live.length - 1][1] : "";
	const since = live.find(([, text]) => text === last)?.[0] ?? 0;
	const until = live.length > 0 ? live[live.length - 1][0] : 0;
	return { last, held: until - since, settled: track.length > 0 ? track[track.length - 1][1] : "" };
}

let app: RunningApp;
let shotNo = 0;
async function screenshot(name: string): Promise<void> {
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shotNo++;
	await writeFile(join(OUT_DIR, `${STAMP}${TAKE}_${String(shotNo).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const model = startModel();
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("假模型没起来");
	const frames: Frame[] = [];
	try {
		app = await startApp({
			port: PORT,
			seed: async (home) => {
				await seedInteractions(home, address.port);
				const path = join(home, "settings.json");
				const settings = JSON.parse(await readFile(path, "utf8"));
				for (const provider of settings.providers) for (const model of provider.models) model.supportsThinking = true;
				// 「展开」排法：跑着的那一轮整段摊开，思考行一直在画面里。
				await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "medium", appearance: { ...settings.appearance, callChain: "expanded" } }));
			},
		});
		await app.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
		const stop = await startRecording(PORT, frames);

		console.log("一、推理之后说了一句、跑一条六秒的命令");
		await openSession(app, "qa-short");
		await pause(800);
		await app.evaluate(SAMPLER);
		await type(app, `${PANE} textarea`, "把 a.ts 的导出改个名");
		await pause(400);
		await press(app, "Enter", 13);

		// 命令开始跑之后再等四秒：推理早就写完了，这一轮还在跑。
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.innerText.includes("大概要几秒")`, 1200).catch(async (error) => {
			await screenshot("没等到");
			console.log(await app.evaluate<string>(`document.querySelector(${JSON.stringify(PANE)})?.innerText.slice(-600)`));
			throw error;
		});
		await pause(4000);
		const first = await app.evaluate<[string, boolean] | null>(`(() => {
			const row = document.querySelector(${JSON.stringify(`${PANE} [data-ly-thinking]`)});
			return row ? [row.querySelector(".ly-flow-summary")?.textContent ?? "", !!row.querySelector("[data-follow-end]")] : null;
		})()`);
		const running = await app.evaluate<boolean>(`!!document.querySelector('[data-composer-send="stop"]')`);
		await screenshot("命令跑着时的第一段推理");
		check("命令还在跑", running, String(running));
		check("这时第一段推理已经收起，不再跟着写", first?.[1] === false, JSON.stringify(first));
		check("收起后的摘要是它的第一句", first?.[0] === FIRST_LINE, JSON.stringify(first?.[0]));

		console.log("二、六段又短又快的推理");
		await until(app, `document.querySelector(${JSON.stringify(PANE)})?.innerText.includes("已经一起改名")`, 2400);
		await pause(3000);
		await screenshot("一轮跑完");

		const samples = await app.evaluate<Sample[]>("window.__thinkSamples");
		for (const [n, line] of SHORT.entries()) {
			const { last, held, settled } = follow(samples, n + 1);
			console.log(`   第 ${n + 2} 行：跟着写到「${last}」，整句停了 ${held}ms，收起后是「${settled}」`);
			check(`第 ${n + 2} 行写完了自己那一句才收`, last === line, last);
			check(`第 ${n + 2} 行那一句在行上停够一秒`, held >= 1000, `${held}ms`);
		}
		await pause(800);
		await stop();
	} finally {
		await app?.stop().catch(() => {});
		await new Promise<void>((resolve) => model.close(() => resolve()));
	}
	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}${TAKE}_思考行收尾_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过 → ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
