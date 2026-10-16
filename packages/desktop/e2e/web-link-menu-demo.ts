/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * Right-clicking a web address in a reply, in the real window, with the real right button.
 *
 * Measured: the rows the menu offers (the system browser by this machine's own name), that 复制链接
 * puts the address on the clipboard, and that 在内置浏览器打开 brings the browser pane up on it.
 *
 * A left click and 「在 … 中打开」 are not pressed: they would put a browser window on the screen of
 * whoever is using this machine. What they send is asserted in `test/ui/web-link-menu.test.ts`.
 *
 *   node --experimental-strip-types e2e/web-link-menu-demo.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, contextClick, shot, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT = join(homedir(), "Desktop", "Plume链接右键菜单测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9437;
process.env.PLUME_E2E_ARTIFACTS = OUT;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
	results.push({ name, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${name}\n     ${detail}`);
}

let app: RunningApp | undefined;
let server: Server | undefined;
const frames: Frame[] = [];
let stopRecording: (() => Promise<void>) | undefined;
let saved = "";

const rows = () => app!.evaluate<string[]>(`[...document.querySelectorAll('[role="menu"] button')].map((b) => b.innerText.trim())`);

try {
	await mkdir(OUT, { recursive: true });
	let url = "";
	server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>TokenRouter</title><h1>TokenRouter</h1>");
			return;
		}
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
			emit("message_start", { message: { id: "qa-link", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
			emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: `已推到仓库 [wJiaaa/TokenRouter](${url})。` } });
			emit("content_block_stop", { index: 0 });
			emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
			emit("message_stop", {});
			res.end();
		});
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture port");
	url = `http://127.0.0.1:${address.port}/wJiaaa/TokenRouter`;
	const link = `a[href="${url}"]`;

	app = await startApp({
		port: PORT,
		seed: async (home) => {
			await seedInteractions(home, address.port);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1400, height: 880, x: 40, y: 40 }));
			await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off", appearance: { ...settings.appearance, theme: "light", reduceMotion: "on" } }));
		},
	});
	await app.evaluate("document.fonts.ready");
	stopRecording = await startRecording(PORT, frames);

	await click(app, '[data-ly-row="qa-short"] > button');
	await app.evaluate(`window.plume.agent.prompt('qa-short',[{type:'text',text:'推到哪个仓库了'}])`);
	await until(app, `document.querySelector(${JSON.stringify(link)})`);
	await pause(1000);

	console.log("① 右键回复里的网址");
	await contextClick(app, link);
	await pause(800);
	const first = await rows();
	const browser = await app.evaluate<string>("window.plume.system.defaultBrowser()");
	check(
		"右键弹出菜单：在默认浏览器（按名字）中打开、在内置浏览器打开、复制链接",
		JSON.stringify(first) === JSON.stringify([browser ? `在 ${browser} 中打开` : "在系统浏览器中打开", "在内置浏览器打开", "复制链接"]),
		`${JSON.stringify(first)}，本机默认浏览器：${browser || "（问不到）"}`,
	);
	await shot(app, `${stamp}_01_右键网址`);

	console.log("② 复制链接");
	// The machine's real clipboard: what was on it goes back afterwards.
	saved = await app.evaluate<string>("window.plume.clipboard.read()");
	await app.evaluate("window.plume.clipboard.write('')");
	await click(app, '[role="menu"] button', "复制链接");
	await pause(800);
	const copied = await app.evaluate<string>("window.plume.clipboard.read()");
	await app.evaluate(`window.plume.clipboard.write(${JSON.stringify(saved)})`);
	const closed = (await rows()).length === 0;
	check("复制链接：剪贴板里是这个网址，菜单收起", copied === url && closed, `剪贴板：${copied}；菜单已收起：${closed}`);

	console.log("③ 在内置浏览器打开");
	await contextClick(app, link);
	await pause(600);
	await click(app, '[role="menu"] button', "在内置浏览器打开");
	await until(app, `[...document.querySelectorAll('[data-browser-omnibox] input')].some((input) => input.value.includes('/wJiaaa/TokenRouter'))`, 900);
	await pause(1500);
	check("在内置浏览器打开：浏览器面板打开到这个网址", true, "地址栏里是这个网址");
	await shot(app, `${stamp}_02_内置浏览器打开`);
	await pause(800);
} catch (error) {
	check("跑完", false, String(error));
} finally {
	await stopRecording?.();
	const passed = results.filter((r) => r.ok).length;
	console.log(`\n${passed}/${results.length} 通过`);
	await app?.stop();
	if (server) await closeListeningServer(server);
	if (frames.length) {
		const video = join(OUT, `${stamp}_链接右键菜单_${passed}of${results.length}.mp4`);
		await encode(frames, video);
		console.log(`   🎬 ${video}`);
	}
	if (passed !== results.length) process.exitCode = 1;
}
