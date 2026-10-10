/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 预览里的按钮替人说话（`plume.send`）——在真窗口里边验边录。
 *
 * agent 用 `preview` 放出一个选方案的小界面：两个方案按钮、一个一次点击里连发两次的按钮；页面加载时
 * 和两秒后的定时器里也各偷偷调一次 `plume.send`。量四件事：
 * - 加载、定时器发不出去，只有人按下去的才算；
 * - agent 还在跑的时候按，话进输入框上方的队列，这一轮结束后自己发出去；
 * - 空着的时候按，直接发，模型收到的就是按钮给的那句话；
 * - 一次点击里连调两次，只发一句。
 *
 * 要发的句子在页面源码里是拼出来的（`"选了"+"方案 B"`），对话里出现整句只可能是按钮真的发了。
 * 模型是本地一台假服务器，按用户消息里的暗号回固定的工具调用，把听到的话记下来给断言看。
 *
 * 用法：node --experimental-strip-types e2e/preview-send-demo.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { clickInFrame, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume预览回话测试");
const PORT = 9853;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "preview-send";
const FRAME = "main [data-ly-preview] iframe";
/** 页面里三个按钮的中心，相对 iframe 左上角：20px 内衬、按钮宽 120/120/160、间距 40。 */
const BUTTON = { a: { x: 80, y: 40 }, b: { x: 240, y: 40 }, twice: { x: 420, y: 40 } };
const PICKER = `<!doctype html><html><head><meta charset="utf-8"><title>选方案</title>
<style>body{margin:0;padding:20px;font:14px var(--font-sans)}.row{display:flex;gap:40px}button{height:40px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--foreground);font:inherit}
#a,#b{width:120px}#twice{width:160px}#out{margin:20px 0 0;color:var(--muted-foreground)}</style></head>
<body><div class="row"><button id="a">方案 A</button><button id="b">方案 B</button><button id="twice">一次点击发两次</button></div><p id="out"></p>
<script>
var out=document.getElementById("out");
function say(t){out.textContent="plume.send → "+plume.send(t);}
document.getElementById("a").onclick=function(){say("选了"+"方案 A，5 人");};
document.getElementById("b").onclick=function(){say("选了"+"方案 B，12 人，按年付");};
document.getElementById("twice").onclick=function(){say("连"+"发第一句");say("连"+"发第二句");};
plume.send("偷"+"偷发：加载时");
setTimeout(function(){plume.send("偷"+"偷发：定时器");},2000);
</script></body></html>`;

/** 模型听到的每一句人话（工具结果和环境信息不算），按到达顺序。 */
const heard: string[] = [];
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
			// 环境信息会跟在人说的话后面另起一条，暗号要从它前面那条找。
			const last = messages.map((message) => JSON.stringify(message.content)).findLast((content) => !content.includes("<env>")) ?? "";
			if (last.includes("tool_result")) {
				// 页面已经在对话里了，回复却还要一会儿：这段时间按下去的，应该排进队列。
				setTimeout(() => reply(res, { text: "好了，选一个吧。" }), 6000);
				return;
			}
			const said = /选了[^"\\]*|连发[^"\\]*|偷偷发[^"\\]*/.exec(last)?.[0];
			if (said) { heard.push(said); return reply(res, { text: `收到：${said}` }); }
			if (last.includes("MAKE_PICKER")) return reply(res, { tool: { id: "preview-1", name: "preview", input: { html: PICKER, title: "选方案" } } });
			reply(res, { text: "嗯。" });
		});
	});
}

function reply(res: ServerResponse, what: { text?: string; tool?: { id: string; name: string; input: object } }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	let index = 0;
	if (what.text) {
		emit("content_block_start", { index, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index, delta: { type: "text_delta", text: what.text } });
		emit("content_block_stop", { index: index++ });
	}
	if (what.tool) {
		emit("content_block_start", { index, content_block: { type: "tool_use", id: what.tool.id, name: what.tool.name, input: {} } });
		emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(what.tool.input) } });
		emit("content_block_stop", { index });
	}
	emit("message_delta", { delta: { stop_reason: what.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "选方案", cwd, projectId, projectName: "预览回话", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "团队要买个套餐。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "有两个方案，我做个小界面给你选。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "预览回话", pinned: true, lastOpenedAt: 1 }],
	}));
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
/** 转录里人说的话里有几句含 `text`——iframe 是另一个源，它里面的字不在 `innerText` 里。 */
const spoken = (app: RunningApp, text: string) => app.evaluate<number>(`document.querySelector("main").innerText.split(${JSON.stringify(text)}).length - 1`);
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);
async function type(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector("main textarea");const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector("main textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-preview-send-"));
await seed(home, modelAddress.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);

	console.log("\n一、agent 放出一个选方案的界面；页面加载时、两秒后各偷偷调一次 plume.send");
	await type(app, "MAKE_PICKER 给我两个方案选");
	await until(app, `document.querySelector(${JSON.stringify(FRAME)})`, 1800);
	// 等过定时器那一下（两秒），再动手：之前没人按过，它不该发出去。
	await pause(3000);
	// 注入脚本里多了 `plume`，量高度的那一段还得照常跑：卡片贴着 120px 的页面，而不是停在测不到时的默认高度。
	const height = await app.evaluate<number>(`Math.round(document.querySelector("main [data-ly-preview]").getBoundingClientRect().height)`);
	check("卡片高度量到了页面（不是测不到时的默认 440）", height < 200, height);
	check("页面加载时、定时器里调的 plume.send 都没发出去", (await spoken(app, "偷偷发")) === 0 && !heard.some((text) => text.startsWith("偷偷")), heard);
	await shot(app, "01_界面出来了");

	console.log("\n二、agent 还在跑的时候按「方案 A」：进队列，这一轮完了自己发出去");
	const running = await app.evaluate<boolean>(`!!document.querySelector('button[aria-label="停止"]')`);
	await clickInFrame(app, FRAME, BUTTON.a);
	await until(app, `[...document.querySelectorAll('[data-queue-row]')].some((row) => row.textContent.includes("选了方案 A"))`, 300).catch(() => {});
	const queued = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-queue-row]')].map((row) => row.textContent)`);
	check("按的时候这一轮还没完", running, "");
	check("这句话排在输入框上方，没有插进这一轮", queued.some((text) => text.includes("选了方案 A，5 人")) && !heard.includes("选了方案 A，5 人"), queued);
	await shot(app, "02_跑着的时候按进了队列");
	await until(app, `document.querySelector("main").innerText.includes("收到：选了方案 A")`, 1200);
	await idle(app);
	check("这一轮结束后它自己发了出去，模型听到的就是按钮给的那句", heard.filter((text) => text === "选了方案 A，5 人").length === 1, heard);

	console.log("\n三、空着的时候按「方案 B」：直接发");
	await pause(1600);
	await clickInFrame(app, FRAME, BUTTON.b);
	await until(app, `document.querySelector("main").innerText.includes("收到：选了方案 B")`, 900);
	await idle(app);
	check("对话里多了一条人说的话：选了方案 B，12 人，按年付", (await spoken(app, "选了方案 B，12 人，按年付")) >= 1, await spoken(app, "选了方案 B，12 人，按年付"));
	check("模型听到一次，原话", heard.filter((text) => text === "选了方案 B，12 人，按年付").length === 1, heard);
	await app.evaluate(`document.querySelector("main [data-ly-preview]").scrollIntoView({ block: "start" })`);
	await pause(1000);
	await shot(app, "03_空着的时候直接发");

	console.log("\n四、一次点击里连调两次：只发第一句");
	await pause(1600);
	await clickInFrame(app, FRAME, BUTTON.twice);
	await until(app, `document.querySelector("main").innerText.includes("收到：连发")`, 900);
	await idle(app);
	await pause(2000);
	const twice = heard.filter((text) => text.startsWith("连发"));
	check("模型只听到一句，是第一句", twice.length === 1 && twice[0] === "连发第一句", twice);
	check("从头到尾，偷偷发的一句也没出去", !heard.some((text) => text.startsWith("偷偷")) && (await spoken(app, "偷偷发")) === 0, heard);
	await shot(app, "04_连调两次只发一句");
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_预览按钮替人说话_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
