/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 推理不画时，「已工作」的锚什么时候出现。
 *
 * `node --experimental-strip-types e2e/turn-anchor-thinking-demo.ts [输出目录]`，先 `pnpm build`。
 *
 * 报的现象：发出消息后锚不在，模型想了半分钟、说出第一句话、调了第一次工具，「已工作 39 秒」才在那句话
 * 上面冒出来。这里用一个本地脚本模型跑两轮，逐帧记下锚和第一句话：
 *
 * - 想 3 秒 → 说「我先看一下项目里的文件。」→ 读文件 → 再想一下 → 回答。锚要在第一句话之前就在，
 *   而且从出现到这一轮跑完是同一个元素；第一句话出现以后也不再被重挂。
 * - 想 2.5 秒 → 回答「在的。」，不调工具。想的时候有锚，跑完退回一句回答。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { press, type, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const MODEL_PORT = 9581;
const PORT = 9472;
const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume已工作锚测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const FIRST = "我先看一下项目里的文件。";
const ANSWER = "项目只有一个文件，导出常量 one。";
const SHORT = "在的。";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

type Step = { thinkMs: number; text?: string; tool?: { name: string; args: Record<string, unknown> } };

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 按请求内容挑回复，不按次数：标题生成这类旁路请求也会打到同一个模型上。 */
function pick(body: string): Step {
	const request = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
	// 末尾可能跟着一条 `<env>` 环境信息，跳过它找真正的最后一条。
	const last = request.messages?.findLast((message) => !JSON.stringify(message.content).includes("<env>"));
	const content = JSON.stringify(last?.content ?? "");
	if (content.includes("tool_result")) return { thinkMs: 1000, text: ANSWER };
	if (content.includes("在吗")) return { thinkMs: 2500, text: SHORT };
	if (content.includes("看看这个项目")) return { thinkMs: 3000, text: FIRST, tool: { name: "read", args: { path: "one.ts" } } };
	return { thinkMs: 0, text: "演示" };
}

function startModel(): Server {
	let id = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString()));
		req.on("end", async () => {
			const step = pick(body);
			const n = id++;
			await pause(400);
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${n}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			let index = 0;
			if (step.thinkMs > 0) {
				sse(res, { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
				for (let at = 0; at < step.thinkMs; at += 100) {
					sse(res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "想。" } });
					await pause(100);
				}
				sse(res, { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
				sse(res, { type: "content_block_stop", index: index++ });
			}
			if (step.text) {
				sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
				for (const char of step.text) {
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: char } });
					await pause(80);
				}
				sse(res, { type: "content_block_stop", index: index++ });
			}
			if (step.tool) {
				await pause(800);
				sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${n}`, name: step.tool.name, input: {} } });
				sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.tool.args) } });
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: step.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 30 } });
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
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1100, height: 760, x: 0, y: 0 }));
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
					models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: true, supportsImages: false, supportsTools: true }],
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
			appearance: { theme: "light" },
		}),
	);
}

/**
 * 每一帧记一次，变了才留：锚有几颗、第一颗是不是还是那个元素、第一句话在不在、是不是还是那个元素。
 *
 * 「是不是那个元素」靠记下第一次见到的节点、之后问它 `isConnected`：React 卸掉重建会换一个节点，
 * 而那一下在画面上就是闪一次。
 */
const WATCH = `(() => {
	const main = document.querySelector("main");
	const find = (text) => document.evaluate("//main//*[contains(text(), " + JSON.stringify(text) + ")]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
	const log = [];
	const seen = { anchor: null, sentence: null };
	let last = "";
	const tick = () => {
		const anchors = [...main.querySelectorAll("button.ly-turn-anchor")];
		const sentence = find(${JSON.stringify(FIRST)});
		if (anchors[0] && !seen.anchor) seen.anchor = anchors[0];
		if (sentence && !seen.sentence) seen.sentence = sentence;
		const now = {
			anchors: anchors.length,
			label: anchors.map((a) => a.innerText.trim()).join(" | "),
			sentence: Boolean(sentence),
			anchorSame: seen.anchor ? seen.anchor.isConnected : null,
			sentenceSame: seen.sentence ? seen.sentence.isConnected : null,
			// 停止键在就是还在跑。不读 \`[data-ly-running]\`：它在收起的那一行里会多留一会儿（见 \`RunningRow\`）。
			running: Boolean(document.querySelector('main button[aria-label="停止"]')),
			answered: main.innerText.includes(${JSON.stringify(ANSWER)}),
			short: main.innerText.includes(${JSON.stringify(SHORT)}),
		};
		const key = JSON.stringify({ ...now, label: now.label.replace(/\\d+/g, "#") });
		if (key !== last) {
			log.push({ t: Math.round(performance.now()), ...now });
			last = key;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	window.__anchorLog = log;
	return true;
})()`;

type Entry = { t: number; anchors: number; label: string; sentence: boolean; anchorSame: boolean | null; sentenceSame: boolean | null; running: boolean; answered: boolean; short: boolean };

await mkdir(OUT_DIR, { recursive: true });
const model = startModel();
const app = await startApp({ port: PORT, seed });
const frames: Frame[] = [];
const shoot = async (name: string) => {
	const png = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(png.data, "base64"));
};
const wait = async (expression: string, ms = 20000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`)) return;
		await pause(50);
	}
	const state = await app.evaluate<string>(`JSON.stringify({ anchors: [...document.querySelectorAll("main button.ly-turn-anchor")].map((e) => e.disabled), stop: Boolean(document.querySelector('main button[aria-label="停止"]')), text: document.querySelector("main").innerText.slice(-300) })`);
	throw new Error(`等不到：${expression}\n${state}`);
};

try {
	await until(app, `document.querySelector("main textarea")`);
	await app.evaluate(WATCH);
	const stop = await startRecording(PORT, frames);
	await pause(800);

	console.log("\n第一轮：想 → 说第一句 → 读文件 → 回答");
	const sent = await app.evaluate<number>("performance.now()");
	await type(app, "main textarea", "看看这个项目");
	await press(app, "Enter", 13);
	await wait(`document.querySelector("main button.ly-turn-anchor")`, 3000).catch(() => {});
	await pause(900);
	await shoot("01_还在想_锚已经在");
	await wait(`document.querySelector("main").innerText.includes(${JSON.stringify(FIRST)})`);
	await pause(300);
	await shoot("02_说了第一句");
	await wait(`document.querySelector("main").innerText.includes(${JSON.stringify(ANSWER)}) && !document.querySelector('main button[aria-label="停止"]')`, 60000);
	await pause(1200);
	await shoot("03_第一轮跑完");

	console.log("\n第二轮：只想不做");
	await type(app, "main textarea", "在吗");
	await press(app, "Enter", 13);
	await wait(`document.querySelectorAll("main button.ly-turn-anchor").length === 2`, 3000).catch(() => {});
	await pause(900);
	await shoot("04_第二轮在想_锚已经在");
	await wait(`document.querySelector("main").innerText.includes(${JSON.stringify(SHORT)}) && !document.querySelector('main button[aria-label="停止"]')`);
	await pause(1500);
	await shoot("05_第二轮跑完_锚退掉");
	await stop();

	const log = await app.evaluate<Entry[]>("window.__anchorLog");
	const t = (e: Entry | undefined) => (e ? `${((e.t - sent) / 1000).toFixed(2)}s` : "从未");
	const turn1 = log.filter((e) => !e.short && e.t >= sent);
	const anchorAt = turn1.find((e) => e.anchors >= 1);
	const sentenceAt = turn1.find((e) => e.sentence);
	const done1 = turn1.find((e) => e.answered && !e.running);
	check("锚在模型开口之前就在", Boolean(anchorAt && sentenceAt && anchorAt.t < sentenceAt.t), `锚 ${t(anchorAt)}，第一句话 ${t(sentenceAt)}`);
	check("锚在开始想的那一下出现（模型 0.4s 后开始想）", Boolean(anchorAt && anchorAt.t - sent < 1500), `发出后 ${t(anchorAt)}`);
	check("出现时说的是刚开始的时长，不是一个大数", Boolean(anchorAt && /^(已工作|已工作 [01] 秒)/.test(anchorAt.label)), `「${anchorAt?.label}」`);
	const upToDone1 = turn1.filter((e) => !done1 || e.t <= done1.t);
	check("第一轮里锚一直是同一个元素（开口、调工具、跑完都没重挂）", upToDone1.every((e) => e.anchorSame !== false), `anchorSame 序列 ${[...new Set(upToDone1.map((e) => String(e.anchorSame)))].join("→")}`);
	check("第一句话出现以后没有被重挂", upToDone1.filter((e) => e.sentence).every((e) => e.sentenceSame === true), `sentenceSame 序列 ${[...new Set(upToDone1.filter((e) => e.sentence).map((e) => String(e.sentenceSame)))].join("→")}`);
	check("第一轮跑完，锚停在「已工作 N 秒」", Boolean(done1 && /^已工作 \d+ 秒/.test(done1.label)), `「${done1?.label}」`);

	const turn2 = log.filter((e) => done1 && e.t > done1.t);
	const thinking2 = turn2.find((e) => e.anchors === 2 && !e.short);
	const final = log.at(-1);
	check("第二轮在想时也有锚", Boolean(thinking2), `第二轮第一次两颗锚 ${thinking2 ? `${((thinking2.t - (done1?.t ?? 0)) / 1000).toFixed(2)}s（相对第一轮跑完）` : "从未"}`);
	check("第二轮只想不做，跑完锚退掉、只剩一句回答", Boolean(final && final.short && !final.running && final.anchors === 1), `最后：${final?.anchors} 颗锚，「${final?.label}」`);
	check("第一轮的锚始终是同一个元素", log.every((e) => e.anchorSame !== false), `anchorSame 曾为 false：${log.some((e) => e.anchorSame === false)}`);

	console.log("\n逐帧变化：");
	for (const e of log.filter((x) => x.t >= sent)) console.log(`   ${t(e)}  锚${e.anchors} 「${e.label}」 第一句${e.sentence ? "✓" : "·"} 跑着${e.running ? "✓" : "·"} 锚同一个=${e.anchorSame} 句同一个=${e.sentenceSame}`);

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_已工作锚随推理出现_${passed}of${checks.length}.mp4`), 30, 1200);
	console.log(`\n${passed}/${checks.length} 通过，产物在 ${OUT_DIR}`);
	process.exitCode = passed === checks.length ? 0 : 1;
} finally {
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}
