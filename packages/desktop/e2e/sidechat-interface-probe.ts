/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 侧边聊天里的界面块：模型被教了怎么写，画出来，按钮说的话回到侧边聊天、不进主对话。
 *
 * 从前侧边聊天的提示词里没有界面块那一段，它不会写；就算写了，块里的 `send` 按会话说，说进的是
 * 主对话——人在侧边点一下，话出现在另一边。
 *
 * 用法：node --experimental-strip-types e2e/sidechat-interface-probe.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type RunningApp } from "./app.ts";
import { click, openPane, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume侧边聊天界面块测试");
const PORT = 9859;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "side-ui";
const PANE = '[data-dock-pane="chat"]';
const MAIN = '[data-dock-pane="conversation"]';

const REPLY = `两种做法，挑一个：

\`\`\`ui
<Card title="怎么改">
  <Choice name="pick" label="做法" options={["A：改调用方","B：改共享函数"]} value="A：改调用方"/>
  <Button send="就用 {pick}" primary>就这个</Button>
</Card>
\`\`\``;

/** 每个请求：是不是侧边聊天的、系统提示词、最后一句人说的话、带了哪些工具。 */
const requests: { side: boolean; system: string; last: string; tools: string[] }[] = [];

function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", async () => {
			const parsed = JSON.parse(body) as { system?: unknown; tools?: { name: string }[]; messages: { role: string; content: unknown }[] };
			const system = JSON.stringify(parsed.system ?? "");
			// 人说的最后一句：跳过环境说明，也跳过侧边聊天每次提问后附上的主会话进展。
			const last = JSON.stringify(parsed.messages.findLast((message) => message.role === "user" && !/^\[\{"type":"text","text":"<(env|main-session)>/.test(JSON.stringify(message.content)))?.content ?? "");
			// 侧边聊天是一个会话，提示词和主会话同出一源；认它靠只有它才有的工具。
			const tools = parsed.tools?.map((tool) => tool.name) ?? [];
			const side = tools.includes("read_main_chat");
			requests.push({ side, system, last, tools });
			const text = side && last.includes("SIDE_UI") ? REPLY : "收到。";
			const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			await pause(300);
			emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } });
			emit("message_stop", {});
			res.end();
		});
	});
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "主对话", cwd, projectId, projectName: "侧边", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "修一下登录" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "主对话里的回答。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "侧边", pinned: true, lastOpenedAt: 1 }],
	}));
}

let passes = 0;
let failures = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-side-ui-"));
await seed(home, address.port);
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await openPane(app, "侧边聊天");
	await until(app, `document.querySelector('${PANE} textarea')`, 900);
	await pause(600);

	console.log("\n一、在侧边问，模型回一个界面块");
	await app.evaluate(`(()=>{const field=document.querySelector('${PANE} textarea');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,"SIDE_UI 怎么改比较好");field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('${PANE} textarea').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
	await until(app, `document.querySelector('${PANE} [data-ly-interface="ready"]')`, 900);
	await pause(800);
	const asked = requests.find((request) => request.side);
	// 侧边聊天和主会话工具一样，`preview` 也在；提示词提不提它，要和手里有没有这件工具对得上。
	const pointsAtPreview = Boolean(asked?.system.includes("is `preview`'s job"));
	check("侧边聊天的提示词里有界面块那一段，提不提 preview 和它有没有这件工具一致", Boolean(asked?.system.includes("Interface blocks:")) && pointsAtPreview === Boolean(asked?.tools.includes("preview")), { tools: asked?.tools.includes("preview"), pointsAtPreview });
	await shot(app, "01_侧边画出界面块");

	console.log("\n二、选 B，按「就这个」");
	await click(app, `${PANE} [data-ly-interface] [data-segmented] button`, "B：改共享函数");
	await pause(400);
	const mainBefore = requests.filter((request) => !request.side).length;
	await click(app, `${PANE} [data-ly-interface] button`, "就这个");
	await until(app, `document.querySelector('${PANE}').innerText.includes("收到。")`, 900);
	await pause(800);
	const said = requests.findLast((request) => request.side)?.last ?? "";
	check("话发进了侧边聊天，带着块里的值", said.includes("就用 B：改共享函数") && said.includes("<interface-values>"), said.slice(0, 200));
	check("主对话没有收到这句话（没多发请求）", requests.filter((request) => !request.side).length === mainBefore, { before: mainBefore, after: requests.filter((request) => !request.side).length });
	const panes = await app.evaluate<{ side: string; main: string; sent: boolean }>(`({ side: document.querySelector('${PANE}').innerText, main: document.querySelector('${MAIN}').innerText, sent: Boolean(document.querySelector('${PANE} [data-ly-ui-sent]')) })`);
	check("侧边的气泡里只有那句话", panes.side.includes("就用 B：改共享函数") && !panes.side.includes("interface-values"), panes.side.slice(-200));
	check("主对话里没有这句话", !panes.main.includes("就用 B"), panes.main.slice(-200));
	check("块上的按钮换成「已发送」", panes.sent, panes.sent);
	await shot(app, "02_按下之后");
} catch (error) {
	failures++;
	console.error(error);
	if (app) await shot(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	const total = passes + failures;
	if (frames.length > 1) await encode(frames, join(OUT_DIR, `${STAMP}_侧边聊天界面块_${passes}of${total}.mp4`));
	await app?.stop();
	model.close();
	console.log(`\n${passes}/${total} 通过 → ${OUT_DIR}`);
	process.exitCode = failures === 0 ? 0 : 1;
}
