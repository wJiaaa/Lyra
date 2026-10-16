/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 切回一个子智能体还在跑的会话：输入框上方那一条本来就在，侧边面板停在人留下的那一页。
 *
 *   一、派一个子智能体：那一条出现，面板自己打开到子 Agent（派活时打开，这一条不能丢）；
 *   二、人把面板切到「文件」，子智能体接着跑、名单一直在重发：面板不被翻回去；
 *   三、切到另一个会话再切回来，逐帧采样：面板前台始终是「文件」；那一条第一帧就是满高、不透明、
 *       没有动画在播。
 *
 * 从前切回来时实时名单先清空、再异步读回，读回来那一下被当成「又派了活」：条从 0 长出来、面板跳到子 Agent。
 *
 * 用法：pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/subagent-switch-back-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { openPane, openSession, press, type } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume切回会话子智能体测试");
const PORT = 9653;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const TASK = "把鉴权链路从头读一遍";

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

type Item = { type?: string; role?: string; content?: { type: string; text?: string }[] };

function sse(res: ServerResponse, reply: { text?: string; calls?: { name: string; args: Record<string, unknown> }[] }) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (data: Record<string, unknown>) => res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
	let index = 0;
	if (reply.text) {
		const id = `msg_${Math.random().toString(36).slice(2, 8)}`;
		emit({ type: "response.output_item.added", output_index: index, item: { type: "message", id } });
		emit({ type: "response.output_text.delta", output_index: index, delta: reply.text });
		emit({ type: "response.output_item.done", output_index: index, item: { type: "message", id } });
		index += 1;
	}
	for (const call of reply.calls ?? []) {
		const id = `fc_${Math.random().toString(36).slice(2, 8)}`;
		const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
		const args = JSON.stringify(call.args);
		emit({ type: "response.output_item.added", output_index: index, item: { type: "function_call", id, call_id: callId, name: call.name } });
		emit({ type: "response.function_call_arguments.delta", output_index: index, delta: args });
		emit({ type: "response.output_item.done", output_index: index, item: { type: "function_call", id, call_id: callId, name: call.name, arguments: args } });
		index += 1;
	}
	emit({ type: "response.completed", response: { id: `resp_${Math.random().toString(36).slice(2, 8)}`, usage: { input_tokens: 2400, output_tokens: 160, input_tokens_details: { cached_tokens: 1800 } } } });
	res.end();
}

/** 主会话派一个；子智能体每隔 0.8 秒读一次文件，名单就跟着重发一次，一直跑到这段演示结束。 */
const model = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { input?: Item[]; tools?: { name: string }[] };
		const input = body.input ?? [];
		const tools = (body.tools ?? []).map((tool) => tool.name);
		// 第一句真正的话（跳过 `<env>`）：子智能体的这一句写着它是谁。
		const brief = input
			.filter((item) => item.role === "user")
			.map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""))
			.find((text) => !text.trimStart().startsWith("<env>"));
		const later = (reply: Parameters<typeof sse>[1], ms: number) => setTimeout(() => sse(res, reply), ms);
		if (tools.includes("task")) {
			if (input.some((item) => item.type === "function_call_output")) return later({ text: "派出去了，它读完我再接着说。" }, 400);
			return later({ text: "这件事交给一个子智能体去读。", calls: [{ name: "task", args: { description: TASK, prompt: `【读】${TASK}。只报结论。`, subagent_type: "general" } }] }, 500);
		}
		if (!brief?.includes("【读】")) return later({ text: "{}" }, 50);
		later({ calls: [{ name: "read", args: { path: "README.md" } }] }, 800);
	});
});

async function main() {
	await mkdir(OUT_DIR, { recursive: true });
	await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
	const address = model.address();
	if (!address || typeof address === "string") throw new Error("model server did not start");
	const renderer = await startDevRenderer();
	app = await startApp({
		port: PORT,
		scaleFactor: 2,
		rendererUrl: renderer.url,
		seed: async (seedHome) => {
			await seedInteractions(seedHome, address.port);
			const path = join(seedHome, "settings.json");
			const settings = JSON.parse(await readFile(path, "utf8"));
			Object.assign(settings, {
				providers: [
					{
						id: "qa",
						name: "隔离测试模型（Responses）",
						api: "openai-responses",
						baseUrl: `http://127.0.0.1:${address.port}`,
						apiKey: "test",
						enabled: true,
						models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }],
					},
				],
				autoSummarizeTitle: false,
				permissionMode: "full",
				thinking: "off",
				retryAttempts: 0,
				appearance: { theme: process.env.THEME ?? "light" },
			});
			await writeFile(path, JSON.stringify(settings));
			await writeFile(join(seedHome, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
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
	const until = async (expression: string, ms = 15000) => {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (await $<boolean>(`Boolean(${expression})`)) return;
			await pause(100);
		}
		throw new Error(`等不到：${expression}`);
	};
	const still = async (name: string) => {
		await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from((await grab.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));
	};
	// 主对话那一格也是一个 dock pane，要的是侧边那一摞里在前台的那一格。
	const FRONT = `[...document.querySelectorAll('[data-dock-pane]:not([inert])')].map(e=>e.dataset.dockPane).filter(k=>k!=='conversation').join(',')`;
	const front = () => $<string>(FRONT);
	const BAR_VISIBLE = `document.querySelector('[data-ly-subagent-bar]')?.checkVisibility()`;

	try {
		console.log("【一】派一个子智能体");
		await pause(700);
		await openSession(app, "qa-short");
		await type(app, "main textarea", "读一下鉴权链路");
		await pause(400);
		await press(app, "Enter", 13);
		await until(BAR_VISIBLE);
		await until(`document.querySelector('[data-dock-pane="subagents"]:not([inert])')`, 5000).catch(() => {});
		await pause(900);
		check("派活时面板自己打开到子 Agent", (await front()) === "subagents", await front());
		await still("01_派活_面板打开到子Agent");

		console.log("\n【二】人把面板切到「文件」");
		await openPane(app, "文件");
		await until(`(${FRONT}) !== 'subagents' && (${FRONT}) !== ''`, 5000);
		const chosen = await front();
		console.log(`   面板前台：${chosen}`);
		await pause(2500);
		check(`子智能体接着跑、名单一直重发，面板还停在 ${chosen}`, (await front()) === chosen, await front());
		await still("02_面板切到文件");

		console.log("\n【三】切到 qa-long，再切回来");
		await openSession(app, "qa-long");
		await pause(1200);
		check("另一个会话里没有那一条", !(await $<boolean>(`Boolean(${BAR_VISIBLE})`)));
		// 从点下去之前开始逐帧采：哪个会话在前、面板前台、那一条的高度/透明度/在播的动画。
		await $(`(()=>{window.__samples=[];const end=performance.now()+2500;const tick=()=>{const bar=document.querySelector('[data-ly-subagent-bar]');const reveal=bar?.closest('.ly-reveal');const line=bar?.parentElement;const cur=document.querySelector('[data-ly-row] > button[aria-current]')?.parentElement?.dataset.lyRow??'';window.__samples.push({cur,front:${FRONT},height:reveal?+reveal.getBoundingClientRect().height.toFixed(1):0,opacity:reveal?+getComputedStyle(reveal).opacity:0,moving:[reveal,line].filter(Boolean).flatMap(e=>e.getAnimations()).map(a=>a.animationName??a.transitionProperty).join(',')});if(performance.now()<end)requestAnimationFrame(tick);};requestAnimationFrame(tick);})()`);
		await openSession(app, "qa-short");
		await pause(2700);
		const samples = (await $<{ cur: string; front: string; height: number; opacity: number; moving: string }[]>(`window.__samples`)).filter((one) => one.cur === "qa-short");
		const heights = [...new Set(samples.map((one) => one.height))];
		const fronts = [...new Set(samples.map((one) => one.front))];
		console.log(`   切回来后采到 ${samples.length} 帧；高度取值 ${heights.join(" / ")}；面板前台 ${fronts.join(" / ")}`);
		check(`面板前台每一帧都是 ${chosen}，没被翻到子 Agent`, samples.length > 10 && fronts.every((one) => one === chosen), fronts.join(","));
		check("那一条从第一帧起就是同一个高度，不从 0 长出来", samples.length > 10 && heights.length === 1 && heights[0] > 20, heights.join(","));
		check("那一条每一帧都不透明、没有动画在播", samples.every((one) => one.opacity === 1 && one.moving === ""), JSON.stringify(samples.find((one) => one.opacity !== 1 || one.moving !== "")));
		await still("03_切回来_条在面板没跳");
		await pause(800);
	} finally {
		camera.rolling = false;
		await film;
		grab.close();
		const passed = checks.filter((one) => one.ok).length;
		const out = join(OUT_DIR, `${STAMP}_切回会话子智能体条与面板_${passed}of${checks.length}.mp4`);
		console.log(`\n采到 ${frames.length} 帧，合成到 ${out}`);
		await encode(frames, out, 30, 1500);
		await app.stop();
		await renderer.close();
		await closeListeningServer(model);
		console.log(`\n${passed}/${checks.length} 条通过`);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
