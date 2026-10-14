/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * 子智能体派出即放手、跑完一个送回一个（ADR-0051），在真窗口里从头走一遍，边演边验。
 *
 *   一、一次派三路：主智能体派完这一轮就收尾——输入框不是「停止」，输入框上方那一条写着三个在跑；
 *   二、三路分别在 3s、6s、9s 回来，最后一路出错：每回来一路，对话里一行「消息来自 @谁」，主智能体
 *      就着这一份说一段、点名还在等谁；派发卡片上的脸跟着换表情；
 *   三、都回来了：最后那一段合并成一份结论，那一条自己收起；
 *   四、点一行题注：面板翻到那个子智能体。
 *
 * 模型是假的（OpenAI Responses 协议），按「谁在问」回不同剧本：主会话手里有 `task`；子智能体的
 * 第一句话里写着自己是甲、乙还是丙，按约好的时刻交差，丙在交差那一刻报 400（500 会被子智能体自己重连几次）。
 *
 * 用法：node --experimental-strip-types e2e/subagent-one-by-one-demo.ts [输出目录]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, openSession, press, type } from "./drive.ts";
import { seedInteractions } from "./interaction-fixture.ts";
import { encode, frameGrabber, pause, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume子代理逐个送回测试");
const PORT = 9651;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

let app: RunningApp;
const checks: { ok: boolean; what: string }[] = [];
function check(what: string, ok: boolean, saw = "") {
	checks.push({ ok, what });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

/** 三路各自几时交差（从派出那一刻算）。丙交差时报错。 */
const ROUTES = [
	{ name: "甲", agent: "general", description: "找出所有调用 resolveRealPath 的地方", after: 3000 },
	{ name: "乙", agent: "simple", description: "审一遍 workspace 的路径包含判断", after: 6000 },
	{ name: "丙", agent: "reason", description: "在软链目录下复现失败", after: 9000 },
] as const;
let dispatchedAt = 0;
const heard: { who: string; text: string }[] = [];

type Item = { type?: string; role?: string; content?: { type: string; text?: string }[]; output?: string };

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

/** 主智能体就着一份送达说的那段话：认出是谁回来了、还在等谁。 */
function onDelivery(text: string): string {
	const back = ROUTES.filter((route) => text.includes(`task="${route.description}"`));
	const names = back.map((route) => route.agent).join("、");
	const waiting = text.match(/还有 \d+ 个没回来：([^。]+)。/)?.[1];
	if (waiting) return `${names} 这一路回来了，先记下它的结论。还在等：${waiting}。`;
	return "## 结论\n\n三路都回来了。工作区 root 只做了 normalize、没有 realpath，`/var/…` 和 `/private/var/…` 比较恒为假，写操作被静默拒绝；复现那一路出错了，我自己再跑一遍确认。";
}

const model = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (chunk) => (raw += chunk));
	req.on("end", () => {
		const body = JSON.parse(raw) as { input?: Item[]; tools?: { name: string }[] };
		const input = body.input ?? [];
		const tools = (body.tools ?? []).map((tool) => tool.name);
		const userTexts = input
			.filter((item) => item.role === "user")
			.map((item) => (item.content ?? []).map((part) => part.text ?? "").join(""))
			.filter((text) => !text.trimStart().startsWith("<env>"));
		const last = userTexts.at(-1) ?? "";
		const lastUserAt = input.findLastIndex((item) => item.role === "user" && !(item.content ?? []).some((part) => (part.text ?? "").trimStart().startsWith("<env>")));
		const outputsSince = input.slice(lastUserAt + 1).filter((item) => item.type === "function_call_output").length;
		const route = ROUTES.find((one) => userTexts[0]?.includes(`【${one.name}】`));
		const who = tools.includes("task") ? "main" : route ? route.name : "aside";
		heard.push({ who, text: last.replace(/\s+/g, " ").slice(0, 120) });
		const later = (reply: Parameters<typeof sse>[1], ms: number) => setTimeout(() => sse(res, reply), Math.max(0, ms));

		if (who === "aside") return later({ text: "{}" }, 50);
		if (who === "main") {
			if (last.startsWith("（运行时送达）")) return later({ text: onDelivery(last) }, 600);
			if (outputsSince > 0) return later({ text: "三路都派出去了，回来一路我说一路。" }, 500);
			dispatchedAt = Date.now() + 600;
			return later({
				text: "分三路查，互不依赖，一起派出去。",
				calls: ROUTES.map((one) => ({ name: "task", args: { description: one.description, prompt: `【${one.name}】${one.description}。只报结论。`, subagent_type: one.agent } })),
			}, 600);
		}
		// 子智能体：先读一下，到点交差。
		if (!input.some((item) => item.type === "function_call_output")) return later({ calls: [{ name: "read", args: { path: "README.md" } }] }, 400);
		const at = dispatchedAt + route!.after - Date.now();
		if (route!.name === "丙") {
			setTimeout(() => {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "invalid request: upstream rejected the input" } }));
			}, Math.max(0, at));
			return;
		}
		later({ text: `${route!.description}：结论在 README.md 第 1 行。` }, at);
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
				maxConcurrentSubAgents: 4,
				appearance: { theme: process.env.THEME ?? "light" },
			});
			await writeFile(path, JSON.stringify(settings));
			await writeFile(join(seedHome, "window.json"), JSON.stringify({ width: 1200, height: 860, x: 0, y: 0 }));
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
	// 一轮假对话要十几秒：从 Node 侧短轮询，不在页面里挂长 promise（见 `record.ts` 的 `driver`）。
	const until = async (expression: string, ms = 30000) => {
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
	const running = () => $<boolean>(`Boolean(document.querySelector('main button[aria-label="停止"]'))`);
	const barText = () => $<string>(`document.querySelector('[data-ly-subagent-bar]')?.textContent ?? ''`);
	const rows = `[...document.querySelectorAll('main [data-delivery-kind="agent"]')]`;
	/** 第 n 行题注：它的字、它的盒子，和窗口上紧跟在它后面的那段字。 */
	const row = (n: number) =>
		$<{ text: string; height: number; background: string; next: string } | null>(`(()=>{const r=${rows}[${n}];if(!r)return null;const b=r.querySelector('button');const own=r.innerText.trim();const all=document.querySelector('main').innerText;const at=all.indexOf(own);return {text:own.replace(/\\s+/g,' '),height:b.getBoundingClientRect().height,background:getComputedStyle(b).backgroundColor,next:at<0?'':all.slice(at+own.length,at+own.length+160)};})()`);
	/**
	 * 第 n 行题注和上下两段字之间的空白：从字到字量，不从盒子量——一段回复底下还挂着一排悬停才出现的
	 * 操作，盒子的边不是人看到的边。
	 */
	const gaps = (n: number) =>
		$<{ below: number; above: number; layers: string[] }>(`(()=>{const list=document.querySelector('[data-ly-transcript-rows]');const rows=[...list.children];const cap=${rows}[${n}];const i=rows.findIndex(r=>r.contains(cap));const words=(el)=>[...(el?.querySelectorAll('p,h1,h2,h3,li')??[])].filter(e=>e.checkVisibility()&&!e.closest('[data-delivery-row]'));const c=cap.querySelector('button').getBoundingClientRect();const next=words(rows[i+1])[0]?.getBoundingClientRect().top;const prev=words(rows[i-1]).at(-1)?.getBoundingClientRect().bottom;const layers=rows.slice(i-1,i+2).map(r=>{const b=r.getBoundingClientRect();return r.tagName+'.'+(r.className||'').toString().slice(0,60)+' h='+b.height.toFixed(0)+' top='+b.top.toFixed(0);});return {below:+(next-c.bottom).toFixed(1),above:+(c.top-prev).toFixed(1),layers};})()`);
	const moods = () => $<string[]>(`[...document.querySelectorAll('main [data-ly-avatar-host] .ly-avatar[data-mood]')].filter(e=>!e.closest('[data-delivery-row]')).map(e=>e.dataset.mood)`);

	try {
		console.log("【一】一次派三路");
		await pause(700);
		await openSession(app, "qa-short");
		await type(app, "main textarea", "分三路查一下为什么软链下文件操作全挂了");
		await pause(500);
		await press(app, "Enter", 13);
		await until(`/3 个子 Agent 运行中/.test(document.querySelector('[data-ly-subagent-bar]')?.textContent ?? '')`, 15000);
		await until(`(document.querySelector('main')?.innerText ?? '').includes('回来一路我说一路')`, 15000);
		await until(`!document.querySelector('main button[aria-label="停止"]')`, 10000);
		await pause(800);
		check("派完这一轮就收尾：输入框不是「停止」", !(await running()));
		check("那一条写着三个都还在跑", /3 个子 Agent 运行中/.test(await barText()), await barText());
		const mainCalls = () => heard.filter((one) => one.who === "main").length;
		check("主会话发了 2 次请求就停下（派出、收尾一句），没有挂着等", mainCalls() === 2, String(mainCalls()));
		await still("01_派完就收尾_三路在跑");

		console.log("\n【二】一路一路回来");
		for (const [n, route] of ROUTES.entries()) {
			await until(`${rows}.length >= ${n + 1}`, 15000);
			await until(`(document.querySelector('main')?.innerText ?? '').split('${n < 2 ? "这一路回来了" : "三路都回来了"}').length > ${n < 2 ? n + 1 : 1}`, 10000);
			await pause(900);
			const seen = await row(n);
			check(`第 ${n + 1} 行题注：消息来自 @${route.agent}，带着它的任务`, Boolean(seen?.text.includes(`消息来自 @${route.agent}`) && seen.text.includes(route.description)), JSON.stringify(seen));
			check(`  它是一行（${seen?.height.toFixed(1)}px），没有胶囊底色`, Boolean(seen && seen.height <= 30 && /rgba\(0, 0, 0, 0\)|transparent/.test(seen.background)), JSON.stringify(seen));
			if (route.name === "丙") check("  出错的那一路在行尾标红「出错」", Boolean(seen?.text.includes("出错")), seen?.text ?? "");
			else check("  做完的不标出错", !seen?.text.includes("出错"), seen?.text ?? "");
			check(`  紧跟着是主智能体就着它说的那段${n < 2 ? "（点名还在等谁）" : "（合并的结论）"}`, n < 2 ? Boolean(seen?.next.includes("还在等")) : Boolean(seen?.next.includes("结论")), seen?.next ?? "");
			const gap = await gaps(n);
			check(`  题注贴着下面那段字（${gap.below}px），和上一段隔开（${gap.above}px）`, gap.below <= 6 && gap.above <= 50, JSON.stringify(gap));
			const faces = await moods();
			check(`  派发卡片上的脸：${faces.join(" / ")}`, faces.filter((mood) => mood === "done" || mood === "failed").length >= n + 1, faces.join(","));
			await still(`0${n + 2}_第${n + 1}路回来`);
		}

		console.log("\n【三】都回来了");
		await until(`!document.querySelector('[data-ly-subagent-bar]')?.checkVisibility()`, 8000).catch(() => {});
		await pause(800);
		check("那一条自己收起了", !(await $<boolean>(`Boolean(document.querySelector('[data-ly-subagent-bar]')?.checkVisibility())`)));
		check(`主会话一共 ${mainCalls()} 次请求：派出、收尾一句、三次送达各一轮`, mainCalls() === 5, String(mainCalls()));
		const settled = await moods();
		check(`三张派发卡片：两个弯眼、一个叉眼（${settled.join(" / ")}）`, settled.filter((mood) => mood === "done").length >= 2 && settled.includes("failed"), settled.join(","));
		await still("05_都回来了_合并结论");

		console.log("\n【四】点一行题注");
		await click(app, 'main [data-delivery-kind="agent"] button');
		await until(`(document.querySelector('[data-dock-pane="subagents"]')?.innerText ?? '').includes('${ROUTES[0].description}')`, 8000);
		await pause(1200);
		check("面板翻到了那个子智能体", (await $<string>(`document.querySelector('[data-dock-pane="subagents"]')?.innerText ?? ''`)).includes(ROUTES[0].description));
		await still("06_点题注_面板翻到它");
		await pause(1000);
	} catch (error) {
		console.log("\n模型收到的：", JSON.stringify(heard, null, 1));
		console.log("窗口上：", await $<string>(`document.querySelector('main')?.innerText ?? ''`).then((text) => text.slice(-900)).catch(() => "(读不到)"));
		throw error;
	} finally {
		camera.rolling = false;
		await film;
		grab.close();
		const passed = checks.filter((one) => one.ok).length;
		const out = join(OUT_DIR, `${STAMP}_子代理逐个送回_${passed}of${checks.length}.mp4`);
		console.log(`\n采到 ${frames.length} 帧，合成到 ${out}`);
		await encode(frames, out, 30, 1500);
		await app.stop();
		await closeListeningServer(model);
		console.log(`\n${passed}/${checks.length} 条通过`);
		if (passed !== checks.length) process.exitCode = 1;
	}
}

await main();
