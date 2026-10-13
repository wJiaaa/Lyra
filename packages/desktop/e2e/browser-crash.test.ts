import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { cleanupFixture } from "./fixture-cleanup.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { click, openSession, shot } from "./drive.ts";
import { driver } from "./record.ts";

/*
 * 网页的页面进程没了（崩溃、被系统杀掉）。
 *
 * 曾经它会带走整个应用：崩溃后面板多出一行错误、页面被挤矮，`resize` 对崩溃的 guest 调设备仿真，主进程
 * 段错误。所以每一步先问主进程还在不在。进程从系统层面杀，和真实的崩溃一样不经过任何 Electron 接口。
 */
let app: RunningApp;
let server: Server;
let port = 0;
let loads = 0;
const guest = `process._linkedBinding("electron_browser_web_contents").getAllWebContents().find((c) => c.getType() === "webview")`;
before(async () => {
	server = createServer((_req, res) => { loads++; res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>ALIVE</title><h1>ALIVE ${loads}</h1>`); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address !== "string"); port = address.port;
	app = await startApp({ port: 9624, inspectPort: 9625, seed: (home) => seedInteractions(home, port) });
});
after(async () => { await cleanupFixture(() => app?.stop(), () => closeListeningServer(server)); });

async function kill(): Promise<number> {
	const mainPid = await app.main<number>("process.pid");
	process.kill(await app.main<number>(`(${guest}).getOSProcessId()`), "SIGKILL");
	return mainPid;
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
const page = () => app.main<string>(`(async () => { const c = ${guest}; return c.isCrashed() ? "crashed" : await c.executeJavaScript("document.title + ' ' + innerWidth"); })()`);

test("a page whose process dies comes back by itself once, keeps the app alive, and waits for the person after a second death", async () => {
	await openSession(app, "qa-short");
	await app.evaluate(`window.plume.browser.command({ type: "open", url: "http://127.0.0.1:${port}/", sessionId: "qa-short", newTab: true })`);
	const run = driver(app);
	await run.until(`document.querySelector('[data-browser-page]') !== null`, 10_000);
	const id = await app.evaluate<string>(`document.querySelector('[data-browser-page]').dataset.browserPage`);
	await app.evaluate(`window.plume.browser.command({ type: "viewport", id: ${JSON.stringify(id)}, viewport: { width: 390, height: 844 } })`);
	for (const end = Date.now() + 10_000; Date.now() < end && await page() !== "ALIVE 390";) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(await page(), "ALIVE 390");

	// 第一次：自己回来，回到原来那一页、原来的视口。
	const mainPid = await kill();
	for (const end = Date.now() + 10_000; Date.now() < end && await page().catch(() => "") !== "ALIVE 390";) await new Promise((resolve) => setTimeout(resolve, 200));
	assert.ok(alive(mainPid), "the main process died with the page");
	assert.equal(await page(), "ALIVE 390");
	assert.equal(loads, 2);

	// 第二次紧跟着：不再自己重来，停在错误上；主进程照旧活着。
	await kill();
	await run.until(`document.querySelector('[data-browser-failure="crash"]') !== null`, 10_000);
	await new Promise((resolve) => setTimeout(resolve, 1_000));
	assert.ok(alive(mainPid), "the main process died with the page the second time");
	assert.equal(await page(), "crashed");
	assert.equal(loads, 2);
	await shot(app, "crash-1-stopped");

	// 人点盖层上的「重新加载」：回来，盖层消失。
	await click(app, '[data-browser-failure="crash"] button');
	for (const end = Date.now() + 10_000; Date.now() < end && await page().catch(() => "") !== "ALIVE 390";) await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(await page(), "ALIVE 390");
	await run.until(`document.querySelector('[data-browser-failure]') === null`, 5_000);
	await shot(app, "crash-2-reloaded");
});

test("a page that does not load is covered by why and a reload, which go away once the tab loads something else", async () => {
	const id = await app.evaluate<string>(`document.querySelector('[data-browser-page]').dataset.browserPage`);
	await app.evaluate(`window.plume.browser.command({ type: "navigate", id: ${JSON.stringify(id)}, url: "http://127.0.0.1:1/" })`);
	const run = driver(app);
	await run.until(`document.querySelector('[data-browser-failure="load"]')?.innerText.includes('ERR_UNSAFE_PORT')`, 10_000);
	// 盖在页面上，不挤它：页面进程停了时，那次改尺寸曾带走整个应用。
	assert.equal(await app.evaluate<boolean>(`(() => { const page = document.querySelector('[data-browser-page]').getBoundingClientRect(), cover = document.querySelector('[data-browser-failure]').getBoundingClientRect(); return page.top === cover.top && page.height === cover.height; })()`), true);
	await shot(app, "load-1-failed");
	await app.evaluate(`window.plume.browser.command({ type: "navigate", id: ${JSON.stringify(id)}, url: "http://127.0.0.1:${port}/" })`);
	await run.until(`document.querySelector('[data-browser-failure]') === null`, 10_000);
	assert.match(await page(), /^ALIVE/);
});
