/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 拿用户贴的图改图、带图分叉、中转塞服务端工具时的报错——三件事在真窗口里各走一遍。
 *
 * 一、贴一张图说「改成水墨风」：模型用 `#1` 调 `image_generate`，出图端点收到的是
 *    `/v1/images/edits`，里面就是那张图。
 * 二、对那条消息「从这里分叉」：大图在日志里只剩 session-media 的文件名，分叉后的输入框里要有那张
 *    缩略图，发出去模型要真看到像素，而不是一行「contents not included」。
 * 三、换一个 Responses 接口的假中转，回 `image_generation_call` 加空 message：界面要说出是哪一种，
 *    而且只请求一次，不再自动「继续」三遍。
 *
 * 用法：node --experimental-strip-types e2e/generate-image-reference-demo.ts [输出目录]
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, hover, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume图片生成测试");
const PORT = 9495;
const MODEL_PORT = 9595;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

function png(width: number, height: number, tint: number): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < height; y++) {
		rows.push(0);
		for (let x = 0; x < width; x++) rows.push(Math.round((x / width) * 255), tint, Math.round((y / height) * 255));
	}
	const chunk = (type: string, data: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(data.length, 0);
		head.write(type, 4, "ascii");
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0);
		return Buffer.concat([head, data, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	// 不压缩：要比内联上限大，日志才会把它挪进 session-media——分叉丢图就出在那一种图上。
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows), { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

// 横图：改图没说比例时，画布要按它的 16:9 占位，而不是先占一个正方形、图到了再跳成横条。
const PHOTO = png(320, 180, 40);
const RESULT = png(384, 216, 200);

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [
	[{ text: "好，参考这张图来改。" }, { tool: "image_generate", args: { prompt: "保留人物，改成水墨风，站在竹林里", images: ["#1"] } }],
	[{ text: "改好了。" }],
	[{ text: "看到这张图了。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const editRequests: Buffer[] = [];
const chatBodies: string[] = [];
let responsesRequests = 0;

function startModel(): Server {
	let turn = 0;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", async () => {
			const raw = Buffer.concat(chunks);
			const body = raw.toString("utf8");
			if (req.url?.endsWith("/images/edits")) {
				editRequests.push(raw);
				await pause(1200);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ b64_json: RESULT.toString("base64") }] }));
				return;
			}
			if (req.url?.endsWith("/responses")) {
				// 三：CLIProxyAPI「图像生成行为」为已启用时的形状。起标题的那一次不带工具，照常回一句话。
				const titling = !body.includes('"tools"');
				if (!titling) responsesRequests++;
				res.writeHead(200, { "content-type": "text/event-stream" });
				const item = (index: number, value: object) => sse(res, { type: "response.output_item.done", output_index: index, item: value });
				if (titling) item(0, { type: "message", role: "assistant", content: [{ type: "output_text", text: "画猫" }] });
				else {
					await pause(800);
					item(0, { type: "image_generation_call", id: "ig_1", status: "completed", result: RESULT.toString("base64") });
					item(1, { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] });
				}
				sse(res, { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 500 } } });
				res.end();
				return;
			}
			const titling = !body.includes('"tools"');
			const blocks: Block[] = titling ? [{ text: "水墨改图" }] : SCRIPT[Math.min(turn, SCRIPT.length - 1)];
			if (!titling) {
				turn++;
				chatBodies.push(body);
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			sse(res, { type: "message_start", message: { id: `msg_${turn}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(400);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${turn}_${index}`, name: block.tool, input: {} } });
					sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.args) } });
				}
				sse(res, { type: "content_block_stop", index });
			}
			sse(res, { type: "message_delta", delta: { stop_reason: blocks.some((b) => "tool" in b) ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
			sse(res, { type: "message_stop" });
			res.end();
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

async function seed(home: string, chatModel: "local/scripted" | "relay/gpt-6.1-sol"): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	const base = `http://127.0.0.1:${MODEL_PORT}`;
	const chat = (id: string, modelId: string) => ({ id, providerId: id.split("/")[0], modelId, name: modelId, contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true });
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{ id: "local", name: "Local", baseUrl: base, api: "anthropic-messages", apiKey: "k", enabled: true, models: [chat("local/scripted", "scripted")] },
			{ id: "relay", name: "Relay", baseUrl: `${base}/v1`, api: "openai-responses", apiKey: "k", enabled: true, models: [chat("relay/gpt-6.1-sol", "gpt-6.1-sol")] },
			{ id: "img", name: "Image Relay", baseUrl: `${base}/v1`, api: "openai-chat-completions", apiKey: "image-key", enabled: true,
				models: [{ id: "img/gpt-image-2", providerId: "img", modelId: "gpt-image-2", name: "GPT Image 2", contextWindow: 0, maxOutputTokens: 0, supportsThinking: false, supportsImages: true, supportsTools: false }] },
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: chatModel,
		imageModelId: "img/gpt-image-2",
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 3,
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

/** 走人选完文件之后的同一条路：往 file input 里塞文件、派发 change。同 `attachments-demo.ts`。 */
async function attach(app: RunningApp, bytes: Buffer, name: string): Promise<void> {
	await app.evaluate(`(() => {
		const bin = atob(${JSON.stringify(bytes.toString("base64"))});
		const data = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
		const input = document.querySelector('input[type="file"]');
		const transfer = new DataTransfer();
		transfer.items.add(new File([data], ${JSON.stringify(name)}, { type: "image/png" }));
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
}

const STRIP_IMAGES = `[...document.querySelectorAll('main [data-ly-composer-attachments] img')]`;

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
const homes: string[] = [];

try {
	await mkdir(OUT_DIR, { recursive: true });
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_参考图_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};

	// 一、二
	const home = await mkdtemp(join(tmpdir(), "plume-image-ref-"));
	homes.push(home);
	await seed(home, "local/scripted");
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	await d.until(`document.querySelector("main textarea")`, 60000);
	let stop = await startRecording(PORT, frames_);
	await pause(800);
	// 先打字后贴图：图片在句子里有一枚标记，`type` 整段改写输入框会把标记连同附件一起冲掉。
	await d.type("改成水墨风，站在竹林里");
	await pause(400);
	await attach(app, PHOTO, "689839.PNG");
	await until(app, `${STRIP_IMAGES}.length === 1`);
	// 缩略图先出来，文件内容是异步读进草稿的；同 attachments-demo，读完再发。
	await pause(2500);
	await d.submit();
	const CANVAS = (state: string) => `(() => { const el = document.querySelector('main [data-ly-canvas="${state}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()`;
	await until(app, `${CANVAS("pending")} !== null`, 30000);
	await pause(300);
	const holding = await app.evaluate<{ width: number; height: number } | null>(CANVAS("pending"));
	await capture("改图中_按原图比例占位");
	await d.settled(60000);
	await pause(1000);
	await capture("贴图改图_结果");
	const landed = await app.evaluate<{ width: number; height: number } | null>(CANVAS("done"));
	check("改图没说比例，画图时按贴的那张 16:9 占成 427×240", holding?.width === 427 && holding.height === 240, holding);
	check("图到了还是那块位置，没有跳", landed?.width === holding?.width && landed?.height === holding?.height, { holding, landed });

	const edit = editRequests[0];
	check("出图端点收到的是 /v1/images/edits，一次", editRequests.length === 1, editRequests.length);
	check("编辑请求里带着用户贴的那张图（字节一致）", Boolean(edit && edit.includes(Buffer.from('name="image"')) && edit.includes(PHOTO)), edit?.length);
	// 一轮只有一次工具调用时折成一行摘要，不带 `data-ly-tool`；从看得见的字取证。
	const generated = await app.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
	check("会话里有一行「生成图片」", generated.includes("生成图片"), generated.slice(0, 200));

	// 二：分叉。分叉出来的会话从磁盘读，大图只剩文件名——正是丢图的那条路。
	await hover(app, '[data-question-index="0"]');
	await click(app, '[data-question-index="0"] [data-message-fork]');
	await until(app, `[...document.querySelectorAll('[data-ly-row]')].some((row) => row.innerText.includes('（分叉）'))`);
	await until(app, `${STRIP_IMAGES}.length === 1 && ${STRIP_IMAGES}[0].complete`);
	await frames(app, 30);
	await pause(800);
	const strip = await app.evaluate<{ count: number; natural: number; data: boolean }>(`(() => { const imgs = ${STRIP_IMAGES}; return { count: imgs.length, natural: imgs[0]?.naturalWidth ?? 0, data: (imgs[0]?.src ?? "").startsWith("data:image") }; })()`);
	await capture("分叉后_输入框里的图");
	check("分叉后的输入框里有那张图，像素宽度 320", strip.count === 1 && strip.natural === 320 && strip.data, strip);
	await d.submit();
	await d.settled(60000);
	await pause(1000);
	const forked = chatBodies.at(-1) ?? "";
	const firstUser = (() => {
		try {
			return JSON.stringify((JSON.parse(forked) as { messages: { role: string; content: unknown }[] }).messages.find((m) => m.role === "user")?.content ?? "");
		} catch {
			return "";
		}
	})();
	check("分叉发出去，模型收到的是图片本身", firstUser.includes('"type":"image"') && firstUser.includes(PHOTO.toString("base64").slice(0, 200)), firstUser.slice(0, 200));
	check("不再是「contents not included」", !firstUser.includes("contents not included"), firstUser.slice(0, 200));
	await capture("分叉后_发出去");
	await pause(600);
	await stop();
	await app.stop();
	app = undefined;

	// 三
	const home2 = await mkdtemp(join(tmpdir(), "plume-image-ref-"));
	homes.push(home2);
	await seed(home2, "relay/gpt-6.1-sol");
	app = await startApp({ port: PORT, reuseHome: home2 });
	const d2 = driver(app);
	await d2.until(`document.querySelector("main textarea")`, 60000);
	stop = await startRecording(PORT, frames_);
	await pause(800);
	await d2.type("画一只猫");
	await pause(400);
	await d2.submit();
	await d2.settled(60000);
	await pause(1500);
	const main = await app.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
	await capture("服务端工具_报错");
	check("界面说出是 image_generation_call", main.includes("image_generation_call"), main.slice(-300));
	check("只请求了一次，没有自动「继续」", responsesRequests === 1 && !main.includes("自动继续"), responsesRequests);
	await pause(800);
	await stop();

	const passed = checks.filter((c) => c.ok).length;
	await encode(frames_, join(OUT_DIR, `${STAMP}_参考图与分叉与报错_${passed}of${checks.length}.mp4`));
	console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await app?.stop();
	await closeListeningServer(model);
	for (const home of homes) await rm(home, { recursive: true, force: true });
}
