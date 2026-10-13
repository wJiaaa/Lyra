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
 * agent 在网页之间走：点链接过去、后退、前进、页内跳转后退、刷新。
 *
 * 每一步都要交回落地之后的那一页，而且不能白等：点链接曾经每次卡 15 秒报「页面没有响应」（等的那一帧
 * 在一张正被卸掉的文档里），页内跳转没有加载事件，等加载就会等满时限。
 */
let app: RunningApp;
let server: Server;
let port = 0;
let step = 0;
let loads = 0;
const results: { text: string; isError: boolean; ms: number }[] = [];
let asked = 0;
function answer(res: ServerResponse, tool?: { name: string; input: object }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `h-${step}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${step}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "HISTORY_DONE" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } });
	emit("message_stop", {}); res.end();
}
const SCRIPT = (base: string) => [
	{ name: "skill", input: { name: "browser" } },
	{ name: "browser_open", input: { url: `${base}/a`, newTab: true } },
	{ name: "browser_act", input: { action: "click", selector: "#next" } },
	{ name: "browser_act", input: { action: "back" } },
	{ name: "browser_act", input: { action: "forward" } },
	{ name: "browser_act", input: { action: "eval", expression: "history.pushState({}, '', '/b?inpage=1'), location.href" } },
	{ name: "browser_act", input: { action: "back" } },
	{ name: "browser_act", input: { action: "reload" } },
	{ name: "browser_act", input: { action: "back" } },
	{ name: "browser_act", input: { action: "back" } },
	{ name: "browser_open", input: { url: "http://127.0.0.1:1/" } },
];
before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET") {
			loads++;
			const name = (req.url ?? "/").split("?")[0].slice(1).toUpperCase() || "A";
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			res.end(`<!doctype html><title>${name}</title><h1>PAGE_${name} load ${loads}</h1><a id="next" href="/b">B</a>`);
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
			asked = Date.now();
			answer(res, SCRIPT(`http://127.0.0.1:${port}`)[step++]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string"); port = address.port;
	app = await startApp({ port: 9619, seed: async (home) => {
		await seedInteractions(home, port);
		const path = join(home, "settings.json"); const settings = JSON.parse(await readFile(path, "utf8"));
		settings.alwaysAllow = [`http://127.0.0.1:${port}`, "http://127.0.0.1:1"];
		settings.screenshot = { enabled: false, shortcut: "" };
		await writeFile(path, JSON.stringify(settings));
	} });
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });

test("an agent walks a tab's history and every step hands back the page it landed on, without waiting out a timeout", async (t) => {
	await openSession(app, "qa-short");
	await app.evaluate(`window.plume.agent.prompt('qa-short',[{type:'text',text:'BROWSER_HISTORY'}])`);
	await driver(app).until(`document.body.innerText.includes('HISTORY_DONE')`, 60_000);
	t.diagnostic(JSON.stringify(results.map((r) => ({ ms: r.ms, isError: r.isError, text: r.text.replace(/\s+/g, " ").slice(0, 120) }))));
	const [, open, click, back, forward, , inPage, reload, backAgain, atStart, unreachable] = results;
	assert.match(open.text, /PAGE_A load 1/);
	// 点链接：交回的是新页的地址，几百毫秒而不是 15 秒。
	assert.equal(click.isError, false, click.text);
	assert.match(click.text, /"navigated": true/);
	assert.match(click.text, /\/b"/);
	assert.ok(click.ms < 5_000, `click took ${click.ms}ms`);
	// 后退、前进换了文档：读回来的就是那一页，不必再 read。
	assert.match(back.text, /PAGE_A load 3/);
	assert.match(forward.text, /PAGE_B load 4/);
	// 页内跳转后退：没有加载事件，也不能白等。
	assert.equal(inPage.isError, false, inPage.text);
	assert.match(inPage.text, /PAGE_B load 4/);
	assert.ok(inPage.ms < 5_000, `in-page back took ${inPage.ms}ms`);
	// 刷新是真的重新加载了一次。
	assert.match(reload.text, /PAGE_B load 5/);
	assert.match(backAgain.text, /PAGE_A load 6/);
	assert.equal(atStart.isError, true);
	assert.match(atStart.text, /没有上一页/);
	// 打不开的站点：说没打开、为什么，而不是交回一张空的 chrome-error 页。
	assert.equal(unreachable.isError, true, unreachable.text);
	assert.match(unreachable.text, /页面没有打开：ERR_UNSAFE_PORT/);
});
