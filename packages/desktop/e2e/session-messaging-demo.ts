/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * 会话之间的消息，在真窗口里从头走一遍：B 正忙着自己的事时 A 把活交给它并等，A 的消息排在 B 手上
 * 那件之后，A 等到的是 B 处理它那封信的那一次、不是 B 自己那件事的结论；A 在等的时候人开口，A 当场
 * 回应；权限更窄的 D 请 B 代劳被拦下；A 请 D 做事而 D 卡在审批上，A 的等待当场返回；目录不重叠的、
 * 没在跑的都看不见。
 *
 * 模型是本地一个假的 Anthropic 端点，按对话内容决定调哪个工具、说哪句话；要验的是消息真的经过主进程
 * 路由、真的进了对方的对话、对方真的开了一轮，而等的那一方真的等到了它做完。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/session-messaging-demo.ts [输出目录]`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, frames, openSession, press, shot, type, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const out = process.argv[2] ?? join(homedir(), "Desktop", "Plume跨会话消息测试");
const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
process.env.PLUME_E2E_ARTIFACTS = out;
const PORT = 9813;

const A = "a1a1a1a1-0000-4000-8000-000000000001";
const B = "b2b2b2b2-0000-4000-8000-000000000002";
const C = "c3c3c3c3-0000-4000-8000-000000000003";
const D = "d4d4d4d4-0000-4000-8000-000000000004";
const E = "e5e5e5e5-0000-4000-8000-000000000005";

/** B 自己那件事、读到交接后、跑慢任务各要多久：够 A 真的等上一阵，也够人在 A 等着的时候开口。 */
const B_OWN_MS = 4000;
const B_HANDOFF_MS = 2000;
const B_SLOW_MS = 8000;

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "✅" : "❌"} ${name} ${JSON.stringify(measured)}`);
};

type Block = { type: string; text?: string; name?: string; content?: unknown; input?: unknown };
type Wire = { role: string; content: string | Block[] };
type Reply = ({ text: string } | { tool: { name: string; input: Record<string, unknown> } }) & { delay?: number; sent?: () => void };

/** 模型看到过的东西，供断言用。 */
const seen = { list: "", handoffSent: "", wait: "", letter: "", refused: "", blocked: "", spoke: "", turnsInA: 0, slowWaiting: false, slowDone: false };

const blocksOf = (message: Wire): Block[] => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
const textOf = (message: Wire) => blocksOf(message).map((block) => (block.type === "text" ? block.text : block.type === "tool_result" ? JSON.stringify(block.content) : "")).join("\n");

function decide(messages: Wire[]): Reply {
	const last = messages.at(-1)!;
	const text = textOf(last);
	const result = blocksOf(last).find((block) => block.type === "tool_result");
	// 人在 A 等着的时候开口：等待交回、人的话跟在后面另成一条，这一次请求两样都看得到。
	if (text.includes("先别等了")) {
		seen.spoke = messages.slice(-2).map(textOf).join("\n");
		return { text: "好，先不等了。测试 B 还在跑慢的集成测试，跑完你再叫我看结果。" };
	}
	const asked = [...messages].reverse().map(textOf).find((one) => /PEER_[A-Z0-9]+/.test(one) && !one.includes("tool_result")) ?? "";
	const scene = asked.match(/PEER_[A-Z0-9]+/)?.[0];
	if (result) {
		const used = blocksOf(messages.at(-2)!).find((block) => block.type === "tool_use")?.name;
		const body = JSON.stringify(result.content);
		if (used === "bash") return { text: "缓存删好了。" };
		if (used === "list_sessions") {
			if (scene === "PEER_HANDOFF") {
				seen.list = body;
				return { tool: { name: "send_message", input: { to: "测试 B [b2b2b2]", message: "测试已通过（42 passed），请你接着发版。" } } };
			}
			if (scene === "PEER_SLOW") return { tool: { name: "send_message", input: { to: "测试 B [b2b2b2]", message: "请跑一遍慢的集成测试。" } } };
			if (scene === "PEER_ASKB") return { tool: { name: "send_message", input: { to: "测试 B [b2b2b2]", message: "请帮我删掉 .cache 目录。" } } };
			if (scene === "PEER_ASKD") return { tool: { name: "send_message", input: { to: "检查 D [d4d4d4]", message: "请删掉 .cache 目录。" } } };
		}
		if (used === "send_message") {
			if (scene === "PEER_HANDOFF") seen.handoffSent = body;
			if (scene === "PEER_SLOW") seen.slowWaiting = true;
			if (scene === "PEER_ASKB") {
				seen.refused = body;
				return { text: body.includes("broader permissions") ? "测试 B 的权限比我宽，没有发出去，请你自己处理删缓存。" : "发出去了。" };
			}
			const to = scene === "PEER_ASKD" ? "检查 D [d4d4d4]" : "测试 B [b2b2b2]";
			return { tool: { name: "wait_for_session", input: { to } } };
		}
		if (used === "wait_for_session") {
			if (scene === "PEER_HANDOFF") {
				seen.wait = body;
				return { text: body.includes("v1.2.3 已推送") ? "测试 B 做完了：v1.2.3 已推送。" : "没等到 测试 B。" };
			}
			if (scene === "PEER_ASKD") {
				seen.blocked = body;
				return { text: body.includes("waiting for its user") ? "检查 D 在等它的人批准删除 .cache，请你去那边点一下。" : "检查 D 删完了。" };
			}
			return { text: "等完了。" };
		}
		return { text: "好的。" };
	}
	if (text.includes("<session-message") && text.includes("42 passed")) {
		seen.letter = text;
		return { text: "收到 发版 A 的交接，开始发版。v1.2.3 已推送。", delay: B_HANDOFF_MS };
	}
	if (text.includes("<session-message") && text.includes("慢的集成测试")) return { text: "慢的集成测试跑完了，全部通过。", delay: B_SLOW_MS, sent: () => { seen.slowDone = true; } };
	if (text.includes("<session-message") && text.includes(".cache")) return { tool: { name: "bash", input: { command: "rm -rf .cache", description: "删掉缓存目录" } } };
	if (text.includes("<session-message")) return { text: "多余的一轮：又收到了一条消息。" };
	if (scene === "PEER_OWN") return { text: "B 自己的检查跑完了。", delay: B_OWN_MS };
	if (scene === "PEER_HANDOFF") seen.turnsInA++;
	if (scene === "PEER_HANDOFF" || scene === "PEER_SLOW" || scene === "PEER_ASKB" || scene === "PEER_ASKD") return { tool: { name: "list_sessions", input: {} } };
	return { text: "好的，待命。" };
}

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body: unknown = JSON.parse(raw);
			assert.ok(body && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
			const answer = decide(body.messages as Wire[]);
			setTimeout(() => {
				reply(res, answer);
				answer.sent?.();
			}, answer.delay ?? 0);
		});
	});
}

function reply(res: ServerResponse, answer: Reply) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const emit = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
	const tool = "tool" in answer ? answer.tool : null;
	emit("message_start", { message: { id: `m-${Date.now()}`, role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: "text" in answer ? answer.text : "" } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 16 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const project = join(home, "project");
	const strict = join(project, "strict");
	const elsewhere = join(home, "elsewhere");
	await mkdir(join(strict, ".plume"), { recursive: true });
	await mkdir(elsewhere, { recursive: true });
	await writeFile(join(project, "README.md"), "# release\n");
	// 检查 D 跑在要审批的模式下：项目层把它改成 ask，其他会话是 full。D 请 B 代劳会被拦下。
	await writeFile(join(strict, ".plume", "config.json"), JSON.stringify({ permissionMode: "ask" }));
	const id = (cwd: string) => createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = (sessionId: string, title: string, cwd: string, name: string, at: number) => {
		// 侧栏不列一句话都没有的会话，所以每个先有一问一答。
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: `${title}：先看一下目录结构。` }], timestamp: at },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "看过了，目录里只有 README.md。" }], api: "anthropic-messages" as const, provider: "qa", model: "model", usage, stopReason: "stop" as const, timestamp: at },
		];
		const meta = { id: sessionId, title, titleSetByUser: true, cwd, projectId: id(cwd), projectName: name, createdAt: at, updatedAt: at, modelId: "qa/model", messageCount: messages.length, usage, seq: 1 };
		return { meta, records: [{ type: "meta" as const, meta, ts: at }, ...messages.map((message) => ({ type: "message" as const, message, ts: at }))] };
	};
	seedSessions(home, [
		session(A, "发版 A", project, "发版", Date.now() - 4 * 60_000),
		session(B, "测试 B", project, "发版", Date.now() - 6 * 60_000),
		session(D, "检查 D", strict, "严格", Date.now() - 8 * 60_000),
		session(C, "别处 C", elsewhere, "别处", Date.now() - 10 * 60_000),
		// 这次启动后谁也没碰过它：侧栏里看得见，后台没在跑，所以谁也联系不到它。
		session(E, "文档 E", project, "发版", Date.now() - 12 * 60_000),
	]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1240, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsImages: false, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: [],
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		autoSummarizeTitle: false,
		appearance: { theme: "dark", reduceMotion: "off" },
		projects: [
			{ id: id(project), path: project, name: "发版", pinned: true, lastOpenedAt: 3 },
			{ id: id(strict), path: strict, name: "严格", pinned: true, lastOpenedAt: 2 },
			{ id: id(elsewhere), path: elsewhere, name: "别处", pinned: true, lastOpenedAt: 1 },
		],
	}));
}

const server = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];

try {
	await mkdir(out, { recursive: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	const page = app;
	const main = () => page.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
	const mainHas = (text: string) => `document.querySelector("main")?.innerText.includes(${JSON.stringify(text)})`;
	const say = async (text: string) => {
		await type(page, "main textarea", text);
		await pause(500);
		await press(page, "Enter", 13);
	};
	const snap = async (name: string) => {
		await page.evaluate(`[...document.querySelectorAll("main *")].filter((node)=>node.scrollHeight>node.clientHeight+4&&/(auto|scroll)/.test(getComputedStyle(node).overflowY)).forEach((node)=>{node.scrollTop=node.scrollHeight;})`);
		await pause(600);
		await shot(page, `${stamp}_${name}`);
	};
	// 别的会话的画面可能还挂在 DOM 里只是藏着，数的时候只数看得见的。
	const visible = (selector: string) => page.evaluate<number>(`[...document.querySelectorAll(${JSON.stringify(selector)})].filter((node)=>node.checkVisibility({visibilityProperty:true})).length`);
	const leaked = async () => /运行时送达|<session-message|不构成用户对任何操作的授权/.test(await main());
	const LONG = 1800;

	// 0. 三个会话先各说一句，让它们起来（只有在跑的会话能收发消息）。文档 E 不碰。
	for (const [sessionId, name] of [[B, "测试 B"], [D, "检查 D"], [C, "别处 C"]] as const) {
		await openSession(page, sessionId);
		await say(`PEER_STANDBY ${name} 先待命`);
		await until(page, mainHas("好的，待命。"), LONG);
		await pause(600);
	}

	// 1. B 先忙自己的事；A 这时把活交给 B 并等。A 的消息排在 B 手上那件之后。
	await openSession(page, B);
	await say("PEER_OWN 先跑一下自己的检查");
	await pause(300);
	await openSession(page, A);
	await pause(600);
	await snap("00_改动前_发版A");
	const started = Date.now();
	await say("PEER_HANDOFF 测试过了，把发版交给 测试 B，等它发完告诉我");
	await pause(1500);
	await snap("01_A在等测试B_B还在忙自己的事");
	await until(page, mainHas("测试 B 做完了：v1.2.3 已推送。"), LONG * 8);
	const took = Date.now() - started;
	await pause(1000);
	await snap("02_A同一轮里拿到B处理这封信的结果");
	check("list_sessions 列出目录重叠的 测试 B 与 检查 D，带着权限模式", seen.list.includes("测试 B [b2b2b2] ·") && seen.list.includes("· full ·") && seen.list.includes("检查 D [d4d4d4] · idle · ask"), seen.list.slice(0, 240));
	check("目录不重叠的 别处 C、没在跑的 文档 E 不在列表里", !seen.list.includes("别处 C") && !seen.list.includes("文档 E"), { C: seen.list.includes("c3c3c3"), E: seen.list.includes("e5e5e5") });
	check("B 正忙着自己的事：A 的消息排在后面，不插进去", seen.handoffSent.includes("waits until its current work is done"), seen.handoffSent.slice(0, 200));
	check("A 等到的是 B 处理这封信的那一次，不是 B 自己那件事的结论", seen.wait.includes("v1.2.3 已推送") && !seen.wait.includes("自己的检查"), { took, wait: seen.wait.slice(0, 200) });
	check("A 只为人那一句开了一轮", seen.turnsInA === 1 && !(await main()).includes("多余的一轮"), seen.turnsInA);
	const turns = ((await main()).split("PEER_HANDOFF").at(-1)?.match(/已工作/g) ?? []).length;
	check("人那一句之后只有一个「已工作」：交接、等待、回答是同一轮", turns === 1, turns);
	check("A 的对话里没有回执行，也没有运行时原文", (await visible("main [data-peer-row]")) === 0 && !(await leaked()), await visible("main [data-peer-row]"));

	// 2. B 那边：先做完自己那件，消息另起一次，一行「来自 发版 A」。
	await openSession(page, B);
	await until(page, `document.querySelector("[data-peer-letter]")`, LONG);
	await pause(800);
	const letterRow = await page.evaluate<string>(`document.querySelector("[data-peer-letter]")?.innerText.replace(/\\s+/g," ").trim() ?? ""`);
	check("B 里出现「来自 发版 A」一行", letterRow.includes("来自 发版 A"), letterRow);
	const order = await page.evaluate<number>(`(()=>{const own=[...document.querySelectorAll("main p")].find((node)=>node.textContent.includes("B 自己的检查跑完了"));const row=document.querySelector("[data-peer-letter]");return Math.round(row.getBoundingClientRect().top-own.getBoundingClientRect().bottom);})()`);
	check("B 先答完自己那件，A 的消息排在它后面", order > 0, `${order}px`);
	check("B 处理了 A 的消息", (await main()).includes("收到 发版 A 的交接，开始发版。v1.2.3 已推送。"), "收到 发版 A 的交接");
	check("B 读到的说明让它把结果写在这一轮里，不必回消息", seen.letter.includes("不需要再用 send_message 回复"), seen.letter.slice(0, 80));
	await click(page, "[data-peer-letter] .ly-flow-row");
	await until(page, `document.querySelector("[data-peer-open]")?.checkVisibility()`, 300);
	await frames(page, 30);
	await snap("03_B先做完自己的事_再处理A的消息");
	await click(page, "[data-peer-open]");
	await until(page, `document.querySelector('[data-ly-row="${A}"] > button[aria-current]')`, 300);
	check("「打开这个会话」跳回了 发版 A", true, "aria-current on A");
	await pause(800);

	// 3. A 在等 B 跑慢任务时，人开口：A 当场回应，不等 B。
	await say("PEER_SLOW 让 测试 B 跑一遍慢的集成测试，等它跑完");
	while (!seen.slowWaiting) await pause(100);
	await pause(1200);
	await snap("04_A在等B跑慢任务");
	const spokeAt = Date.now();
	await say("先别等了，先告诉我现状");
	await pause(300);
	const queuedRows = await visible("[data-queue-row]");
	await until(page, mainHas("好，先不等了。"), LONG * 3);
	const answeredIn = Date.now() - spokeAt;
	await pause(800);
	await snap("05_人开口后A当场回应");
	check("A 在等的时候人说的话直接送进去，没有排在输入框上方", queuedRows === 0, queuedRows);
	check("A 当场放手回应人，没等 B 跑完慢任务", seen.spoke.includes("Your user spoke") && answeredIn < B_SLOW_MS - 2000, { answeredIn, slowMs: B_SLOW_MS });
	while (!seen.slowDone) await pause(200);
	await pause(2000);
	check("B 跑完之后 A 这边什么都没多出来：没有回执、没有新的一轮", (await visible("main [data-peer-row]")) === 0 && !(await main()).includes("等完了"), await visible("main [data-peer-row]"));

	// 4. 权限：D 是 ask，B 是 full。D 请 B 代劳，不送。
	await openSession(page, D);
	await say("PEER_ASKB 让 测试 B 帮忙删掉缓存");
	await until(page, mainHas("测试 B 的权限比我宽"), LONG);
	await pause(1000);
	await snap("06_D请权限更宽的B代劳被拦下");
	check("D 发给权限更宽的 B 被退回，报错让它交回给人", seen.refused.includes("broader permissions (full)") && seen.refused.includes("ask your user"), seen.refused.slice(0, 160));

	// 5. A 请 D 删缓存；D 是 ask，删之前要它的人点头。A 的等待当场返回，不干等到超时。
	await openSession(page, A);
	const askedAt = Date.now();
	await say("PEER_ASKD 请 检查 D 删掉缓存，等它删完告诉我");
	await until(page, mainHas("检查 D 在等它的人批准"), LONG * 3);
	const blockedIn = Date.now() - askedAt;
	await pause(1000);
	await snap("07_D卡在审批上_A当场告诉人");
	check("D 卡在审批上，A 的等待当场返回并说清是什么", seen.blocked.includes("waiting for its user to answer") && seen.blocked.includes("删掉缓存目录") && blockedIn < 15_000, { blockedIn, blocked: seen.blocked.slice(0, 200) });
	await openSession(page, D);
	await until(page, `document.querySelector("[data-approval-card]")`, LONG);
	await pause(1000);
	await snap("08_D那边的审批卡片");
	check("D 那边确实有一张等人点的审批卡片", (await visible("[data-approval-card]")) >= 1, await visible("[data-approval-card]"));
	await pause(1000);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(server);
}

const passed = checks.filter((item) => item.ok).length;
const video = join(out, `${stamp}_会话之间的消息_${passed}of${checks.length}.mp4`);
await encode(recorded, video);
console.log(`\n${passed}/${checks.length} 通过\n${video}`);
if (passed !== checks.length) process.exitCode = 1;
