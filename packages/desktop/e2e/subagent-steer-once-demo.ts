/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * Steering a running sub-agent shows the message once — when it is said, and still once after the
 * sub-agent's loop has taken it in.
 *
 * The second bubble used to appear a turn later: `steer` recorded and announced the message, then
 * the loop's `message_end` for the same message recorded and announced it again. Counting right
 * after sending would miss it, so this counts again after the model has received it.
 *
 * The model is fake (Anthropic streaming, scripted by who is asking). The explorer keeps working,
 * one step every second, until it hears STEER.
 *
 * Usage: LABEL=改后 node --experimental-strip-types e2e/subagent-steer-once-demo.ts [out dir]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume子代理操控气泡测试");
const LABEL = process.env.LABEL ?? "改后";
const PORT = 9646;
const STEP_MS = 1000;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** Requests the explorer made after it was steered; the loop has taken the message in by then. */
let heardSteer = 0;
/** Held until the counting is done, so the bubble is counted while the sub-agent is still running. */
let mayFinish = false;

type Part = { type: string; text?: string };

function reply(res: ServerResponse, r: { text?: string; tools?: { name: string; input: Record<string, unknown> }[] }): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "scripted", stop_reason: null, usage: { input_tokens: 1800, output_tokens: 0 } } });
	const tools = r.tools ?? [];
	let index = 0;
	if (r.text) {
		emit("content_block_start", { index, content_block: { type: "text", text: "" } });
		emit("content_block_delta", { index, delta: { type: "text_delta", text: r.text } });
		emit("content_block_stop", { index });
		index += 1;
	}
	for (const tool of tools) {
		emit("content_block_start", { index, content_block: { type: "tool_use", id: `t${Math.random().toString(36).slice(2, 10)}`, name: tool.name, input: {} } });
		emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
		emit("content_block_stop", { index });
		index += 1;
	}
	emit("message_delta", { delta: { stop_reason: tools.length > 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 120 } });
	emit("message_stop", {});
	res.end();
}

const model = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { messages?: { role: string; content: unknown }[]; tools?: { name: string }[] };
		const tools = new Set((body.tools ?? []).map((tool) => tool.name));
		const messages = body.messages ?? [];
		const parts = (m: { content: unknown }) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) as Part[];
		const allText = messages.flatMap(parts).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
		const results = messages.flatMap(parts).filter((p) => p.type === "tool_result").length;
		const answered = parts(messages[messages.length - 1] ?? { content: [] }).some((p) => p.type === "tool_result");

		if (tools.has("yield")) {
			if (allText.includes("STEER")) heardSteer += 1;
			if (!mayFinish) {
				// A different query every step: the same call repeated would be read as going in circles.
				setTimeout(() => reply(res, { text: results === 0 ? "先找找入口。" : "", tools: [{ name: "grep", input: { pattern: `signIn${results}`, path: "." } }] }), STEP_MS);
				return;
			}
			setTimeout(() => reply(res, { tools: [{ name: "yield", input: { summary: "登录入口是 `src/auth/login.ts` 的 `signIn`，session 的刷新也看过了。", files: [{ path: "src/auth/login.ts:12", why: "入口。" }] } }] }), STEP_MS);
			return;
		}
		if (answered) {
			reply(res, { text: "子智能体回来了：入口在 `src/auth/login.ts`。" });
			return;
		}
		if (allText.includes("STEER-ONCE")) {
			reply(res, { tools: [{ name: "task", input: { description: "找出登录入口", prompt: "找到登录入口在哪、被谁调用。", subagent_type: "explore" } }] });
			return;
		}
		reply(res, { text: "好的。" });
	});
});

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("model server did not start");
	app = await startApp({
		port: PORT,
		scaleFactor: 2,
		seed: async (home) => {
			await seedInteractions(home, address.port);
			const path = join(home, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			Object.assign(settings, { autoSummarizeTitle: false, permissionMode: "full", thinking: "off", retryAttempts: 0, subAgentDelegation: "eager", appearance: { theme: "light" } });
			await writeFile(path, JSON.stringify(settings));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1320, height: 860, x: 0, y: 0 }));
		},
	});
	await app.send("Page.bringToFront");
	const grab = await frameGrabber(PORT);
	const frames: Frame[] = [];
	const camera = { rolling: true };
	const film = (async () => {
		while (camera.rolling) frames.push({ at: Date.now(), data: await grab.shot() });
	})();

	const $ = <T>(expression: string) => grab.evaluate<T>(expression);
	const until = async (expression: string, ms = 30000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (await $<boolean>(`Boolean(${expression})`)) return;
			await pause(120);
		}
		throw new Error(`等不到：${expression}`);
	};
	const centre = (selector: string) => $<{ x: number; y: number }>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
	const click = async (selector: string) => {
		await until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`);
		const at = await centre(selector);
		await grab.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
		for (const type of ["mousePressed", "mouseReleased"]) await grab.send("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
		await pause(200);
	};
	const typeText = async (text: string) => {
		for (const ch of text) {
			await grab.send("Input.insertText", { text: ch });
			await pause(30);
		}
	};
	const enter = async () => {
		await grab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await grab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
	};
	const still = async (name: string) => {
		await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_${name}.png`), Buffer.from((await grab.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));
	};

	const MAIN = "main textarea";
	const SUB = '[data-dock-pane="subagents"]';
	const bubbles = () => $<number>(`[...document.querySelectorAll('${SUB} [data-spoken-bubble]')].filter(b=>b.innerText.includes('STEER')).length`);

	try {
		console.log(`【${LABEL}】派一个子智能体，在它跑的时候说一句话`);
		await pause(700);
		await click('[data-ly-row="qa-short"]');
		await click(MAIN);
		await typeText("STEER-ONCE 找一下登录入口");
		await enter();
		await until(`document.querySelector('[data-ly-subagent-bar]')`, 20000);
		await pause(STEP_MS);
		await click("[data-ly-subagent-bar]");
		await until(`document.querySelector('${SUB} [data-sub-header]')`);
		const field = `${SUB} textarea`;
		await until(`document.querySelector(${JSON.stringify(field)}) && !document.querySelector(${JSON.stringify(field)}).disabled`);
		await pause(STEP_MS);
		await click(field);
		await typeText("STEER 顺便看看 session 的刷新逻辑");
		await pause(500);
		await enter();
		await until(`document.querySelector('${SUB} [data-spoken-bubble]')`);
		await pause(STEP_MS);
		const sent = await bubbles();
		check("发出去的那一刻：面板上一个气泡", sent === 1, String(sent));
		await still("01_刚发出");

		// The loop takes the message at its next turn; that is where the second copy used to come from.
		// Set by the model server's callback, so read through a function the loop calls each time.
		const steeredRequests = () => heardSteer;
		const end = Date.now() + 20000;
		while (steeredRequests() < 2 && Date.now() < end) await pause(120);
		check("子智能体的下一次请求已经带着这句话", heardSteer >= 1, String(heardSteer));
		await pause(STEP_MS * 1.5);
		const taken = await bubbles();
		check("子智能体取走这句话之后：还是一个气泡", taken === 1, String(taken));
		await still("02_子智能体取走之后");

		mayFinish = true;
		await until(`document.querySelector('${SUB} [data-sub-report]')`, 20000);
		await pause(STEP_MS * 1.5);
		const done = await bubbles();
		check("跑完交回之后：还是一个气泡", done === 1, String(done));
		await still("03_交回之后");
		await pause(STEP_MS);

		// Leaving clears the window's copy; coming back reads the whole transcript from the registry,
		// which is where the second copy actually lived.
		await click('[data-ly-row="qa-long"]');
		await until(`!document.querySelector('${SUB} [data-sub-report]')`, 10000);
		await pause(STEP_MS);
		await click('[data-ly-row="qa-short"]');
		if (!(await $<boolean>(`Boolean(document.querySelector('${SUB}'))`))) await click("[data-ly-subagent-bar]");
		await until(`document.querySelector('${SUB} [data-sub-report]')`, 15000);
		await pause(STEP_MS * 1.5);
		const reread = await bubbles();
		check("切走再切回、面板重新读一遍转录：还是一个气泡", reread === 1, String(reread));
		await still("04_切回来重新读");
		await pause(STEP_MS);
	} catch (error) {
		console.log("窗口上：", await $<string>(`(document.querySelector('${SUB}')?.innerText ?? '').slice(-600)`).catch(() => "(读不到)"));
		throw error;
	} finally {
		camera.rolling = false;
		await film;
		grab.close();
		const passed = checks.filter((one) => one.ok).length;
		const out = join(OUT_DIR, `${STAMP}_${LABEL}_操控子智能体气泡只出现一次_${passed}of${checks.length}.mp4`);
		console.log(`\n采到 ${frames.length} 帧，合成到 ${out}`);
		await encode(frames, out, 30, 1500);
		await app.stop();
		await closeListeningServer(model);
		console.log(`\n${passed}/${checks.length} 条通过`);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
