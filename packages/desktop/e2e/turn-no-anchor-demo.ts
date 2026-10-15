/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 有过程的一轮没有「已工作」的锚，也不整轮收起：过程一行行摊着，跑完也是。
 *
 * `node --experimental-strip-types e2e/turn-no-anchor-demo.ts [输出目录]`，先 `pnpm build`。
 *
 * 锚试过三种挂法：跑着就挂（没调工具的一轮也顶着一行）、开口调工具才挂（突然冒出来，一出来就是几十秒）、
 * 跑完才长出来并把过程收进去（一整段内容在眼前塌掉），都不对，删掉了。这里用一个本地脚本模型跑三轮，
 * 逐帧记下有没有锚、几句话在不在、是不是一直是同一个元素：
 *
 * - 想 3 秒 → 说「我先看一下项目里的文件。」→ 读文件 → 再想一下 → 回答。
 * - 想 2.5 秒 → 回答「在的。」，不调工具。
 * - 不把推理流出来（经代理的 GPT）：沉默 2.5 秒 → 直接说「我直接读一下。」并读文件 → 回答。
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
const DIRECT = "我直接读一下。";
const DIRECT_ANSWER = "就一个文件。";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw: string): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

/** `silentMs`：开始流之前沉默多久——不流推理的模型想的那段时间就是这样。 */
type Step = { thinkMs: number; silentMs?: number; text?: string; tool?: { name: string; args: Record<string, unknown> } };

function sse(res: ServerResponse, payload: unknown): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/** 按请求内容挑回复，不按次数：标题生成这类旁路请求也会打到同一个模型上。 */
function pick(body: string): Step {
	const request = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
	// 末尾可能跟着一条 `<env>` 环境信息，跳过它找真正的最后一条。
	const last = request.messages?.findLast((message) => !JSON.stringify(message.content).includes("<env>"));
	const content = JSON.stringify(last?.content ?? "");
	if (content.includes("tool_result")) return JSON.stringify(request.messages).includes("直接看") ? { thinkMs: 0, text: DIRECT_ANSWER } : { thinkMs: 1000, text: ANSWER };
	if (content.includes("直接看")) return { thinkMs: 0, silentMs: 2500, text: DIRECT, tool: { name: "read", args: { path: "one.ts" } } };
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
			await pause(step.silentMs ?? 400);
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
 * 每一帧记一次，变了才留：锚有几颗、说的什么，三句话在不在、是不是还是第一次见到的那个元素。
 *
 * 「是不是那个元素」靠记下第一次见到的节点、之后问它 `isConnected`：React 卸掉重建会换一个节点，
 * 而那一下在画面上就是闪一次。
 */
const WATCH = `(() => {
	const main = document.querySelector("main");
	const find = (text) => document.evaluate("//main//*[contains(text(), " + JSON.stringify(text) + ")]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
	const texts = { first: ${JSON.stringify(FIRST)}, short: ${JSON.stringify(SHORT)}, direct: ${JSON.stringify(DIRECT)} };
	const seen = {};
	const log = [];
	let last = "";
	const tick = () => {
		// 认得出的锚：旧类名，或者整轮那一行的读屏名「本轮过程」。
		const anchors = [...main.querySelectorAll('button.ly-turn-anchor, button[aria-label="本轮过程"]')];
		const now = {
			anchors: anchors.length,
			label: anchors.map((a) => a.innerText.trim()).join(" | "),
			// 停止键在就是还在跑。不读 \`[data-ly-running]\`：它在收起的那一行里会多留一会儿（见 \`RunningRow\`）。
			running: Boolean(document.querySelector('main button[aria-label="停止"]')),
			answered: main.innerText.includes(${JSON.stringify(ANSWER)}),
			directAnswered: main.innerText.includes(${JSON.stringify(DIRECT_ANSWER)}),
		};
		for (const [name, text] of Object.entries(texts)) {
			const node = find(text);
			if (node && !seen[name]) seen[name] = node;
			now[name] = Boolean(node);
			now[name + "Same"] = seen[name] ? seen[name].isConnected : null;
		}
		const key = JSON.stringify(now);
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

type Entry = {
	t: number; anchors: number; label: string; running: boolean; answered: boolean; directAnswered: boolean;
	first: boolean; firstSame: boolean | null; short: boolean; shortSame: boolean | null; direct: boolean; directSame: boolean | null;
};

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
	const state = await app.evaluate<string>(`JSON.stringify({ anchors: document.querySelectorAll("main button.ly-turn-anchor").length, stop: Boolean(document.querySelector('main button[aria-label="停止"]')), text: document.querySelector("main").innerText.slice(-300) })`);
	throw new Error(`等不到：${expression}\n${state}`);
};

try {
	await until(app, `document.querySelector("main textarea")`);
	await app.evaluate(WATCH);
	const stop = await startRecording(PORT, frames);
	await pause(800);

	const STOPPED = `!document.querySelector('main button[aria-label="停止"]')`;
	const shows = (text: string) => `document.querySelector("main").innerText.includes(${JSON.stringify(text)})`;

	console.log("\n第一轮：想 → 说第一句 → 读文件 → 回答");
	const sent = await app.evaluate<number>("performance.now()");
	await type(app, "main textarea", "看看这个项目");
	await press(app, "Enter", 13);
	await pause(1500);
	await shoot("01_还在想");
	await wait(shows(FIRST));
	await pause(300);
	await shoot("02_说了第一句");
	await wait(`${shows(ANSWER)} && ${STOPPED}`, 60000);
	await pause(1200);
	await shoot("03_第一轮跑完_过程照样摊着");

	console.log("\n第二轮：只想不做");
	const sent2 = await app.evaluate<number>("performance.now()");
	await type(app, "main textarea", "在吗");
	await press(app, "Enter", 13);
	await pause(1500);
	await shoot("04_第二轮在想");
	await wait(`${shows(SHORT)} && ${STOPPED}`);
	await pause(1500);
	await shoot("05_第二轮跑完");

	console.log("\n第三轮：不流推理，沉默后直接开口调工具");
	const sent3 = await app.evaluate<number>("performance.now()");
	await type(app, "main textarea", "直接看");
	await press(app, "Enter", 13);
	await pause(1500);
	await shoot("06_第三轮沉默中");
	await wait(shows(DIRECT));
	await wait(`${shows(DIRECT_ANSWER)} && ${STOPPED}`, 30000);
	await pause(1500);
	await shoot("07_第三轮跑完_过程照样摊着");
	await stop();

	const log = (await app.evaluate<Entry[]>("window.__anchorLog")).filter((e) => e.t >= sent);
	const at = (e: Entry | undefined, from: number) => (e ? `${((e.t - from) / 1000).toFixed(2)}s` : "从未");
	const turn = (from: number, to = Infinity) => log.filter((e) => e.t >= from && e.t < to);
	const kinds = (list: Entry[], pick: (e: Entry) => unknown) => [...new Set(list.map((e) => String(pick(e))))].join("→");

	check("三轮里从头到尾没有一帧出现锚", log.every((e) => e.anchors === 0), `锚数 ${kinds(log, (e) => e.anchors)}`);

	const turn1 = turn(sent, sent2);
	const done1 = turn1.find((e) => !e.running && e.answered);
	check("第一轮：第一句话从出现到跑完以后都是同一个元素", turn1.filter((e) => e.first).every((e) => e.firstSame === true), `firstSame ${kinds(turn1.filter((e) => e.first), (e) => e.firstSame)}`);
	const settled1 = turn1.at(-1);
	check("第一轮跑完，过程照样摊着、回答在最后", Boolean(done1 && settled1?.first && settled1.answered), `跑完 ${at(done1, sent)}；最后一帧：第一句话${settled1?.first ? "在" : "不在"}，回答${settled1?.answered ? "在" : "不在"}`);

	const turn2 = turn(sent2, sent3);
	check("第二轮那句回答从出现到跑完都是同一个元素", turn2.some((e) => e.short) && turn2.filter((e) => e.short).every((e) => e.shortSame === true), `shortSame ${kinds(turn2.filter((e) => e.short), (e) => e.shortSame)}`);

	const turn3 = turn(sent3);
	check("不流推理：第一句话从开口到跑完以后都是同一个元素", turn3.filter((e) => e.direct).every((e) => e.directSame === true), `directSame ${kinds(turn3.filter((e) => e.direct), (e) => e.directSame)}`);
	const last = turn3.at(-1);
	check("不流推理：跑完过程照样摊着、回答在最后", Boolean(last && last.direct && last.directAnswered && !last.running), `最后一帧：第一句话${last?.direct ? "在" : "不在"}，回答${last?.directAnswered ? "在" : "不在"}`);

	console.log("\n逐帧变化：");
	for (const e of log) console.log(`   ${at(e, sent)}  锚${e.anchors} 跑着${e.running ? "✓" : "·"} 第一句=${e.firstSame} 在的=${e.shortSame} 直接读=${e.directSame}`);

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames, join(OUT_DIR, `${STAMP}_没有锚_过程摊开_${passed}of${checks.length}.mp4`), 30, 1200);
	console.log(`\n${passed}/${checks.length} 通过，产物在 ${OUT_DIR}`);
	process.exitCode = passed === checks.length ? 0 : 1;
} finally {
	await app.stop();
	await new Promise((resolve) => model.close(() => resolve(null)));
}
