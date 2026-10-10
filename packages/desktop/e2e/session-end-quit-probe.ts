/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 退出应用时，SessionEnd 钩子来不来得及跑。
 *
 * `before-quit` 里 await 的东西都发生在 Electron 走了以后，所以 `main.ts` 第一次退出先拦下来，
 * 等各会话收尾、最多 2 秒。这里量两件事，都只能在真进程上量：
 *   1. 一条要 800ms 的同步 SessionEnd 钩子写下了 `quit`，写的那一刻 Electron 还活着——是等它了，
 *      不是它碰巧从脱离的进程组里活了下来；
 *   2. 一条要 5 秒的钩子拖不住退出：进程在 2 秒上下就没了。
 *
 * 钩子是 `node -e` 写一行 JSON 到 profile 里的 trace 文件；模型是本地一个假的 Anthropic 端点。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/session-end-quit-probe.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume钩子SessionEnd测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9815;
const INSPECT = 9816;
const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

function model() {
	return createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "好的，收到。" } });
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } });
			emit("message_stop", {});
			res.end();
		});
	});
}

type Line = { event: string; reason?: string; at: number };

/** 一条钩子：等 `delayMs` 再把事件名、原因和时刻追加到 trace。 */
function hook(trace: string, delayMs = 0) {
	const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);setTimeout(()=>require('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:i.hook_event_name,reason:i.reason??i.source,at:Date.now()})+'\\n'),${delayMs})});`;
	return { hooks: [{ type: "process", command: process.execPath, args: ["-e", script] }] };
}

async function writeSettings(home: string, modelPort: number, endDelayMs: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const trace = join(home, "trace.jsonl");
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: { events: { SessionStart: [hook(trace)], Stop: [hook(trace)], SessionEnd: [hook(trace, endDelayMs)] } },
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "退出收尾", pinned: true, lastOpenedAt: 1 }],
	}));
}

async function seed(home: string): Promise<void> {
	const cwd = join(home, "project");
	await mkdir(cwd, { recursive: true });
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: "quit-end", title: "退出收尾", cwd, projectId, projectName: "退出收尾", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 0, usage, seq: 1 };
	seedSessions(home, [{ meta, records: [{ type: "meta", meta, seq: 0, ts: 1 }] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1180, height: 820, x: 40, y: 40 }));
}

const server = model();
const frames: Frame[] = [];
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const home = await mkdtemp(join(tmpdir(), "ly-session-end-"));
const trace = join(home, "trace.jsonl");
const lines = async (): Promise<Line[]> => (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line);

/** 起应用、进会话、说一句、等回复，然后从主进程退出。返回退出那一刻和进程真正没了的那一刻。 */
async function talkThenQuit(name: string): Promise<{ quitAt: number; goneAt: number }> {
	const running = await startApp({ port: PORT, inspectPort: INSPECT, reuseHome: home });
	app = running;
	stopRecording = await startRecording(PORT, frames);
	await running.evaluate("document.fonts.ready");
	const until = async (expression: string, ms = 30_000) => {
		for (let i = 0; i < ms / 100; i++) {
			if (await running.evaluate(`Boolean(${expression})`)) return;
			await pause(100);
		}
		throw new Error(`UI condition not reached: ${expression}`);
	};
	await until(`document.body.innerText.includes("退出收尾")`);
	await running.evaluate(`[...document.querySelectorAll("a,button,[role=button]")].find((node)=>node.textContent?.trim()==="退出收尾")?.click()`);
	await until(`document.querySelector("main textarea")`);
	await pause(800);
	await running.evaluate(`(()=>{const field=document.querySelector("main textarea");field.focus();const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;setter.call(field,"你好");field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
	await pause(400);
	await running.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await running.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await until(`document.querySelector("main")?.innerText.includes("好的，收到。")`);
	await pause(1200);
	const picture = await running.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(out, `${stamp}_${name}.png`), Buffer.from(picture.data, "base64"));
	await stopRecording();
	stopRecording = undefined;

	const pid = await running.main<number>("process.pid");
	const quitAt = Date.now();
	// 不 await 结果：进程在答话之前可能就没了。
	void running.main("process._linkedBinding('electron_browser_app').app.quit()").catch(() => {});
	let goneAt = 0;
	for (let i = 0; i < 200 && !goneAt; i++) {
		try { process.kill(pid, 0); await pause(25); } catch { goneAt = Date.now(); }
	}
	await running.stop();
	app = undefined;
	return { quitAt, goneAt };
}

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await seed(home);

	// 1. 800ms 的 SessionEnd：退出等它写完。
	await writeSettings(home, address.port, 800);
	const first = await talkThenQuit("01_说完一句_即将退出");
	const once = await lines();
	const ended = once.find((line) => line.event === "SessionEnd");
	check("这一轮先后跑了 SessionStart 和 Stop", once[0]?.event === "SessionStart" && once.some((line) => line.event === "Stop"), once.map((line) => `${line.event}:${line.reason ?? ""}`));
	check("退出时 SessionEnd 跑了，reason 是 quit", ended?.reason === "quit", ended);
	check("写下那一行时 Electron 还活着（退出确实等了它）", Boolean(ended && first.goneAt && ended.at <= first.goneAt), { writtenAfterQuitMs: ended ? ended.at - first.quitAt : null, goneAfterQuitMs: first.goneAt - first.quitAt });

	// 2. 5 秒的 SessionEnd：退出最多等 2 秒。
	await writeFile(trace, "");
	await writeSettings(home, address.port, 5000);
	const second = await talkThenQuit("02_钩子要5秒_即将退出");
	const held = second.goneAt - second.quitAt;
	check("钩子再慢，退出也只多等 2 秒上下", second.goneAt > 0 && held >= 1800 && held < 4000, { goneAfterQuitMs: held });

	const passed = checks.filter((item) => item.ok).length;
	await encode(frames, join(out, `${stamp}_退出时跑SessionEnd钩子_${passed}of${checks.length}.mp4`), undefined, 1500);
	console.log(`\n${passed}/${checks.length} 通过 → ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
	// 第二次的钩子在进程退出后还会睡完那 5 秒；等它写完再删，免得它往删掉的目录里写。
	await pause(4000);
	await rm(home, { recursive: true, force: true });
}
