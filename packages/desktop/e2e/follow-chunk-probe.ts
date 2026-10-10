/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 跟着底部时，内容一下长出一大截，最新那一行被压到视口下面多远、多久。
 *
 * 正文一个字一个字长，每帧几像素，追得上；界面块的一个元素、一张工具卡是整块到的。从前小于 200px
 * 的用弹簧追、更大的 240ms 滑过去——都是先让内容长出来、下一帧起才挪，这几帧里转录最底下那一行
 * （运行行、刚出来的那块）被推出视口再滑回来。人说的「思考那一行一直跳」就是这个。
 *
 * 量的是每一绘制帧滚动区离底部还差多少（`scrollHeight - scrollTop - clientHeight`）：贴着底部跟随时，
 * 这就是最新的内容被压在视口下沿以下的像素。同一条剧本改前改后各跑一次，两份输出对照。
 *
 * 用法：node --experimental-strip-types e2e/follow-chunk-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume跟随底部测试");
const LABEL = process.env.LABEL ?? "run";
const PORT = 9858;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "follow-chunk";

/** 一段回复：先几句字，然后界面块的元素一个一个整块到，最后调一个工具（工具卡也是整块到的）。 */
const PIECES = [
	"先看本周的数。\n\n",
	"```ui\n<Card title=\"本周\">\n<Grid cols={3}>\n<Stat label=\"访问\" value=\"12,480\" delta=\"+8%\"/>\n<Stat label=\"转化\" value=\"3.1%\"/>\n<Stat label=\"退款\" value=\"6\"/>\n</Grid>\n",
	"<Chart kind=\"bar\" data={[{d:\"一\",v:3},{d:\"二\",v:5},{d:\"三\",v:2},{d:\"四\",v:6},{d:\"五\",v:4}]} size=\"lg\"/>\n",
	"<Table columns={[\"渠道\",\"占比\"]} rows={[[\"搜索\",42],[\"直接\",31],[\"社交\",27],[\"邮件\",9],[\"其他\",3]]}/>\n</Card>\n```\n\n",
	"再列一下目录。",
];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const emitter = (res: ServerResponse) => (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", async () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = emitter(res);
			const toolDone = body.includes('"tool_result"');
			emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			await wait(600);
			if (toolDone) emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "完。" } });
			else for (const piece of PIECES) {
				emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
				await wait(700);
			}
			emit("content_block_stop", { index: 0 });
			if (!toolDone) {
				emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-ls", name: "ls", input: {} } });
				emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "." }) } });
				emit("content_block_stop", { index: 1 });
			}
			emit("message_delta", { delta: { stop_reason: toolDone ? "end_turn" : "tool_use" }, usage: { output_tokens: 16 } });
			emit("message_stop", {});
			res.end();
		});
	});
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "a.ts"), "export const a = 1\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "跟随", cwd, projectId, projectName: "滚动", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	// 历史要比一屏长：贴着底部跟随是从一开始就在滚的状态。
	const history = Array.from({ length: 14 }, (_, at) => `第 ${at + 1} 段：之前聊过的内容，占一点高度，让转录一开始就比一屏长。`).join("\n\n");
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "先说点别的" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: history }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "滚动", pinned: true, lastOpenedAt: 1 }],
	}));
}

/**
 * 每一绘制帧画出来时离底部还差多少。
 *
 * 不在 rAF 里读：rAF 在布局和 `ResizeObserver` 之前，那时内容已经长了、跟随还没来得及写，读到的是
 * 一个从没画出来过的状态（第一版这样量，改后多报了一倍）。rAF 里往 MessageChannel 投一个任务，它
 * 排在这一帧画完之后，读到的才是人看到的那一帧。
 */
const RECORD = `(() => {
	const el = [...document.querySelectorAll("main .ly-scroll-view")].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
	const log = window.__gaps = [];
	const start = performance.now();
	const channel = new MessageChannel();
	channel.port1.onmessage = () => {
		if (el) log.push([Math.round(performance.now() - start), Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)]);
	};
	const tick = () => {
		channel.port2.postMessage(0);
		if (!window.__stop) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return Boolean(el);
})()`;

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-follow-chunk-"));
await seed(home, address.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
let summary = "";

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(800);
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,"看看这周");field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
	await pause(400);
	const found = await app.evaluate<boolean>(RECORD);
	if (!found) throw new Error("找不到转录的滚动区");
	await until(app, `document.querySelector("main").innerText.includes("完。")`, 1200);
	await until(app, `!document.querySelector('button[aria-label="停止"]')`, 1200);
	await pause(800);
	await app.evaluate("window.__stop = true");
	const gaps = await app.evaluate<[number, number][]>("window.__gaps");
	const live = gaps.filter(([, gap]) => gap >= 0);
	const worst = Math.max(...live.map(([, gap]) => gap));
	const over = (limit: number) => live.filter(([, gap]) => gap > limit).length;
	const settled = live.at(-1)?.[1] ?? -1;
	summary = `${LABEL}: 帧 ${live.length}，最深 ${worst}px，>40px 的帧 ${over(40)}，>100px 的帧 ${over(100)}，最后离底 ${settled}px`;
	console.log(summary);
	// 最深的那几段：前后各几帧，看得出是被推下去还是一帧跳回。
	const deep = live.map(([at, gap], index) => ({ at, gap, index })).filter((frame) => frame.gap > 40);
	console.log("深于 40px 的帧（时刻 ms, 离底 px）：", JSON.stringify(deep.slice(0, 60).map((frame) => [frame.at, frame.gap])));
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_每帧离底.json`), JSON.stringify(live));
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_结束.png`), Buffer.from(image.data, "base64"));
} finally {
	await stopRecording?.();
	if (frames.length > 1) await encode(frames, join(OUT_DIR, `${STAMP}_${LABEL}_跟随底部.mp4`));
	await app?.stop();
	model.close();
	console.log(summary ? `→ ${OUT_DIR}` : "没有量到");
}
