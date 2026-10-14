/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 先检查、再按 id 发布的页面，从写第一笔到正式页面接上，中间一直看得见——在真窗口里边验边录。
 *
 * 假模型在同一轮里：流一次带 `check: true` 的 `preview`，拿到结果后「想」几秒，再按 id 发布。量的是：
 * - 从草稿出现到正式页面接上，每一帧卡片位置上都有画面（草稿或正式页面），没有空着的一帧；
 * - 正式页面接在草稿原来的位置上，不是在下面另起一张；
 * - 检查过、等发布的那几秒，草稿说的是「还没发布」；
 * - 另一轮只检查不发布：这一轮结束时草稿收走，对话里不多出一张页面。
 *
 * 用法：node --experimental-strip-types e2e/preview-check-handover-demo.ts [输出目录]
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

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume预览草稿测试");
const PORT = 9856;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "preview-check-handover";
const DRAFT = "main [data-ly-preview-draft]";
const CARD = "main [data-ly-preview]:not([data-ly-preview-draft])";
/** 检查拿到结果以后，模型「想」多久才发布：这一段就是从前草稿消失、对话里什么都没有的那一段。 */
const THINK_MS = 4000;
const ITEMS = ["完成产品原型评审", "给市场部回邮件", "采购下周团建物资", "整理用户访谈记录", "预约牙医"];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${Array.from({ length: 30 }, (_, i) => `.pad-${i}{padding:${i}px}`).join("\n")}
h1{font-size:20px;margin:0 0 12px}ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{display:flex;gap:10px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
li::before{content:"";width:16px;height:16px;border-radius:50%;border:1.5px solid var(--primary)}
</style></head><body>
<h1 id="title">今日待办</h1>
<ul>
${ITEMS.map((item) => `<li>${item}</li>`).join("\n")}
</ul>
</body></html>`;

let mode: "publish" | "only" = "publish";
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
				if (last.includes("已检查")) {
					const id = /id[:：]\s*([\w-]+)/.exec(last);
					checkId = id?.[1] ?? "";
					if (mode === "only") return void reply(res, { text: "先不发，等你看过再说。", delay: THINK_MS });
					return void reply(res, { tool: { id: "publish-1", name: "preview", input: { id: checkId } }, delay: THINK_MS });
				}
				return void reply(res, { text: "好了，挑一个吧。" });
			}
			if (last.includes("CHECK_THEN_PUBLISH")) {
				mode = "publish";
				return void reply(res, { tool: { id: "check-1", name: "preview", input: { title: "待办模板", check: true, html: PAGE } } });
			}
			if (last.includes("CHECK_ONLY")) {
				mode = "only";
				return void reply(res, { tool: { id: "check-2", name: "preview", input: { title: "只检查", check: true, html: PAGE.replace("今日待办", "只检查的页面") } } });
			}
			void reply(res, { text: "嗯。" });
		});
	});
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function reply(res: ServerResponse, what: { text?: string; tool?: { id: string; name: string; input: object }; delay?: number }) {
	if (what.delay) await wait(what.delay);
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
		// 每段 40 个字、隔 80ms：页面要写几秒，够看清它是怎么长出来的。
		for (let at = 0; at < json.length; at += 40) {
			emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + 40) } });
			await wait(80);
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
	const meta = { id: SESSION, title: "待办模板", cwd, projectId, projectName: "检查后发布", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "给我几个待办模板。" }], timestamp: 1 }, seq: 1, ts: 1 },
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
		projects: [{ id: projectId, path: cwd, name: "检查后发布", pinned: true, lastOpenedAt: 1 }],
	}));
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};
// 不走 `drive.ts` 的 `shot`：那个只在设了 `PLUME_E2E_ARTIFACTS` 时写，这里的图要和录像放在一起。
const capture = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
async function send(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector('textarea[aria-label="消息"]');const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector('textarea[aria-label="消息"]').dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
}
const idle = (app: RunningApp) => until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);
const count = (app: RunningApp, selector: string) => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

/*
 * 从草稿出现起逐帧看：草稿画着页面、或者正式页面已经不透明，两样都没有的那一帧就是空。
 * 同时记草稿和正式页面各自的顶边，交接时看是不是同一个位置。
 */
const WATCH = `void (window.__watch = new Promise((resolve) => {
	let blank = 0, frames = 0, draftTop = null, cardTop = null, sawDraft = false; const labels = new Set(); const gaps = [];
	const started = performance.now();
	const tick = () => {
		const draft = document.querySelector(${JSON.stringify(DRAFT)});
		const fresh = document.querySelectorAll(${JSON.stringify(CARD)}).length > window.__cardsBefore ? [...document.querySelectorAll(${JSON.stringify(CARD)})].at(-1) : null;
		const page = fresh?.querySelector("iframe");
		const pageVisible = Boolean(page && Number(getComputedStyle(page).opacity) > 0.5);
		const draftVisible = Boolean(draft && draft.dataset.lyPreviewDraft === "page");
		if (draftVisible) { sawDraft = true; draftTop = Math.round(draft.getBoundingClientRect().top + scrollY); const label = draft.querySelector('[role="status"]')?.textContent; if (label) labels.add(label.replace(/ · .*/, "")); }
		if (pageVisible) cardTop = Math.round(fresh.getBoundingClientRect().top + scrollY);
		if (sawDraft) { frames++; if (!pageVisible && !draftVisible) { blank++; gaps.push({ at: Math.round(performance.now() - started), draft: draft ? draft.dataset.lyPreviewDraft : null, card: Boolean(fresh), opacity: page ? getComputedStyle(page).opacity : null }); } }
		if ((fresh && !draft && pageVisible) || performance.now() - started > 60000) resolve({ blank, frames, draftTop, cardTop, labels: [...labels], gaps });
		else requestAnimationFrame(tick);
	};
	tick();
}))`;

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
const home = await mkdtemp(join(tmpdir(), "plume-preview-check-handover-"));
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

	console.log("\n一、同一轮里先检查、想几秒、再按 id 发布");
	await app.evaluate(`window.__cardsBefore = ${await count(app, CARD)}`);
	await send(app, "CHECK_THEN_PUBLISH 给我几个模板");
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})`, 900);
	await app.evaluate(WATCH);
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})?.dataset.lyPreviewDraft === "page"`, 900);
	await capture(app, "01_检查的页面边写边显示");
	// 检查结果回来、模型还在想的那几秒。
	await until(app, `/还没发布|not published/.test(document.querySelector(${JSON.stringify(DRAFT)} + ' [role="status"]')?.textContent ?? "")`, 600).catch(() => {});
	await pause(1500);
	const thinking = { drafts: await count(app, DRAFT), shown: await app.evaluate<string>(`document.querySelector(${JSON.stringify(DRAFT)})?.dataset.lyPreviewDraft ?? "none"`) };
	check("检查完、模型还在想的时候，页面还在", thinking.drafts === 1 && thinking.shown === "page", thinking);
	await capture(app, "02_检查完等发布时页面还在");
	const watched = await app.evaluate<{ blank: number; frames: number; draftTop: number | null; cardTop: number | null; labels: string[]; gaps: unknown[] }>("window.__watch");
	check("从草稿出现到正式页面接上，没有一帧是空的", watched.blank === 0 && watched.frames > 60, { blank: watched.blank, frames: watched.frames, gaps: watched.gaps });
	check("正式页面接在草稿原来的位置上", watched.draftTop !== null && watched.cardTop !== null && Math.abs(watched.draftTop - watched.cardTop) <= 2, { draftTop: watched.draftTop, cardTop: watched.cardTop });
	check("等发布时草稿说的是「还没发布」", watched.labels.some((label) => /还没发布/.test(label)), watched.labels);
	await idle(app);
	await pause(1200);
	const published = { cards: await count(app, CARD), drafts: await count(app, DRAFT), title: await app.evaluate<string>(`[...document.querySelectorAll(${JSON.stringify(CARD)})].at(-1)?.querySelector("iframe")?.title ?? ""`) };
	check("最后只有一张正式页面，草稿收走了", published.cards === 1 && published.drafts === 0 && published.title === "待办模板", published);
	await capture(app, "03_发布后原地换成正式页面");

	console.log("\n二、只检查、这一轮没发布");
	await send(app, "CHECK_ONLY 先看看");
	await until(app, `document.querySelector(${JSON.stringify(DRAFT)})?.dataset.lyPreviewDraft === "page"`, 900);
	await until(app, `/还没发布|not published/.test(document.querySelector(${JSON.stringify(DRAFT)} + ' [role="status"]')?.textContent ?? "")`, 600).catch(() => {});
	const holding = await count(app, DRAFT);
	check("检查完、这一轮还没结束时草稿还在", holding === 1, { holding });
	await capture(app, "04_只检查时等着");
	await idle(app);
	await pause(1200);
	const after = { drafts: await count(app, DRAFT), cards: await count(app, CARD) };
	check("这一轮结束没发布：草稿收走，没多出页面", after.drafts === 0 && after.cards === 1, after);
	await capture(app, "05_没发布这一轮结束草稿收走");
} catch (error) {
	failures++;
	console.error(error);
	if (app) await capture(app, "99_失败现场").catch(() => {});
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(model);
	await rm(home, { recursive: true, force: true });
}

const total = passes + failures;
const video = join(OUT_DIR, `${STAMP}_检查后发布不消失_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
