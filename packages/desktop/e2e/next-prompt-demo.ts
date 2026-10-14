/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 下一步建议：一轮做完，输入框里出现灰字，Tab 填进去；关掉设置就不再猜。在真窗口里走一遍，边验边录。
 *
 * 模型是假的，说 OpenAI Responses 协议，每次都报缓存命中——不报的话 core 不会去猜（见
 * `runtime/next-prompt.ts`）。末尾是猜下一句那条指令的请求就回一句建议，并记下来，用来核对它是
 * 不是从上一次主请求原样分叉出来的。
 *
 * 单测（`test/ui/composer-next-prompt.test.ts`）按的是合成的 keydown；这里补它证不到的：真按键
 * 经过命令单和 @ 名单之后 Tab 还落在这里、事件从主进程一路过来、设置开关真的传到了会话。
 *
 * 用法：node --experimental-strip-types e2e/next-prompt-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, openSession, openSettings, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume下一步建议测试");
const PORT = 9471;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const SUGGESTION = "跑一下测试看看";
const FIELD = "main textarea";
const STEP_MS = 1000;

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

type Item = { type?: string; role?: string; content?: { type: string; text?: string }[] };
interface Heard { fork: boolean; instructions: string; tools: string; input: Item[] }
const heard: Heard[] = [];

function sse(res: ServerResponse, text: string) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
	const id = `msg_${Math.random().toString(36).slice(2, 8)}`;
	emit({ type: "response.output_item.added", output_index: 0, item: { type: "message", id } });
	emit({ type: "response.output_text.delta", output_index: 0, delta: text });
	emit({ type: "response.output_item.done", output_index: 0, item: { type: "message", id } });
	emit({ type: "response.completed", response: { id: `resp_${id}`, usage: { input_tokens: 2400, output_tokens: 12, input_tokens_details: { cached_tokens: 1800 } } } });
	res.end();
}

const model = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { input?: Item[]; tools?: unknown[]; instructions?: string };
		const input = body.input ?? [];
		const last = input.findLast((item) => item.role === "user");
		const fork = (last?.content ?? []).some((part) => (part.text ?? "").includes("guess the next message"));
		heard.push({ fork, instructions: body.instructions ?? "", tools: JSON.stringify(body.tools ?? []), input });
		// 没有工具、没有系统提示词的是标题之类的旁路请求，照样回一句。
		setTimeout(() => sse(res, fork ? SUGGESTION : "改好了：登录按钮已经换成蓝色。"), fork ? 600 : 800);
	});
});

const placeholder = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(FIELD)}).placeholder`);
const value = () => app.evaluate<string>(`document.querySelector(${JSON.stringify(FIELD)}).value`);
const forks = () => heard.filter((one) => one.fork).length;
async function waitFor(what: () => boolean | Promise<boolean>, ms = 20000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await what()) return true;
		await pause(100);
	}
	return false;
}

async function shot(name: string) {
	const image = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(image.data, "base64"));
}

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
			Object.assign(settings, {
				providers: [{
					id: "qa", name: "隔离测试模型（Responses）", api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", enabled: true,
					models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
				}],
				defaultModelId: "qa/model",
				autoSummarizeTitle: false,
				nextPromptSuggestions: true,
				permissionMode: "full",
				thinking: "off",
				retryAttempts: 0,
				appearance: { theme: process.env.THEME ?? "light" },
			});
			await writeFile(path, JSON.stringify(settings));
		},
	});
	const frames: Frame[] = [];
	const stop = await startRecording(PORT, frames);
	try {
		await openSession(app, "qa-short");
		await until(app, `document.querySelector(${JSON.stringify(FIELD)})`);
		const resting = await placeholder();
		await pause(STEP_MS);

		console.log("一、一轮做完，输入框里出现猜的下一句");
		await type(app, FIELD, "把登录按钮改成蓝色");
		await pause(STEP_MS);
		await press(app, "Enter", 13);
		const landed = await waitFor(async () => (await placeholder()) === SUGGESTION);
		check("回复落定后，空输入框的灰字换成了猜的那句", landed, await placeholder());
		await shot("01_灰字建议");
		await pause(STEP_MS);

		const fork = heard.find((one) => one.fork);
		const main = heard.findLast((one) => !one.fork && one.tools !== "[]");
		check("只猜了一次", forks() === 1, String(forks()));
		check("分叉请求的系统提示词和上一次主请求一样", Boolean(fork && main && fork.instructions === main.instructions));
		check("分叉请求的工具和上一次主请求一样", Boolean(fork && main && fork.tools === main.tools));
		check(
			"上一次主请求的消息原样排在分叉请求前面",
			Boolean(fork && main && JSON.stringify(fork.input.slice(0, main.input.length)) === JSON.stringify(main.input)),
		);

		console.log("二、按 Tab 填进去");
		await press(app, "Tab", 9);
		check("Tab 把建议填进了输入框", (await value()) === SUGGESTION, await value());
		check(
			"光标停在末尾，可以接着改",
			await app.evaluate<boolean>(`(()=>{const e=document.querySelector(${JSON.stringify(FIELD)});return document.activeElement===e&&e.selectionStart===e.value.length;})()`),
		);
		await shot("02_Tab填入");
		await pause(STEP_MS);

		console.log("三、发出去：新一轮开始时灰字退回默认，做完再猜一次");
		await press(app, "Enter", 13);
		const cleared = await waitFor(async () => (await placeholder()) === resting && (await value()) === "", 5000);
		check("发出后灰字退回默认占位文字", cleared, await placeholder());
		const again = await waitFor(async () => forks() === 2 && (await placeholder()) === SUGGESTION);
		check("第二轮收尾后又猜了一次", again, `${forks()} 次，灰字是「${await placeholder()}」`);
		await pause(STEP_MS);

		console.log("四、有字的时候 Tab 不归它管");
		await type(app, FIELD, "换个思路");
		await press(app, "Tab", 9);
		check("框里有字时按 Tab，内容不变", (await value()) === "换个思路", await value());
		await pause(STEP_MS);

		console.log("五、设置里关掉以后不再猜");
		await openSettings(app, "常规");
		// 开关自己没有名字，挨着它的那一行字才是；给它挂一个记号，再用真鼠标去点。
		await app.evaluate(`(()=>{const e=[...document.querySelectorAll('[role="switch"]')].find((e)=>{let p=e.parentElement;for(let i=0;i<4&&p;i++,p=p.parentElement){if(p.textContent.includes("下一步建议"))return !p.textContent.includes("智能标题总结");}return false;});e.setAttribute("data-qa-next-prompt","");e.scrollIntoView({block:"center"});})()`);
		await pause(400);
		await shot("03_设置开关");
		check("设置里有这一项，而且开着", await app.evaluate<boolean>(`document.querySelector("[data-qa-next-prompt]").getAttribute("aria-checked")==="true"`));
		await click(app, "[data-qa-next-prompt]");
		await until(app, `document.querySelector("[data-qa-next-prompt]").getAttribute("aria-checked")==="false"`);
		await pause(STEP_MS);
		await closeSettings(app);
		await type(app, FIELD, "再调大一点字号");
		await press(app, "Enter", 13);
		const mainsBefore = heard.filter((one) => !one.fork).length;
		await waitFor(() => heard.filter((one) => !one.fork).length > mainsBefore);
		await pause(3000);
		check("关掉之后一轮做完不再发猜测请求", forks() === 2, String(forks()));
		check("灰字是默认占位文字", (await placeholder()) === resting, await placeholder());
		await shot("04_关掉之后");
		await pause(STEP_MS);
	} finally {
		await stop();
	}
	await app.stop();
	const passed = checks.filter((one) => one.ok).length;
	const out = join(OUT_DIR, `${STAMP}_下一步建议_${passed}of${checks.length}.mp4`);
	await encode(frames, out, 60, 1200);
	await closeListeningServer(model);
	console.log(`\n${passed}/${checks.length} 通过 → ${out}`);
	if (passed !== checks.length) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
	console.error(error);
	await app?.stop().catch(() => {});
	await closeListeningServer(model).catch(() => {});
	process.exitCode = 1;
});
