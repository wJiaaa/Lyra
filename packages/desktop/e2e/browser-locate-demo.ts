/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * agent 用 ref 点网页：点得到的点中，被遮住的说出被谁遮住，等遮罩退场再点；等元素出现、跨跳转等文字。边验边录。
 *
 * 用法：node --experimental-strip-types e2e/browser-locate-demo.ts [输出目录]
 */
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp } from "./app.ts";
import { openSession } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { driver, encode, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume浏览器定位测试");
const PORT = 9623;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

const act = (input: object) => ({ name: "browser_act", input });
let base = "";
const SCRIPT = () => [
	{ name: "skill", input: { name: "browser" } },
	{ name: "browser_open", input: { url: `${base}/`, newTab: true } },
	act({ action: "click", ref: "e1" }),
	act({ action: "click", ref: "e2" }),
	act({ action: "click", ref: "e3" }),
	act({ action: "click", ref: "e2" }),
	act({ action: "click", ref: "e4" }),
	act({ action: "wait", selector: "#late" }),
	act({ action: "read" }),
	act({ action: "click", ref: "e7" }),
	act({ action: "type", ref: "e5", text: "a@b.c" }),
	act({ action: "click", ref: "e6" }),
	act({ action: "wait", text: "ARRIVED" }),
];
const PAGE = `<!doctype html><title>LOCATE</title><body style="font:16px system-ui;padding:16px;display:grid;gap:12px;justify-items:start">
<button id="go" onclick="out.textContent='go clicked'">Go</button>
<span style="position:relative;display:inline-block">
	<button id="covered" onclick="out.textContent='covered clicked'">Covered</button>
	<div id="mask" style="position:absolute;inset:-6px;background:#c0392b88;border-radius:6px"></div>
</span>
<button id="unmask" onclick="setTimeout(()=>mask.remove(),2500)">Unmask (2.5s)</button>
<button id="spawn" onclick="setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='Late';b.onclick=()=>out.textContent='late clicked';spawn.after(b)},2000)">Spawn (2s)</button>
<label>邮箱 <input id="mail" type="email"></label>
<a id="next" href="/next">Next</a>
<p id="out">-</p>`;

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
const server = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		if (req.url === "/next") { res.end(`<!doctype html><title>NEXT</title><body style="font:16px system-ui;padding:16px"><button>Here</button><script>setTimeout(()=>document.body.append(' ARRIVED'),2000)</script>`); return; }
		res.end(PAGE);
		return;
	}
	let raw = ""; req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		const body = JSON.parse(raw);
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (!body.tools?.length) { answer(res); return; }
		for (const message of body.messages ?? []) if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "tool_result" && !seen.has(part.tool_use_id)) {
			seen.add(part.tool_use_id);
			const text = Array.isArray(part.content) ? part.content.map((c: { text?: string }) => c.text ?? "").join("") : String(part.content);
			results.push({ text, isError: part.is_error === true, ms: Date.now() - asked });
		}
		// 每一步之间停一秒，录下来的画面看得清。
		setTimeout(() => { asked = Date.now(); answer(res, SCRIPT()[step++]); }, 1_000);
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const app = await startApp({ port: PORT, scaleFactor: 2, seed: async (home) => {
	await seedInteractions(home, Number(new URL(base).port));
	const path = join(home, "settings.json"); const settings = JSON.parse(await readFile(path, "utf8"));
	settings.alwaysAllow = [base];
	settings.screenshot = { enabled: false, shortcut: "" };
	await writeFile(path, JSON.stringify(settings));
} });
const frames: Frame[] = [];
try {
	await openSession(app, "qa-short");
	const stop = await startRecording(PORT, frames);
	await app.evaluate(`window.plume.agent.prompt('qa-short',[{type:'text',text:'BROWSER_LOCATE'}])`);
	await driver(app).until(`document.body.innerText.includes('LOCATE_DONE')`, 120_000);
	await new Promise((resolve) => setTimeout(resolve, 1_500));
	await stop();
	const [, open, go, coveredFirst, unmask, coveredLater, spawn, waited, reread, late, typed, next, arrived] = results;
	check("read 给出带 ref 的一行一个元素", /"e2 button #covered Covered"/.test(open?.text ?? ""), open?.text.slice(-300) ?? "");
	check("e1 点中", go?.isError === false, go?.text ?? "");
	check("被遮住时说出是谁遮住", coveredFirst?.isError === true && /被 div#mask 挡住/.test(coveredFirst.text), coveredFirst?.text ?? "");
	check("Unmask 点中", unmask?.isError === false, unmask?.text ?? "");
	check(`遮罩 2.5 秒后退场，等它退场再点中（${coveredLater?.ms}ms）`, coveredLater?.isError === false && coveredLater.ms > 800 && coveredLater.ms < 3_000, coveredLater?.text ?? "");
	check("Spawn 点中", spawn?.isError === false, spawn?.text ?? "");
	check(`等到 #late 出现（${waited?.ms}ms）`, waited?.isError === false && waited.ms > 500, waited?.text ?? "");
	check("新元素接着编号 e7", /"e7 button #late Late"/.test(reread?.text ?? ""), reread?.text.slice(-300) ?? "");
	check("e7 点中", late?.isError === false, late?.text ?? "");
	check("输入邮箱", typed?.isError === false, typed?.text ?? "");
	check("点链接换页", /"navigated": true/.test(next?.text ?? ""), next?.text ?? "");
	check(`跨跳转等到 ARRIVED（${arrived?.ms}ms）`, arrived?.isError === false && arrived.ms > 500, arrived?.text ?? "");
	const passed = checks.filter((entry) => entry.ok).length;
	await mkdir(OUT_DIR, { recursive: true });
	const out = join(OUT_DIR, `${STAMP}_ref点击与等待_${passed}of${checks.length}.mp4`);
	await encode(frames, out, 30, 1_200);
	console.log(`\n${passed}/${checks.length} 通过，视频：${out}`);
} finally { await app.stop(); await closeListeningServer(server); }
