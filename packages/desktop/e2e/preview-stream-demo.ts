/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * `preview` 边写边显示——在真窗口里边验边录。
 *
 * 假模型把一次 `preview` 调用的参数切成几十段、隔一会儿流一段，像真模型写一个大页面那样。量的是：
 * - 写样式的时候是这次调用本来的那一行工具行，不是一块空着的页面；
 * - 页面开始以后一点点长出来，已经画出来的元素原地不动（没有被整段重建，所以不闪）；
 * - 草稿里脚本不跑：页面脚本会把标题改掉，草稿里的标题始终是原样，换成正式页面后才变；
 * - 交接的每一帧卡片位置上都有画面，不塌、不空；
 * - 带 `check` 的那次写的时候照样看得见，写完不发布，草稿收走；再按 id 发布，页面直接出来。
 *
 * 用法：node --experimental-strip-types e2e/preview-stream-demo.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume预览边写边显示测试");
const PORT = 9855;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "preview-stream";
const DRAFT = "main [data-ly-preview-draft]";
const CITIES = ["杭州", "苏州", "南京", "扬州", "镇江", "无锡", "常州", "上海", "嘉兴", "湖州", "绍兴", "宁波", "舟山", "台州", "温州", "金华", "衢州", "丽水", "黄山", "宣城"];
const ROWS = CITIES.map((city, i) => `<li><b>第 ${i + 1} 站</b><span>${city}</span></li>`).join("\n");
/** 样式在前、结构居中、脚本最后；脚本会改标题——草稿里它不该跑。 */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${Array.from({ length: 30 }, (_, i) => `.pad-${i}{padding:${i}px}`).join("\n")}
h1{font-size:22px;margin:0 0 12px}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{display:flex;justify-content:space-between;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--card)}
li span{color:var(--muted-foreground)}svg{display:block;margin-top:12px}
</style></head><body>
<h1 id="title">江南八站</h1>
<ul>
${ROWS}
</ul>
<svg width="320" height="40" viewBox="0 0 320 40"><rect x="0" y="10" width="300" height="20" rx="10" fill="var(--chart-1)"/></svg>
<script>
document.getElementById("title").textContent = "江南八站（脚本已运行）";
</script>
</body></html>`;

/** 第几轮：一次正常发布、一次 check、一次按 id 发布。 */
let checkId = "";
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
			const last = messages.map((message) => JSON.stringify(message.content)).findLast((content) => !content.includes("<env>")) ?? "";
			if (last.includes("tool_result")) {
				const id = /"id":\s*"([^"\\]+)"|id[:：]\s*`?([\w-]+)`?/.exec(last);
				if (last.includes("check-1")) checkId = id?.[1] ?? id?.[2] ?? "";
				return void reply(res, { text: "好了。" });
			}
			if (last.includes("STREAM_PAGE")) return void reply(res, { tool: { id: "page-1", name: "preview", input: { title: "江南八站", html: PAGE } } });
			if (last.includes("CHECK_PAGE")) return void reply(res, { tool: { id: "check-1", name: "preview", input: { title: "检查", check: true, html: PAGE.replace("江南八站", "检查用的页面") } } });
			if (last.includes("PUBLISH_PAGE")) return void reply(res, { tool: { id: "publish-1", name: "preview", input: { id: checkId } } });
			void reply(res, { text: "嗯。" });
		});
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function reply(res: ServerResponse, what: { text?: string; tool?: { id: string; name: string; input: object } }) {
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
		const json = JSON.stringify(what.tool.input);
		// 每段 24 个字、隔 120ms：三千来字的页面要写十几秒，够看清它是怎么长出来的。
		const size = 24;
		for (let at = 0; at < json.length; at += size) {
			emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + size) } });
			await wait(120);
		}
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
	const meta = { id: SESSION, title: "江南八站", cwd, projectId, projectName: "边写边显示", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "排一条江南的路线。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "我做个页面给你看。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "边写边显示", pinned: true, lastOpenedAt: 1 }],
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
async function type(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);
/** 草稿里画出来的东西：同源、不跑脚本，所以这一侧读得到。 */
const draft = (app: RunningApp) => app.evaluate<{ state: string; label: string; items: number; title: string; marked: boolean; row: boolean; height: number } | null>(`(() => {
	const box = document.querySelector(${JSON.stringify(DRAFT)});
	if (!box) return null;
	const doc = box.querySelector("iframe")?.contentDocument;
	const title = doc?.getElementById("title");
	return { state: box.dataset.lyPreviewDraft, label: box.querySelector('[role="status"]')?.textContent ?? "", items: doc?.querySelectorAll("li").length ?? 0, title: title?.textContent ?? "", marked: title?.__mark === 1, row: Boolean(box.querySelector("[data-ly-tool]")), height: Math.round(box.getBoundingClientRect().height) };
})()`);

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-preview-stream-"));
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

	console.log("\n一、模型写样式的时候：就是一行普通的工具行");
	await type(app, "STREAM_PAGE 做个路线页");
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})`, 900);
	const first = await draft(app);
	await wait(600);
	const early = await draft(app);
	check("草稿一出来是占位", first?.state === "placeholder", first);
	check("写样式时占位就是这次调用的工具行，一行高，没有空白", early?.state === "placeholder" && early.row && early.height < 60, early);
	await shot(app, "01_写样式时是占位");

	console.log("\n二、写到页面：一点点长出来，画好的不重建，脚本不跑");
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})?.dataset.lyPreviewDraft === "page" && document.querySelector(${JSON.stringify(DRAFT)} + " iframe")?.contentDocument?.getElementById("title")`, 1800);
	// 给已经画出来的标题打个记号：之后它要是被重建，记号就没了。
	await app.evaluate(`document.querySelector(${JSON.stringify(DRAFT)} + " iframe").contentDocument.getElementById("title").__mark = 1`);
	/*
	 * 从现在起逐帧看卡片位置，一直看到正式页面接上：草稿画着、或者正式页面已经不透明——两样都没有的
	 * 那一帧就是闪。在写完之前就开始看，交接那几帧才不会错过。
	 */
	// 挂上就走，不等它：等它就等到了交接之后。
	await app.evaluate(`void (window.__handover = new Promise((resolve) => {
		let blank = 0, frames = 0; const heights = []; const started = performance.now();
		const tick = () => {
			const card = document.querySelector('main [data-ly-preview]:not([data-ly-preview-draft])');
			const draft = document.querySelector(${JSON.stringify(DRAFT)});
			const page = card?.querySelector("iframe");
			const pageVisible = Boolean(page && Number(getComputedStyle(page).opacity) > 0.5);
			const draftVisible = Boolean(draft && draft.dataset.lyPreviewDraft === "page");
			frames++;
			if (!pageVisible && !draftVisible) blank++;
			const holder = (draft ?? card)?.parentElement;
			if (holder) heights.push(Math.round(holder.getBoundingClientRect().height));
			if ((card && !draft && pageVisible) || performance.now() - started > 40000) resolve({ blank, frames, heights });
			else requestAnimationFrame(tick);
		};
		tick();
	}))`);
	const counts: number[] = [];
	let mid: Awaited<ReturnType<typeof draft>> = null;
	for (let i = 0; i < 40; i++) {
		const now = await draft(app);
		if (!now || now.state !== "page") break;
		mid = now;
		counts.push(now.items);
		if (i === 6) await shot(app, "02_页面一点点长出来");
		await wait(250);
	}
	check("列表一项一项长出来", counts.length > 3 && counts.at(-1)! > counts[0]! && counts.every((n, i) => i === 0 || n >= counts[i - 1]!), counts);
	check("标题一直是开头画的那个元素，没被重建", mid?.marked === true, mid);
	check("草稿里脚本没跑：标题是原样", mid?.title === "江南八站", mid?.title);
	check("最后写脚本时标签说「正在写脚本」或「正在检查」", /正在写脚本|正在检查/.test(mid?.label ?? ""), mid?.label);

	console.log("\n三、交接：正式页面接上，每一帧都有画面");
	const handover = await app.evaluate<{ blank: number; frames: number; heights: number[] }>("window.__handover");
	check("交接的每一帧都有画面", handover.blank === 0 && handover.frames > 30, { blank: handover.blank, frames: handover.frames });
	const drops = handover.heights.filter((h, i) => i > 0 && h < handover.heights[i - 1]! - 40);
	check("卡片高度没有一下子塌下去", drops.length === 0, { first: handover.heights[0], last: handover.heights.at(-1), drops });
	await idle(app);
	await pause(1200);
	const ran = await app.evaluate<string>(`document.querySelector('main [data-ly-preview] iframe')?.title ?? ""`);
	check("正式页面接上了", ran === "江南八站", ran);
	await shot(app, "03_换成正式页面");

	console.log("\n四、check 那一次：写的时候看得见，写完不发布");
	const cardsBefore = await app.evaluate<number>(`document.querySelectorAll('main [data-ly-preview]:not([data-ly-preview-draft])').length`);
	await type(app, "CHECK_PAGE 先检查一下");
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})`, 900);
	check("写 check 页面时也有草稿", true, "");
	await shot(app, "04_check时也在写");
	await idle(app);
	await pause(800);
	const after = { drafts: await app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(DRAFT)}).length`), cards: await app.evaluate<number>(`document.querySelectorAll('main [data-ly-preview]:not([data-ly-preview-draft])').length`) };
	check("写完草稿收走了，没有多出一张页面", after.drafts === 0 && after.cards === cardsBefore, { cardsBefore, ...after, checkId });

	console.log("\n五、按 id 发布：没有要写的，页面直接出来");
	await type(app, "PUBLISH_PAGE 发出来");
	await idle(app);
	await pause(1500);
	check("多了一张页面，是检查过的那一页", (await app.evaluate<number>(`document.querySelectorAll('main [data-ly-preview]:not([data-ly-preview-draft])').length`)) === cardsBefore + 1 && checkId !== "", { checkId });
	await app.evaluate(`[...document.querySelectorAll('main [data-ly-preview]')].at(-1)?.scrollIntoView({ block: "center" })`);
	await pause(800);
	await shot(app, "05_按id发布");
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
const video = join(OUT_DIR, `${STAMP}_预览边写边显示_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
