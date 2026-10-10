/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 本地 HTML 不起服务也能在内置浏览器里打开，重启以后还打得开——在真窗口里边验边录。
 *
 * 起因是一个 agent 为了看自己写的页面起了 `python -m http.server 8791`，看完关掉，标签从此只会报
 * `ERR_CONNECTION_REFUSED`。这里走一遍现在的四条路：对话里文件链接旁的按钮、地址栏输入路径、
 * agent 的 `browser_open` 传路径、`preview` 传 `path`；再把应用整个关掉重开，点 agent 留下的卡片。
 * 另外量一次连不上的地址：面板里那行字之外，不该再弹一条 `Error invoking remote method`。
 *
 * 模型是本地一台假服务器，按用户消息里的暗号回固定的工具调用，不花真钱也不看运气。
 *
 * 用法：node --experimental-strip-types e2e/local-page-demo.ts [输出目录]
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, hover, openSession, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume本地网页测试");
const PORT = 9851;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SESSION = "local-page";
const ADDRESS = '[aria-label="地址栏或搜索"]';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>鹈鹕骑车</title>
<style>body{margin:0;font:16px system-ui;background:#eaf4ff;color:#123}h1{margin:24px}svg{display:block;width:100%;height:240px}
@keyframes spin{to{transform:rotate(360deg)}}.wheel{transform-origin:center;transform-box:fill-box;animation:spin 1s linear infinite}</style></head>
<body><h1 id="title">鹈鹕骑车</h1><svg viewBox="0 0 400 200"><circle class="wheel" cx="120" cy="140" r="40" fill="none" stroke="#123" stroke-width="6" stroke-dasharray="20 10"/>
<circle class="wheel" cx="280" cy="140" r="40" fill="none" stroke="#123" stroke-width="6" stroke-dasharray="20 10"/><ellipse cx="200" cy="70" rx="50" ry="30" fill="#fff" stroke="#123" stroke-width="4"/></svg></body></html>`;

/** 模型这一侧：暗号换工具调用，工具结果回来以后说一句话收尾。收到的工具结果留着给断言看。 */
const results: string[] = [];
/** `REOPEN_LOCAL` 那一轮：改一版页面、开个新标签看一眼，连做三次——那个会话里 agent 就是这么验它的页面的。 */
let pageFile = "";
const version = (n: number) => PAGE.replaceAll("鹈鹕骑车", `第${n}版`);
function fakeModel() {
	return createServer((req: IncomingMessage, res: ServerResponse) => {
		let body = "";
		req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages;
			// 环境信息会跟在人说的话后面另起一条，暗号要从它前面那条找。
			const last = messages.map((message) => JSON.stringify(message.content)).findLast((content) => !content.includes("<env>")) ?? "";
			const reopened = /"tool_use_id":"reopen-(\d)"/.exec(last);
			if (reopened) {
				const n = Number(reopened[1]);
				if (n === 3) return reply(res, { text: "第三版好了。" });
				void writeFile(pageFile, version(n + 1)).then(() =>
					// 第二次之前先说一句话：后面那张卡就落在这一轮的另一段过程里。
					reply(res, { ...(n === 1 ? { text: "腿的动画不对，改一下再看。" } : {}), tool: { id: `reopen-${n + 1}`, name: "browser_open", input: { url: "pelican.html", newTab: true } } }));
				return;
			}
			if (last.includes("tool_result")) { results.push(last); return reply(res, { text: "好了。" }); }
			if (last.includes("REOPEN_LOCAL")) {
				void writeFile(pageFile, version(1)).then(() => reply(res, { tool: { id: "reopen-1", name: "browser_open", input: { url: "pelican.html", newTab: true } } }));
				return;
			}
			if (last.includes("OPEN_LOCAL")) return reply(res, { tool: { id: "open-1", name: "browser_open", input: { url: "pelican.html" } } });
			if (last.includes("PREVIEW_LOCAL")) return reply(res, { tool: { id: "preview-1", name: "preview", input: { path: "pelican.html", title: "鹈鹕" } } });
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

async function seed(home: string, modelPort: number): Promise<string> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	const file = join(cwd, "pelican.html");
	await writeFile(file, PAGE);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "本地网页", cwd, projectId, projectName: "本地网页", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "画一只骑车的鹈鹕。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: `做好了：[pelican.html](${file})` }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 900, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model", mcpServers: [], hooks: [], permissionMode: "full", thinking: "off", projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		screenshot: { enabled: false, shortcut: "" },
		projects: [{ id: projectId, path: cwd, name: "本地网页", pinned: true, lastOpenedAt: 1 }],
	}));
	return file;
}

let failures = 0;
let passes = 0;
const check = (label: string, passed: boolean, evidence: unknown) => {
	if (passed) passes++; else failures++;
	console.log(`  ${passed ? "✓" : "✗"} ${label}\n      ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`);
};

type Tab = { id: string; sessionId: string | null; url: string; error?: string };
const state = (app: RunningApp) => app.evaluate<{ tabs: Tab[]; activeId: string | null }>("window.plume.browser.state()");
const active = async (app: RunningApp) => { const s = await state(app); return s.tabs.find((tab) => tab.id === s.activeId); };
/** 网页里真画出来的标题：从 `<webview>` 里读，不是读状态。 */
const heading = (app: RunningApp, id: string) =>
	app.evaluate<string>(`document.querySelector('[data-browser-page="${id}"]').executeJavaScript("document.querySelector('#title')?.textContent ?? document.body.innerText.slice(0, 80)")`).catch((error: Error) => `读不到：${error.message}`);
const toasts = (app: RunningApp) => app.evaluate<string[]>(`[...document.querySelectorAll('[data-ly-toaster] [role="alert"]')].map((e) => e.textContent)`);
const shot = async (app: RunningApp, name: string) => {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
};
/** 等一个活动标签停在 `ly-preview` 上、标题画出来。 */
async function settledOnPage(app: RunningApp): Promise<Tab | undefined> {
	await until(app, `window.plume.browser.state().then((s) => s.tabs.some((t) => t.id === s.activeId && t.url.startsWith("ly-preview://") && !t.loading))`, 900);
	const tab = await active(app);
	if (tab) await until(app, `document.querySelector('[data-browser-page="${tab.id}"]')`, 600);
	await pause(800);
	return tab;
}
async function typeAddress(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(ADDRESS)});el.focus();el.select();})()`);
	await app.send("Input.insertText", { text });
	await pause(600);
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
}
async function send(app: RunningApp, text: string) {
	await app.evaluate(`(()=>{const field=document.querySelector("main textarea");const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(300);
	await app.evaluate(`document.querySelector("main textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))`);
	await until(app, `document.querySelector('button[aria-label="停止"]')`, 600).catch(() => {});
	await until(app, `!document.querySelector('button[aria-label="停止"]')`, 1800);
	await pause(1000);
}

await mkdir(OUT_DIR, { recursive: true });
const model = fakeModel();
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelAddress = model.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("model server has no port");
// 一个确定没人听的端口：起一台再关掉。
const closed = createServer();
await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
const deadPort = (closed.address() as { port: number }).port;
await closeListeningServer(closed);

const home = await mkdtemp(join(tmpdir(), "plume-local-page-"));
const file = await seed(home, modelAddress.port);
pageFile = file;
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;

try {
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(1000);
	await shot(app, "00_对话里的文件链接");

	console.log("\n一、对话里 .html 链接旁的「在内置浏览器打开」");
	await hover(app, "[data-ly-file-link] a");
	await pause(600);
	await shot(app, "01_链接操作条");
	await click(app, '[data-ly-file-actions-bar] button[aria-label="在内置浏览器打开"]');
	const fromLink = await settledOnPage(app);
	check("打开的是预览目录里的副本", fromLink?.url.startsWith(`ly-preview://${SESSION}/`) === true, fromLink?.url);
	check("网页真的画出来了", (await heading(app, fromLink!.id)) === "鹈鹕骑车", await heading(app, fromLink!.id));
	await shot(app, "02_链接打开");

	console.log("\n二、地址栏输入文件路径");
	await typeAddress(app, file);
	await pause(1500);
	const fromBar = await settledOnPage(app);
	check("地址栏的路径也换成了副本，同一个文件就是同一个地址", fromBar?.url.startsWith(`ly-preview://${SESSION}/`) === true && fromBar.url === fromLink?.url, { fromBar: fromBar?.url, fromLink: fromLink?.url });
	check("网页画出来了", (await heading(app, fromBar!.id)) === "鹈鹕骑车", await heading(app, fromBar!.id));
	await typeAddress(app, `file://${file}`);
	await pause(1500);
	const fromFileUrl = await settledOnPage(app);
	check("file:// 也一样", fromFileUrl?.url.startsWith("ly-preview://") === true && (await heading(app, fromFileUrl!.id)) === "鹈鹕骑车", fromFileUrl?.url);
	check("全程没有弹出错误提示", (await toasts(app)).length === 0, await toasts(app));
	await shot(app, "03_地址栏打开");

	console.log("\n三、连不上的地址：只在面板里说，不再弹 IPC 报错");
	await typeAddress(app, `http://127.0.0.1:${deadPort}/pelican-plane.html?v=6`);
	await until(app, `document.querySelector('[data-browser-panel] p[role="status"]')`, 900);
	await pause(1200);
	const line = await app.evaluate<string>(`document.querySelector('[data-browser-panel] p[role="status"]').textContent`);
	check("面板里写着连接被拒", line.includes("ERR_CONNECTION_REFUSED"), line);
	const afterRefused = await toasts(app);
	check("没有弹出 Error invoking remote method", afterRefused.length === 0, afterRefused);
	await shot(app, "04_连接被拒只在面板里");

	console.log("\n四、agent：browser_open 传相对路径");
	await send(app, "OPEN_LOCAL 打开刚才那个页面");
	// 没传 newTab：复用这个会话当前那一页，也就是上一步停在连接被拒上的那一页。
	const agentTab = (await state(app)).tabs.find((tab) => tab.sessionId === SESSION);
	check("工具结果里没有报错", results.length === 1 && !/只允许|is_error":true/.test(results[0]!), results[0]?.slice(0, 160));
	check("agent 的标签从连接被拒换到了副本上", agentTab?.url.startsWith(`ly-preview://${SESSION}/`) === true && !agentTab.error, agentTab);
	check("网页画出来了", (await heading(app, agentTab!.id)) === "鹈鹕骑车", await heading(app, agentTab!.id));
	await until(app, "document.querySelector('[data-browser-card]')", 600);
	check("agent 打开的网页就在侧栏里，没等人去点", await app.evaluate<boolean>(`!!document.querySelector('[data-dock-pane="browser:${agentTab!.id}"]:not([inert])')`), "");
	check("对话里那张卡只有一行，没有缩略图", await app.evaluate<boolean>(`(() => { const card = document.querySelector('main [data-browser-card]'); return !!card && !card.querySelector('img') && card.getBoundingClientRect().height < 60; })()`), await app.evaluate<number>(`document.querySelector('main [data-browser-card]')?.getBoundingClientRect().height ?? 0`));
	await shot(app, "05_agent打开");

	console.log("\n五、agent：preview 传 path");
	await send(app, "PREVIEW_LOCAL 放进对话里");
	check("工具结果是「已展示」", results.length === 2 && results[1]!.includes("已在对话中展示"), results[1]?.slice(0, 160));
	const frame = await app.evaluate<string>(`document.querySelector('main [data-ly-preview] iframe')?.src ?? ""`);
	check("对话里出现了预览卡片", frame.startsWith(`ly-preview://${SESSION}/`), frame);
	await pause(1500);
	await shot(app, "06_preview卡片");

	console.log("\n五½、预览卡「在侧栏中打开」连点两下：一个标签，按下之后有「正在打开」");
	const previewUrl = frame.replace(/#.*$/, "");
	const button = 'main [data-ly-preview] button:is([aria-label="在侧栏中打开"], [aria-label="正在侧栏中打开…"])';
	await hover(app, "main [data-ly-preview] iframe");
	await pause(400);
	// 打包版里这一段很短，点完再去读多半已经过去了：先挂上观察，按钮说过的每一句都记下来。
	await app.evaluate(`(() => { window.__labels = []; const target = document.querySelector('main [data-ly-preview]'); new MutationObserver(() => { const label = document.querySelector(${JSON.stringify(button)})?.getAttribute("aria-label"); if (label && window.__labels.at(-1) !== label) window.__labels.push(label); }).observe(target, { subtree: true, attributes: true, attributeFilter: ["aria-label"] }); })()`);
	await click(app, button);
	await click(app, button).catch(() => {});
	await settledOnPage(app);
	await pause(1500);
	const copies = (await state(app)).tabs.filter((tab) => tab.url.startsWith(previewUrl));
	const pressed = await app.evaluate<string[]>("window.__labels");
	check("按下之后按钮说过「正在侧栏中打开…」", pressed.includes("正在侧栏中打开…"), pressed);
	check("连点两下只有一个标签", copies.length === 1, copies.map((tab) => tab.url));
	check("打开以后按钮回到原样", (await app.evaluate<string>(`document.querySelector(${JSON.stringify(button)})?.getAttribute("aria-label") ?? ""`)) === "在侧栏中打开", "");
	await click(app, button);
	await pause(2000);
	check("隔一会儿再点，仍是那一个标签", (await state(app)).tabs.filter((tab) => tab.url.startsWith(previewUrl)).length === 1, (await state(app)).tabs.length);
	await shot(app, "06b_预览只开一个标签");

	console.log("\n六、同一轮里改三次、开三个新标签：只留一张卡，画最后一版");
	const cardsBefore = await app.evaluate<number>(`document.querySelectorAll('[data-browser-card]').length`);
	await send(app, "REOPEN_LOCAL 腿再改改");
	// 文件的副本地址固定，三次 `newTab: true` 都落回人早先从链接打开的那一个标签。
	const agentTabs = (await state(app)).tabs.filter((tab) => tab.url === fromLink?.url);
	const newest = agentTabs.at(-1)!;
	check("三次带 newTab 的打开都落在同一个标签里，和人从链接打开的是同一个", agentTabs.length === 1, { tabs: (await state(app)).tabs.map((tab) => tab.url), link: fromLink?.url });
	check("地址没变，网页却是最新那一版（没有被缓存住）", (await heading(app, newest.id)) === "第3版", await heading(app, newest.id));
	const cards = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-browser-card]')].map((card) => card.getAttribute('aria-label'))`);
	check("这一轮只多了一张卡", cards.length === cardsBefore + 1, { cardsBefore, cards });
	check("留下的是最后一版", cards.at(-1) === "第3版", cards);
	await app.evaluate(`[...document.querySelectorAll('main [data-browser-card]')].at(-1)?.scrollIntoView({ block: "center" })`);
	await pause(1200);
	await shot(app, "07_同一轮只留一张卡");

	console.log("\n七、整个应用关掉重开");
	await stopRecording();
	stopRecording = undefined;
	await app.stop();
	app = await startApp({ port: PORT, reuseHome: home });
	stopRecording = await startRecording(PORT, frames);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await pause(1500);
	await click(app, "[data-browser-card] button", "在浏览器面板中查看");
	const reopened = await settledOnPage(app);
	check("重启后点卡片，副本照样打开", reopened?.url === agentTab?.url, { reopened: reopened?.url, before: agentTab?.url });
	// 同一个文件只有一份副本：前一轮那张卡打开的也是它，所以是第三版。
	check("网页画出来了，是这个文件最新的那一版，没有连接被拒", (await heading(app, reopened!.id)) === "第3版" && !reopened?.error, await heading(app, reopened!.id));
	await shot(app, "08_重启后打开");
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
const video = join(OUT_DIR, `${STAMP}_本地网页不起服务_${passes}of${total}.mp4`);
await encode(frames, video, undefined, 1500);
console.log(`\n${passes}/${total} 通过；录像 ${video}`);
process.exit(failures === 0 ? 0 : 1);
