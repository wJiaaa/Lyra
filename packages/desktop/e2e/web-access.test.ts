/**
 * Web access, end to end: the real app serving, a real Chromium page with no preload loading it.
 *
 * The browser is a second Electron process running a bare window — no preload, so `window.plume` is
 * absent and the renderer has to build it over the network exactly as Safari or Chrome would. That
 * is the whole path the unit tests cannot see: the cookie, the socket, the bridge, the first frame.
 * The first real run of this feature crashed in that first frame (`s.sessions.includes`), with
 * every unit test green.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { electronLaunch, evaluateRenderer, startApp, stopProcessGroup, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";

const WEB_PORT = 46400 + (process.pid % 200);
const BROWSER_DEBUG_PORT = 9643;
const TOKEN = "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0";
const MODEL_PORT = 46700 + (process.pid % 200);

/*
 * A model that writes half a sentence, then waits to be let go — so the test can look at both
 * screens while the turn is still running, which is the one moment "live" means anything.
 */
let release: () => void = () => {};
const held = new Promise<void>((resolve) => {
	release = resolve;
});
let model: Server | undefined;

function sse(res: ServerResponse, payload: { type: string }): void {
	res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function startModel(): Server {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += String(chunk)));
		req.on("end", () => void (async () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			sse(res, { type: "message_start", message: { id: "msg", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } } as never);
			sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as never);
			sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "浏览器那头先看到半句" } } as never);
			// The title request carries no tools; only the turn itself waits at the gate.
			if (body.includes("todo_write")) await held;
			sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，然后是整句。" } } as never);
			sse(res, { type: "content_block_stop", index: 0 } as never);
			sse(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } as never);
			sse(res, { type: "message_stop" });
			res.end();
		})());
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

let app: RunningApp;
let browser: ChildProcess | undefined;
let browserHome = "";
let page = "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		try {
			last = await read();
			if (ok(last)) return last;
		} catch {}
		await sleep(200);
	}
	throw new Error(`${what}（最后一次：${JSON.stringify(last)?.slice(0, 400)}）`);
}

const inPage = <T>(expression: string) => evaluateRenderer<T>(page, expression);
const text = () => inPage<string>("document.body.innerText");

before(async () => {
	model = startModel();
	app = await startApp({
		port: 9642,
		seed: async (home) => {
			await seedInteractions(home, MODEL_PORT);
			const file = join(home, "settings.json");
			const settings = JSON.parse(await readFile(file, "utf8"));
			settings.webAccess = { enabled: true, port: WEB_PORT, token: TOKEN };
			await writeFile(file, JSON.stringify(settings));
		},
	});

	// The server is started during boot; wait until it answers rather than guessing how long that is.
	await until(() => fetch(`http://127.0.0.1:${WEB_PORT}/`).then((res) => res.status), (status) => status === 401, "Web 访问服务没有起来");

	browserHome = await mkdtemp(join(tmpdir(), "plume-web-browser-"));
	const main = join(browserHome, "main.cjs");
	await writeFile(
		main,
		`const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
	const win = new BrowserWindow({ show: false, width: 1280, height: 820 });
	win.loadURL(process.env.PLUME_WEB_URL);
});`,
	);
	const { executable } = electronLaunch();
	browser = spawn(executable, [main, `--remote-debugging-port=${BROWSER_DEBUG_PORT}`, `--user-data-dir=${join(browserHome, "profile")}`], {
		env: { ...process.env, PLUME_WEB_URL: `http://127.0.0.1:${WEB_PORT}/?token=${TOKEN}` },
		stdio: "ignore",
		detached: process.platform !== "win32",
	});
	const targets = await until(
		() => fetch(`http://127.0.0.1:${BROWSER_DEBUG_PORT}/json/list`).then((res) => res.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>),
		(list) => list.some((t) => t.type === "page" && t.url.startsWith(`http://127.0.0.1:${WEB_PORT}/`)),
		"浏览器窗口没有打开 Web 访问页",
	);
	page = targets.find((t) => t.type === "page" && t.url.startsWith(`http://127.0.0.1:${WEB_PORT}/`))!.webSocketDebuggerUrl;
});

after(async () => {
	release();
	await stopProcessGroup(browser);
	await app?.stop();
	model?.close();
	if (browserHome) await rm(browserHome, { recursive: true, force: true });
});

test("the link trades its token for a cookie, and the page builds window.plume over the network", async () => {
	// Waited for exactly, not for "no token": mid-redirect the page reads as `about:blank`.
	await until(() => inPage<string>("location.href"), (href) => href === `http://127.0.0.1:${WEB_PORT}/`, "地址栏里的令牌没有被去掉");
	assert.equal(await inPage<string>("window.plume.host"), "web");
	// HttpOnly: the page never holds the secret.
	assert.doesNotMatch(await inPage<string>("document.cookie"), /plume_web/);
});

test("the sidebar lists the desktop's conversations, without the error screen", async () => {
	const body = await until(text, (t) => t.includes("qa-long") && t.includes("qa-short"), "侧边栏没有列出会话");
	assert.doesNotMatch(body, /错误栈|组件栈|is not an object|undefined is not/);
});

test("opening a conversation shows its transcript", async () => {
	await inPage(`(() => {
		window.__webErrors = [];
		addEventListener("error", (e) => window.__webErrors.push(String(e.message)));
		addEventListener("unhandledrejection", (e) => window.__webErrors.push(String(e.reason?.stack ?? e.reason)));
	})()`);
	const clicked = await inPage<boolean>(`(() => {
		const row = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("qa-short"));
		row?.click();
		return Boolean(row);
	})()`);
	assert.ok(clicked, "侧边栏里找不到 qa-short 那一行");
	const body = await until(text, (t) => t.includes("qa-short 第 1 个问题"), "对话内容没有显示出来").catch(async (error: Error) => {
		throw new Error(`${error.message}\n页面错误：${JSON.stringify(await inPage("window.__webErrors"))}`);
	});
	assert.doesNotMatch(body, /错误栈|组件栈/);
});

test("a rename on the desktop reaches the browser without a reload", async () => {
	await app.evaluate(`window.plume.sessions.rename("qa-long", "桌面端改的名字")`);
	await until(text, (t) => t.includes("桌面端改的名字"), "改名没有推到浏览器");
});

test("what the browser may not do is refused without a round trip", async () => {
	assert.equal(await inPage("window.plume.settings.save({})"), null);
	assert.equal(await inPage("window.plume.terminal.list()"), null);
});

test("a turn started in the browser streams to both screens while it is still running", async () => {
	const desktop = () => app.evaluate<string>("document.body.innerText");
	// The desktop looks at the same conversation, so both screens have something to show.
	await app.evaluate(`[...document.querySelectorAll("button")].find((el) => el.textContent?.includes("qa-short"))?.click()`);
	await until(desktop, (t) => t.includes("qa-short 第 1 个问题"), "桌面端没有打开 qa-short");

	await inPage(`window.plume.agent.prompt("qa-short", [{ type: "text", text: "从浏览器发的问题" }])`);
	const midTurn = (t: string) => t.includes("从浏览器发的问题") && t.includes("浏览器那头先看到半句") && !t.includes("然后是整句");
	await until(text, midTurn, "进行中的回复没有推到浏览器");
	await until(desktop, midTurn, "浏览器发起的回合没有实时出现在桌面端");
	release();
	await until(text, (t) => t.includes("浏览器那头先看到半句，然后是整句。"), "回复结束后浏览器没有拿到整句");
	await until(desktop, (t) => t.includes("浏览器那头先看到半句，然后是整句。"), "回复结束后桌面端没有拿到整句");
});
