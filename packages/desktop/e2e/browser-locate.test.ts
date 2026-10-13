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
 * agent 用 read 给的 ref 点元素，点之前确认点得到，等条件成立而不是睡固定时长。
 *
 * 量的是两头：点得到的要点中，而且不白等；点不到的要说清楚为什么——从前点在遮罩上也报成功。
 */
let app: RunningApp;
let server: Server;
let port = 0;
let step = 0;
let asked = 0;
const results: { text: string; isError: boolean; ms: number }[] = [];
const seen = new Set<string>();
function answer(res: ServerResponse, tool?: { name: string; input: object }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: `l-${step}`, role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `call-${step}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "LOCATE_DONE" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } });
	emit("message_stop", {}); res.end();
}
const act = (input: object) => ({ name: "browser_act", input });
const OUT = act({ action: "eval", expression: "out.textContent" });
const SCRIPT = (base: string) => [
	{ name: "skill", input: { name: "browser" } },
	{ name: "browser_open", input: { url: `${base}/`, newTab: true } },
	act({ action: "click", ref: "e1" }),
	OUT,
	act({ action: "click", ref: "e2" }),
	act({ action: "click", ref: "e3" }),
	act({ action: "click", ref: "e4" }),
	act({ action: "click", ref: "e3" }),
	OUT,
	act({ action: "click", ref: "e5" }),
	act({ action: "wait", selector: "#late" }),
	act({ action: "read" }),
	act({ action: "click", ref: "e9" }),
	OUT,
	act({ action: "type", ref: "e6", text: "a@b.c" }),
	act({ action: "click", ref: "e8" }),
	act({ action: "wait", text: "ARRIVED" }),
	act({ action: "click", ref: "e1" }),
	act({ action: "read" }),
	act({ action: "wait", text: "NEVER", timeout: 500 }),
];
// 文档顺序就是编号顺序：go e1、off e2、covered e3、unmask e4、spawn e5、mail e6、pw e7、next e8。
const PAGE = `<!doctype html><title>LOCATE</title>
<button id="go" onclick="out.textContent='go clicked'">Go</button>
<button id="off" disabled onclick="out.textContent='off clicked'">Off</button>
<span style="position:relative;display:inline-block">
	<button id="covered" onclick="out.textContent='covered clicked'">Covered</button>
	<div id="mask" style="position:absolute;inset:0;background:#0002"></div>
</span>
<button id="unmask" onclick="setTimeout(()=>mask.remove(),500)">Unmask</button>
<button id="spawn" onclick="setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='Late';b.onclick=()=>out.textContent='late clicked';document.body.append(b)},500)">Spawn</button>
<label>邮箱 <input id="mail" type="email"></label>
<input id="pw" type="password" value="secret123">
<a id="next" href="/next">Next</a>
<p id="out">-</p>`;
before(async () => {
	server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			if (req.url === "/next") { res.end(`<!doctype html><title>NEXT</title><button>Here</button><script>setTimeout(()=>document.body.append('ARRIVED'),600)</script>`); return; }
			res.end(PAGE);
			return;
		}
		let raw = ""; req.on("data", (data) => { raw += data; });
		req.on("end", () => {
			const body = JSON.parse(raw);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!body.tools?.length) { answer(res); return; }
			// 扫全部消息而不只看最后一条：同样的调用重复几次后，循环会在结果后面再追加一句提醒。
			for (const message of body.messages ?? []) if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "tool_result" && !seen.has(part.tool_use_id)) {
				seen.add(part.tool_use_id);
				const text = Array.isArray(part.content) ? part.content.map((c: { text?: string }) => c.text ?? "").join("") : String(part.content);
				results.push({ text, isError: part.is_error === true, ms: Date.now() - asked });
			}
			asked = Date.now();
			answer(res, SCRIPT(`http://127.0.0.1:${port}`)[step++]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string"); port = address.port;
	app = await startApp({ port: 9622, seed: async (home) => {
		await seedInteractions(home, port);
		const path = join(home, "settings.json"); const settings = JSON.parse(await readFile(path, "utf8"));
		settings.alwaysAllow = [`http://127.0.0.1:${port}`];
		settings.screenshot = { enabled: false, shortcut: "" };
		await writeFile(path, JSON.stringify(settings));
	} });
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });

test("an agent clicks by ref only what it can reach, says why when it cannot, and waits on conditions across navigation", async (t) => {
	await openSession(app, "qa-short");
	await app.evaluate(`window.plume.agent.prompt('qa-short',[{type:'text',text:'BROWSER_LOCATE'}])`);
	await driver(app).until(`document.body.innerText.includes('LOCATE_DONE')`, 90_000);
	t.diagnostic(JSON.stringify(results.map((r) => ({ ms: r.ms, isError: r.isError, text: r.text.replace(/\s+/g, " ").slice(-160) }))));
	const [, open, go, afterGo, disabled, covered, , uncovered, afterUncovered, , waited, reread, late, afterLate, typed, next, arrived, stale, nextRead, never] = results;
	// 一行一个元素，带 ref；密码框只说填过，不回显。
	assert.match(open.text, /"e1 button #go Go"/);
	assert.match(open.text, /"e2 button #off Off \[disabled\]"/);
	assert.match(open.text, /"e6 input:email #mail 邮箱"/);
	assert.match(open.text, /"e7 input:password #pw \[filled\]"/);
	assert.doesNotMatch(open.text, /secret123/);
	assert.match(open.text, /"e8 link #next Next"/);
	assert.equal(go.isError, false, go.text);
	assert.match(afterGo.text, /go clicked/);
	// 点不到的说出原因，而不是报成功。
	assert.equal(disabled.isError, true);
	assert.match(disabled.text, /禁用/);
	assert.equal(covered.isError, true);
	assert.match(covered.text, /被 div#mask 挡住/);
	// 遮罩半秒后退场：等它，点中，而不是失败。
	assert.equal(uncovered.isError, false, uncovered.text);
	assert.ok(uncovered.ms > 300 && uncovered.ms < 3_000, `uncovered click took ${uncovered.ms}ms`);
	assert.match(afterUncovered.text, /covered clicked/);
	assert.equal(waited.isError, false, waited.text);
	assert.ok(waited.ms > 300 && waited.ms < 3_000, `wait took ${waited.ms}ms`);
	// 再读一遍：老元素保留老编号，新元素接着编。
	assert.match(reread.text, /"e1 button #go Go"/);
	assert.match(reread.text, /"e9 button #late Late"/);
	assert.equal(late.isError, false, late.text);
	assert.match(afterLate.text, /late clicked/);
	assert.equal(typed.isError, false, typed.text);
	assert.match(next.text, /"navigated": true/);
	// 跨了一次跳转的等待。
	assert.equal(arrived.isError, false, arrived.text);
	assert.ok(arrived.ms > 200 && arrived.ms < 5_000, `wait across navigation took ${arrived.ms}ms`);
	// 上一页的 ref 不会点到这一页的元素上，这一页的编号也不从 e1 重来。
	assert.equal(stale.isError, true);
	assert.match(stale.text, /e1 已经不在这一页上/);
	assert.match(nextRead.text, /"e10 button Here"/);
	assert.equal(never.isError, true);
	assert.match(never.text, /条件没有满足/);
	assert.ok(never.ms < 3_000, `timed-out wait took ${never.ms}ms`);
});
