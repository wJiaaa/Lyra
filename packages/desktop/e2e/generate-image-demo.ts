/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * `generate_image` 从设置到卡片走一遍——边验边录。
 *
 * 一个本地假服务同时扮两个角色：按剧本吐 SSE 的对话模型（Anthropic 接口），和 OpenAI 兼容的
 * `/v1/images/generations`（回一张渐变 PNG 的 b64_json）。设置里选的图片模型挂在后者上。
 *
 * 用法：node --experimental-strip-types e2e/generate-image-demo.ts [before|after] [输出目录]
 * `before` 只拍设置页那一组，用来和改动前对照。
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSettings, press, until } from "./drive.ts";
import { driver, encode, pause, startRecording, type Frame } from "./record.ts";

const LABEL = process.argv[2] ?? "after";
const OUT_DIR = process.argv[3] ?? join(homedir(), "Desktop", "Plume图片生成测试");
const PORT = 9494;
const MODEL_PORT = 9594;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SIZE = 512;
const PROMPT = "一只站在雪地里的红狐狸，水彩风格";

/** 一张对角渐变的 PNG，当作「画出来的图」。 */
function gradientPng(): Buffer {
	const rows: number[] = [];
	for (let y = 0; y < SIZE; y++) {
		rows.push(0);
		for (let x = 0; x < SIZE; x++) rows.push(Math.round(200 + (x / SIZE) * 55), Math.round(90 + (y / SIZE) * 120), Math.round(60 + ((x + y) / (2 * SIZE)) * 180));
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
	ihdr.writeUInt32BE(SIZE, 0);
	ihdr.writeUInt32BE(SIZE, 4);
	ihdr.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

type Block = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Block[][] = [
	[{ text: "好，我来画。" }, { tool: "generate_image", args: { prompt: PROMPT, size: "1024x1024" } }],
	[{ text: "画好了，图在上面。" }],
];

function sse(res: ServerResponse, payload: object): void {
	res.write(`event: ${(payload as { type: string }).type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const imageRequests: Record<string, unknown>[] = [];
const modelBodies: string[] = [];

function startModel(): Server {
	let request = 0;
	const png = gradientPng().toString("base64");
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", async () => {
			if (req.url?.endsWith("/images/generations")) {
				imageRequests.push({ ...JSON.parse(body), authorization: req.headers.authorization });
				// 够长才拍得到、量得到生成中的那块画布。
				await pause(6000);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: [{ b64_json: png }] }));
				return;
			}
			// 起标题的请求不带工具；拿剧本回答它会吃掉一步。
			const titling = !body.includes('"tools"');
			const blocks: Block[] = titling ? [{ text: "画狐狸" }] : SCRIPT[Math.min(request, SCRIPT.length - 1)];
			if (!titling) {
				request++;
				modelBodies.push(body);
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, { type: "message_start", message: { id: `msg_${request}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			for (const [index, block] of blocks.entries()) {
				await pause(500);
				if ("text" in block) {
					sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } });
					sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
				} else {
					sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${request}_${index}`, name: block.tool, input: {} } });
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

async function seed(home: string): Promise<void> {
	const project = join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 860, x: 0, y: 0 }));
	const base = `http://127.0.0.1:${MODEL_PORT}`;
	await writeFile(join(home, "settings.json"), JSON.stringify({
		version: 1,
		providers: [
			{
				id: "local", name: "Local", baseUrl: base, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
				models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: true, supportsTools: true }],
			},
			{
				id: "img", name: "Image Relay", baseUrl: `${base}/v1`, api: "openai-chat-completions", apiKey: "image-key", enabled: true,
				models: [{ id: "img/gpt-image-1", providerId: "img", modelId: "gpt-image-1", name: "GPT Image 1", contextWindow: 0, maxOutputTokens: 0, supportsThinking: false, supportsImages: true, supportsTools: false }],
			},
		],
		mcpServers: [],
		projects: [{ id: "e2e", name: "project", path: project, pinned: true, lastOpenedAt: 1 }],
		defaultModelId: "local/scripted",
		...(LABEL === "before" ? {} : { imageModelId: "img/gpt-image-1" }),
		permissionMode: "full",
		thinking: "off",
		retryAttempts: 1,
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

const ROW = `[...document.querySelectorAll("main [data-ly-tool]")].find((row) => row.innerText.includes("红狐狸"))`;

const card = (app: RunningApp) => app.evaluate<{ text: string; images: { natural: number; height: number }[] }>(`(() => {
	const row = ${ROW};
	return { text: row?.innerText ?? "", images: [...(row?.querySelectorAll("img") ?? [])].map((img) => ({ natural: img.naturalWidth, height: Math.round(img.getBoundingClientRect().height) })) };
})()`);

async function expand(app: RunningApp) {
	await until(app, `document.querySelector("main [data-ly-turn-process]")`);
	if (!(await app.evaluate<boolean>(`document.querySelector("main [data-ly-turn-process]").hasAttribute("data-ly-turn-open")`))) {
		await click(app, "main [data-ly-turn-process] > button");
	}
	await until(app, ROW);
	await app.evaluate(`(() => { ${ROW}.querySelector("button[aria-expanded]")?.setAttribute("data-demo-row", ""); })()`);
	if (await app.evaluate<boolean>(`document.querySelector("[data-demo-row]")?.getAttribute("aria-expanded") !== "true"`)) await click(app, "[data-demo-row]");
	await until(app, `${ROW}?.querySelector("img")?.complete`);
	await frames(app, 40);
}

let app: RunningApp | undefined;
const model = startModel();
const frames_: Frame[] = [];
let shot = 0;
let home = "";

try {
	await mkdir(OUT_DIR, { recursive: true });
	home = await mkdtemp(join(tmpdir(), "plume-generate-image-"));
	await seed(home);
	app = await startApp({ port: PORT, reuseHome: home });
	const d = driver(app);
	const capture = async (name: string) => {
		const { data } = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${String(++shot).padStart(2, "0")}_${name}.png`), Buffer.from(data, "base64"));
	};
	await d.until(`document.querySelector("main textarea")`, 60000);

	if (LABEL === "before") {
		await openSettings(app, "智能体");
		await until(app, `document.querySelector('button[aria-label="记忆整理模型"]')`);
		await app.evaluate(`document.querySelector('button[aria-label="记忆整理模型"]').scrollIntoView({ block: "center" })`);
		await frames(app, 30);
		await capture("设置_智能体_会话组");
		console.log(`改动前截图在 ${OUT_DIR}`);
	} else {
		const stop = await startRecording(PORT, frames_);
		await pause(800);
		await d.type("画一只雪地里的红狐狸");
		await pause(400);
		await d.submit();

		// 生成中：行下面那块点阵画布，按请求的 1024x1024 占一个 240 的正方形，光斑在动。
		const PENDING = `document.querySelector('main [data-ly-canvas="pending"]')`;
		// 这一轮的过程默认收着，跑着也一样（见 `TurnProcess`）；画布画在它外面，不用点开就看得见。
		const FOLDED = `!document.querySelector("main [data-ly-turn-process]")?.hasAttribute("data-ly-turn-open")`;
		const appeared = await until(app, PENDING, 900).then(() => true, () => false);
		check("生成中，过程收着也看得见画布", appeared && (await app.evaluate<boolean>(FOLDED)), null);
		if (appeared) {
			await pause(1200);
			const mask = () => app!.evaluate<string>(`getComputedStyle(${PENDING}, "::before").maskPosition`);
			const box = await app.evaluate<{ width: number; height: number }>(`(() => { const r = ${PENDING}.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; })()`);
			check("画布按 1024x1024 占成 240×240", box.width === 240 && box.height === 240, box);
			const sweep = () => app!.evaluate<string>(`getComputedStyle(${PENDING}, "::after").maskPosition`);
			const first = await mask();
			const band = await sweep();
			await capture("生成中_点阵画布_甲");
			await pause(700);
			const second = await mask();
			const band2 = await sweep();
			await capture("生成中_点阵画布_乙");
			check("点阵上的光斑在移动", first !== second, { first, second });
			check("亮点的光带在扫过点阵", band !== band2, { band, band2 });
			await pause(1200);
		}

		await d.settled(60000);
		await pause(1000);

		const done = await app.evaluate<{ state: string | null; width: number; height: number; opacity: string } | null>(`(() => {
			const canvas = document.querySelector("main [data-ly-canvas]");
			if (!canvas) return null;
			const r = canvas.getBoundingClientRect();
			return { state: canvas.getAttribute("data-ly-canvas"), width: Math.round(r.width), height: Math.round(r.height), opacity: getComputedStyle(canvas.querySelector("img")).opacity };
		})()`);
		check("出图后过程收着，图在同一块画布里淡入，点阵收掉，仍是 240×240", (await app.evaluate<boolean>(FOLDED)) && done?.state === "done" && done.width === 240 && done.height === 240 && done.opacity === "1", done);
		await capture("出图后_过程收着");
		await pause(1200);

		await expand(app);
		await pause(1200);
		const live = await card(app);
		console.log("卡片：", live);
		await capture("会话里_生成图片");
		check("出图端点收到一次请求，模型、提示词、尺寸、密钥都是设置里那一份", imageRequests.length === 1
			&& imageRequests[0].model === "gpt-image-1" && imageRequests[0].prompt === PROMPT && imageRequests[0].size === "1024x1024"
			&& imageRequests[0].authorization === "Bearer image-key", imageRequests.map(({ prompt, model: m, size }) => ({ prompt, model: m, size })));
		check("工具行写着「生成图片」", /生成图片/.test(live.text), live.text.slice(0, 120));
		check(`卡片里画出了那张图，像素宽度是原图的 ${SIZE}`, live.images.length === 1 && live.images[0]?.natural === SIZE, live.images);
		check("结果里写着保存路径", live.text.includes("session-media"), live.text.slice(0, 300));
		const saved = existsSync(join(home, "session-media")) ? await readdir(join(home, "session-media")) : [];
		check("图片落在 session-media 里", saved.some((name) => name.endsWith(".png")), saved);
		const second = modelBodies[1] ?? "";
		check("下一次请求里，模型看得到这张图", /"tool_result"/.test(second) && /"type":"image"/.test(second), second.length);
		check("下一次请求里，工具结果叫模型别再贴图片链接", second.includes("不要再附图片链接或路径"), second.length);

		if (live.images.length > 0) {
			await click(app, `main [data-ly-canvas] img`);
			await until(app, `document.querySelector('[role="dialog"][aria-label="图片预览"]')`);
			await pause(1200);
			await capture("点开大图");
			check("点画布里的图打开图片预览", true, null);
			await press(app, "Escape", 27);
			await until(app, `!document.querySelector('[role="dialog"][aria-label="图片预览"]')`);
			await pause(800);
		}

		await openSettings(app, "智能体");
		const SELECT = `button[aria-label="图片生成模型"]`;
		await until(app, `document.querySelector('${SELECT}')`);
		await app.evaluate(`document.querySelector('${SELECT}').scrollIntoView({ block: "center" })`);
		await frames(app, 30);
		await pause(1000);
		const label = await app.evaluate<string>(`document.querySelector('${SELECT}').innerText.trim()`);
		check("设置页「图片生成模型」显示选中的 GPT Image 1", label === "GPT Image 1", label);
		await capture("设置_智能体_图片生成模型");
		await click(app, SELECT);
		await until(app, `[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.innerText.trim().startsWith("未设置"))`);
		await pause(1000);
		await capture("设置_图片生成模型_菜单");
		check("菜单里有「未设置」可以清掉", true, null);
		await press(app, "Escape", 27);
		await pause(800);
		await stop();

		const passed = checks.filter((c) => c.ok).length;
		await encode(frames_, join(OUT_DIR, `${STAMP}_${LABEL}_生成图片_${passed}of${checks.length}.mp4`));
		console.log(`\n${passed}/${checks.length} 通过，输出在 ${OUT_DIR}`);
		if (passed !== checks.length) process.exitCode = 1;
	}
} finally {
	await app?.stop();
	await closeListeningServer(model);
	if (home) await rm(home, { recursive: true, force: true });
}
