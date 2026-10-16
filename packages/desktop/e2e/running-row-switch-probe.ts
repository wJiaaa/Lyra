/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 说完一段话之后模型沉默着想，这时切走再切回：运行行当场还在，不再先藏 2.5 秒；窗口刷新过再打开，
 * 耗时那一格也有数。
 *
 * `node --experimental-strip-types e2e/running-row-switch-probe.ts <before|after>`
 *
 * 假模型先吐一段话，然后一个字都不发——`openai-responses` 的加密推理就是这个样子，窗口在那段时间里
 * 收不到任何更新。
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { openSession, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const PORT = 9477;
const label = process.argv[2] ?? "after";
const stamp = new Date().toLocaleString("sv-SE").replace(/[: ]/g, "-").slice(0, 16);
const out = join(homedir(), "Desktop", "Plume运行指示器测试");

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw: string) {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}  —— ${saw}`);
}

let app: RunningApp | undefined;
let server: Server | undefined;

const PANE = '[data-dock-pane="conversation"]';
const read = `(() => {
	const ind = document.querySelector('${PANE} [data-ly-running]');
	return {
		drawn: Boolean(ind),
		open: ind?.closest('.ly-reveal')?.dataset.open ?? null,
		opacity: ind ? getComputedStyle(ind.parentElement).opacity : null,
		text: ind?.innerText.replace(/\\s+/g, ' ') ?? null,
	};
})()`;
type Read = { drawn: boolean; open: string | null; opacity: string | null; text: string | null };

async function main() {
	let sentAt = 0;
	server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => { raw += chunk; });
		request.on("end", async () => {
			const body = JSON.parse(raw || "{}");
			response.writeHead(200, { "content-type": "text/event-stream" });
			const emit = (kind: string, data: object) => response.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
			emit("message_start", { message: { id: `p-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
			const say = (index: number, text: string) => {
				emit("content_block_start", { index, content_block: { type: "text", text: "" } });
				emit("content_block_delta", { index, delta: { type: "text_delta", text } });
				emit("content_block_stop", { index });
			};
			const end = () => {
				emit("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } });
				emit("message_stop", {});
				response.end();
			};
			if (!body.tools?.length) { say(0, "运行行切换"); end(); return; }
			say(0, "这是第一段话，模型说完这段以后还要再想一会儿。");
			await pause(25_000);
			say(1, "最后的回答。");
			end();
		});
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const modelPort = address.port;

	app = await startApp({
		port: PORT,
		seed: async (home) => {
			await seedInteractions(home, modelPort);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			await writeFile(path, JSON.stringify({ ...settings, permissionMode: "full", projectMemory: false, thinking: "off", showThinking: false, appearance: { reduceMotion: "on" } }));
		},
	});
	await mkdir(out, { recursive: true });
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	const shoot = async (name: string) => {
		const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
		const file = join(out, `${stamp}_${label}_${name}.png`);
		await writeFile(file, Buffer.from(image.data, "base64"));
		console.log(`   📸 ${file}`);
	};
	const sample = () => app!.evaluate<Read>(read);
	try {
		await openSession(app, "qa-short");
		await type(app, `${PANE} textarea`, "复现运行行");
		sentAt = Date.now();
		await press(app, "Enter", 13);
		await until(app, `document.querySelector('${PANE}')?.innerText.includes('还要再想一会儿')`, 15000);
		await pause(3500);
		const stalled = await sample();
		check("字停住以后运行行回来了", stalled.opacity === "1", JSON.stringify(stalled));

		// 热切换：会话还在窗口的缓存里。
		await openSession(app, "qa-long");
		await pause(1200);
		await openSession(app, "qa-short");
		await pause(250);
		const warm = await sample();
		await shoot("01_切回之后250ms");
		await pause(750);
		const warmLater = await sample();
		check("切回 250ms 时运行行在（不再先藏 2.5 秒）", warm.drawn && warm.open === "true" && warm.opacity === "1", JSON.stringify(warm));
		check("切回 1s 时运行行在", warmLater.opacity === "1", JSON.stringify(warmLater));

		// 冷切换：窗口刷新过，错过了这一轮的开头。
		await openSession(app, "qa-long");
		await app.evaluate("location.reload()").catch(() => {});
		await pause(2500);
		await until(app, `document.querySelector('[data-ly-row="qa-short"] > button')`, 15000);
		await pause(800);
		await openSession(app, "qa-short");
		await until(app, `document.querySelector('${PANE} [data-ly-running]')`, 10000);
		await pause(1200);
		const cold = await sample();
		const ran = Math.floor((Date.now() - sentAt) / 1000);
		await shoot("02_刷新后打开");
		const shown = Number(/·\s*(\d+)s\b/.exec(cold.text ?? "")?.[1] ?? Number.NaN);
		check("刷新后打开，耗时一格有数", Number.isFinite(shown), JSON.stringify(cold));
		check("耗时和这一轮真实跑的时间差不过 2 秒", Math.abs(shown - ran) <= 2, `显示 ${shown}s，实际 ${ran}s`);
		check("没有两个点挨在一起", !/·\s*·/.test(cold.text ?? ""), JSON.stringify(cold.text));

		await until(app, `document.querySelector('${PANE}')?.innerText.includes('最后的回答')`, 40000);
		await pause(1000);
	} finally {
		await stop();
		const passed = checks.filter((one) => one.ok).length;
		if (frames.length > 1) {
			const video = join(out, `${stamp}_${label}_切回会话运行行_${passed}of${checks.length}.mp4`);
			await encode(frames, video, 30, 1500).catch((error: unknown) => console.log(`   视频合成失败：${String(error)}`));
			console.log(`   🎬 ${video}`);
		}
		console.log(`\n${passed}/${checks.length} 通过（${label}）`);
		const home = app?.home;
		await app?.stop();
		if (home) await rm(home, { recursive: true, force: true });
		if (server) await closeListeningServer(server);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
