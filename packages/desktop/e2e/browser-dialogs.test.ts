import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { openSession } from "./drive.ts";
import { driver } from "./record.ts";

/*
 * agent 操作时页面弹出的 alert、confirm、离开页面提示。
 *
 * 不接管时页面停在对话框那一句上，agent 之后每一步都等满 15 秒报「页面没有响应」；离开提示则让打开新页
 * 等满 30 秒。所以每一步都量耗时。两次调用之间弹出的那一个，要由下一次调用收走并让页面继续。
 */
let app: RunningApp;
let server: Server;
let port = 0;
let step = 0;
let asked = 0;
const results: { text: string; isError: boolean; ms: number }[] = [];
function answer(res: ServerResponse, tool?: { name: string; input: object }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `d-${step}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${step}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "DIALOG_DONE" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } });
	emit("message_stop", {}); res.end();
}
const OUT = { name: "browser_act", input: { action: "eval", expression: "out.textContent" } };
const SCRIPT = (base: string) => [
	{ name: "skill", input: { name: "browser" } },
	{ name: "browser_open", input: { url: `${base}/`, newTab: true } },
	{ name: "browser_act", input: { action: "click", selector: "#a" } },
	OUT,
	{ name: "browser_act", input: { action: "click", selector: "#c" } },
	OUT,
	{ name: "browser_act", input: { action: "click", selector: "#c", dialog: "accept" } },
	OUT,
	{ name: "browser_act", input: { action: "click", selector: "#later" } },
	OUT,
	{ name: "browser_act", input: { action: "type", selector: "#draft", text: "草稿" } },
	{ name: "browser_act", input: { action: "press", text: "Enter" } },
	{ name: "browser_open", input: { url: `${base}/other` } },
	{ name: "browser_act", input: { action: "eval", expression: "document.title + ' / ' + draft.value" } },
	{ name: "browser_open", input: { url: `${base}/other`, dialog: "accept" } },
];
/** 点完 #later 后这一步晚些再发：alert 在没有调用进行时弹出，由下一次调用收走。 */
const AFTER_LATER = 9;
before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			if (req.url === "/other") { res.end(`<!doctype html><title>OTHER</title><h1>OTHER_PAGE</h1>`); return; }
			res.end(`<!doctype html><title>DIALOGS</title>
<button id="a" onclick="alert('你好');out.textContent='after alert'">alert</button>
<button id="c" onclick="out.textContent='confirm='+confirm('确定删除吗')">confirm</button>
<button id="later" onclick="setTimeout(()=>{alert('稍后弹出');out.textContent='after later alert'},300)">later</button>
<input id="draft" onkeydown="window.onbeforeunload=(e)=>{e.preventDefault();return ''}">
<p id="out">-</p>`);
			return;
		}
		let raw = ""; req.on("data", (data) => { raw += data; });
		req.on("end", () => {
			const body = JSON.parse(raw);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!body.tools?.length) { answer(res); return; }
			const last = body.messages?.at(-1)?.content;
			if (Array.isArray(last)) for (const part of last) if (part.type === "tool_result") {
				const text = Array.isArray(part.content) ? part.content.map((c: { text?: string }) => c.text ?? "").join("") : String(part.content);
				results.push({ text, isError: part.is_error === true, ms: Date.now() - asked });
			}
			const next = () => { asked = Date.now(); answer(res, SCRIPT(`http://127.0.0.1:${port}`)[step++]); };
			if (step === AFTER_LATER) setTimeout(next, 1_000); else next();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string"); port = address.port;
	app = await startApp({ port: 9621, seed: async (home) => {
		await seedInteractions(home, port);
		const path = join(home, "settings.json"); const settings = JSON.parse(await readFile(path, "utf8"));
		settings.alwaysAllow = [`http://127.0.0.1:${port}`];
		settings.screenshot = { enabled: false, shortcut: "" };
		await writeFile(path, JSON.stringify(settings));
	} });
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });

test("dialogs a page raises while the agent works are answered and reported, and none of them stalls the next step", async (t) => {
	await openSession(app, "qa-short");
	await app.evaluate(`window.plume.agent.prompt('qa-short',[{type:'text',text:'BROWSER_DIALOGS'}])`);
	await driver(app).until(`document.body.innerText.includes('DIALOG_DONE')`, 90_000);
	t.diagnostic(JSON.stringify(results.map((r) => ({ ms: r.ms, isError: r.isError, text: r.text.replace(/\s+/g, " ").slice(-120) }))));
	const [, , alert, afterAlert, dismissed, afterDismissed, accepted, afterAccepted, , afterLater, , , stay, stayed, leave] = results;
	for (const result of results) assert.equal(result.isError, false, result.text);
	for (const result of results.slice(1)) assert.ok(result.ms < 5_000, `a step took ${result.ms}ms: ${result.text.slice(-120)}`);
	assert.match(alert.text, /alert「你好」，已确定/);
	assert.match(afterAlert.text, /after alert/);
	// confirm 默认取消，并告诉 agent 怎样才算确认。
	assert.match(dismissed.text, /confirm「确定删除吗」，已取消/);
	assert.match(dismissed.text, /dialog: "accept"/);
	assert.match(afterDismissed.text, /confirm=false/);
	assert.match(accepted.text, /已确认/);
	assert.match(afterAccepted.text, /confirm=true/);
	// 调用之间弹出的 alert：下一次调用收走，页面接着往下跑，说明里也有它。
	assert.match(afterLater.text, /after later alert/);
	assert.match(afterLater.text, /alert「稍后弹出」，已确定/);
	// 离开提示：默认留下，草稿还在；带 accept 才离开。
	assert.match(stay.text, /已留在原页没有离开/);
	assert.match(stayed.text, /DIALOGS \/ 草稿/);
	assert.match(leave.text, /已确认离开/);
	assert.match(leave.text, /OTHER_PAGE/);
});
