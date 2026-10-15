/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 子智能体那一条长出来、收回去时，压在输入框上方的任务清单会不会先往反方向跳一下。
 *
 * 输入框条的上边距由选择器在 0 和 12px 之间切（`composer.css` 的 `.ly-composer-dock`）：任务清单在、
 * 子智能体条开着时是 0。条是 `.ly-reveal` 慢慢长的，边距要是一帧切过去，清单就先掉 12px、再被条顶回去。
 * 这里逐帧记清单卡片上沿的位置：条展开时它只该往上走，收起时只该往下走。
 *
 * `BEFORE=1` 往页面里注一条 `transition: none`，即改之前的样子，拿来对照。
 *
 * `pnpm --filter @plume/desktop exec node --experimental-strip-types e2e/composer-dock-pad-probe.ts [输出目录]`
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { startApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, openPane, openSession, press, type, until } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume输入框上边距抖动测试");
const BEFORE = process.env.BEFORE === "1";
const LABEL = BEFORE ? "修前" : "修后";
const PORT = 9647;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${saw ? `  —— ${saw}` : ""}`);
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
	emit({ type: "response.completed", response: { id: `resp_${Math.random().toString(36).slice(2, 8)}`, usage: { input_tokens: 100, output_tokens: 20 } } });
	res.end();
}

const TODOS = [{ content: "找到入口", status: "completed" }, { content: "派人去查调用链", status: "in_progress" }, { content: "合并结论", status: "pending" }];

/** 主会话：先写清单，停一会儿再派一个子智能体，结果回来收尾。子智能体跑三秒。 */
const model = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { input?: Item[]; tools?: { name: string }[] };
		const input = body.input ?? [];
		const tools = (body.tools ?? []).map((tool) => tool.name);
		const userAt = input.findLastIndex((item) => item.role === "user" && !(item.content ?? []).some((part) => (part.text ?? "").trimStart().startsWith("<env>")));
		const last = (input[userAt]?.content ?? []).map((part) => part.text ?? "").join("");
		const outputs = input.slice(userAt + 1).filter((item) => item.type === "function_call_output").length;
		const later = (reply: Parameters<typeof sse>[1], ms: number) => setTimeout(() => sse(res, reply), ms);
		if (tools.length === 0) return later({ text: "{}" }, 50);
		if (!tools.includes("task")) return later({ text: "调用链两层，没有回环。" }, 3000);
		if (last.startsWith("（运行时送达）")) return later({ text: "合并完了。" }, 600);
		if (outputs === 0) return later({ text: "先列个清单。", calls: [{ name: "todo_write", args: { todos: TODOS } }] }, 300);
		if (outputs === 1) return later({ calls: [{ name: "task", args: { description: "查调用链", prompt: "把调用链查清楚。", subagent_type: "general" } }] }, 2000);
		return later({ text: "查完了。" }, 600);
	});
});

/** 每一帧：清单卡片上沿、输入框条的上边距、子智能体那一条开没开。 */
const SAMPLER = `(()=>{window.__s=[];const f=()=>{const card=document.querySelector('[data-ly-task-list="inline"]');const dock=document.querySelector('main .ly-composer-dock')??document.querySelector('.ly-composer-dock');const bar=dock?.querySelector(':scope > div > .ly-reveal');window.__s.push({t:performance.now(),top:card?card.getBoundingClientRect().top:null,pad:dock?parseFloat(getComputedStyle(dock).paddingTop):null,open:bar?.dataset.open==='true'});requestAnimationFrame(f);};requestAnimationFrame(f);})()`;

type Sample = { t: number; top: number | null; pad: number | null; open: boolean };

/** 条开合那一刻往后 600ms 里，清单上沿往「不该去的方向」走了多少。 */
function against(samples: Sample[], opening: boolean): { at: number; wrong: number; net: number; path: string } | null {
	const edge = samples.findIndex((s, i) => i > 0 && s.open === opening && samples[i - 1].open !== opening && s.top !== null && samples[i - 1].top !== null);
	if (edge < 0) return null;
	const start = samples[edge - 1];
	const span = samples.slice(edge - 1).filter((s) => s.t - start.t <= 600 && s.top !== null);
	let wrong = 0;
	for (let i = 1; i < span.length; i++) {
		const step = span[i].top! - span[i - 1].top!;
		// 展开：上沿只该变小（往上）；收起：只该变大。
		wrong = Math.max(wrong, opening ? step : -step);
	}
	const net = span.at(-1)!.top! - start.top!;
	const path = span.filter((_, i) => i % 3 === 0).map((s) => `${Math.round(s.t - start.t)}ms:${s.top!.toFixed(1)}/${s.pad}`).join(" ");
	return { at: start.t, wrong, net, path };
}

await mkdir(OUT_DIR, { recursive: true });
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const address = model.address();
if (!address || typeof address === "string") throw new Error("model server did not start");
const renderer = await startDevRenderer();
const app = await startApp({
	port: PORT,
	rendererUrl: renderer.url,
	seed: async (home) => {
		await seedInteractions(home, address.port);
		const path = join(home, "settings.json");
		const settings = JSON.parse(await readFile(path, "utf8"));
		Object.assign(settings, {
			providers: [{
				id: "qa", name: "QA", api: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test", enabled: true,
				models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }],
			}],
			autoSummarizeTitle: false,
			permissionMode: "auto",
			thinking: "off",
			retryAttempts: 0,
			appearance: { theme: "light" },
		});
		await writeFile(path, JSON.stringify(settings));
		// 子智能体面板会跟着条一起打开：窗口要宽到它停在旁边，对话这一列又窄到清单浮不到右上角。
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1200, height: 860, x: 0, y: 0 }));
	},
});
const grab = await frameGrabber(PORT);
const film: Frame[] = [];
const camera = { rolling: false };
let filming: Promise<void> = Promise.resolve();
try {
	if (BEFORE) await app.evaluate(`(()=>{const s=document.createElement('style');s.textContent='.ly-composer-dock{transition:none!important}';document.head.append(s);})()`);
	await openSession(app, "qa-short");
	await until(app, `document.querySelector("main textarea")`);
	// 面板先开好：对话这一列从一开始就窄，清单一出来就压在输入框上方，而不是等条出来时才从右上角挪下来。
	await openPane(app, "子 Agent");
	await until(app, `document.querySelector('[data-dock-pane="subagents"]')`);
	camera.rolling = true;
	filming = (async () => {
		while (camera.rolling) film.push({ at: Date.now(), data: await grab.shot() });
	})();
	await pause(800);
	await click(app, "main textarea");
	await type(app, "main textarea", "查一下调用链");
	await pause(400);
	await press(app, "Enter", 13);
	await until(app, `document.querySelector('[data-ly-task-list="inline"]')`, 1200);
	await app.evaluate(SAMPLER);
	await until(app, `document.querySelector('[data-ly-subagent-bar]')?.closest('.ly-reveal')?.dataset.open==='true'`, 1200);
	await pause(1200);
	await writeFile(join(OUT_DIR, `${STAMP}_${LABEL}_条展开后.png`), Buffer.from((await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data, "base64"));
	// 条收起：子智能体结束、这一轮收尾。
	await until(app, `document.querySelector('.ly-composer-dock > div > .ly-reveal')?.dataset.open==='false'`, 1800);
	await pause(1200);
	camera.rolling = false;
	await filming;

	const samples = await app.evaluate<Sample[]>("window.__s");
	const open = against(samples, true);
	const shut = against(samples, false);
	console.log(`【${LABEL}】采样 ${samples.length} 帧`);
	if (open) console.log(`   展开轨迹（时间:上沿/上边距）${open.path}`);
	if (shut) console.log(`   收起轨迹（时间:上沿/上边距）${shut.path}`);
	check("条展开时清单在场，量得到", open !== null);
	if (open) check(`条展开时清单只往上走（反向最大一步 ${open.wrong.toFixed(2)}px，净位移 ${open.net.toFixed(1)}px）`, open.wrong <= 0.5 && open.net < 0);
	const listAtShut = samples.at(-1)?.top !== null;
	if (shut && listAtShut) check(`条收起时清单只往下走（反向最大一步 ${shut.wrong.toFixed(2)}px，净位移 ${shut.net.toFixed(1)}px）`, shut.wrong <= 0.5 && shut.net > 0);
	else console.log("   （条收起时清单已不在，收起这一段不量）");
} finally {
	camera.rolling = false;
	await filming.catch(() => {});
	const passed = checks.filter((c) => c.ok).length;
	if (film.length > 0) await encode(film, join(OUT_DIR, `${STAMP}_${LABEL}_子智能体条开合时任务清单的位置_${passed}of${checks.length}.mp4`), 30);
	grab.close();
	await app.stop();
	await renderer.close();
	model.close();
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
