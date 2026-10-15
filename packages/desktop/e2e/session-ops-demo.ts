/* oxlint-disable no-console -- probe CLI that prints what the real window did */
/**
 * The session-level operations in a real window, recorded while checked: a suggested conversation, and
 * a conversation archiving itself.
 *
 * The unit tests prove each link (`test/session-ops.test.ts`, `test/session-report-back.test.ts`,
 * `test/ui/session-suggestions.test.ts`). This covers the chain they cannot reach: the model really
 * calling the tools the desktop injects, the card standing where the call was made with the dot on the
 * Environment button, a real mouse on the card's Start making the main process create the session and
 * send its prompt to the model, the sidebar gaining a row nested under the one that suggested it while
 * the window stays where it was, the new session's first reply coming back to the suggesting one as a
 * delivery it answers, everything still right after a restart; and the archiving turn ending normally,
 * the session in the archive, the window off it.
 *
 * The model is fake: an Anthropic streaming server that picks its script by a marker in what the
 * person said.
 *
 * Usage: node --experimental-strip-types e2e/session-ops-demo.ts [output directory]
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { landsOn } from "./lands-on.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";

const OUT_DIR = process.argv[2] ?? join(homedir(), "Desktop", "Plume建议新会话测试");
const PORT = 9490;
const MODEL_PORT = 9890;
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);

const SPAWN_ASK = "SPAWN-PROBE 把登录按钮的点击区域修一下";
const TITLE = "删掉没人调用的 legacyLogin";
const SUMMARY = "修登录按钮时看到 legacyLogin 已经没有调用方了。新会话会确认一遍，再删掉它和它的测试。";
const CHILD = "CHILD-PROMPT 在 src/auth.ts 里，legacyLogin 已经没有任何调用方。先全局搜一遍确认，再删掉它和 test/auth.test.ts 里对应的用例，最后跑一遍测试。";
const ARCHIVE_ASK = "ARCHIVE-PROBE 把 README 里的错别字改掉，做完就归档这个对话";

const checks: { ok: boolean; what: string; saw: string }[] = [];
function check(what: string, ok: boolean, saw = ""): void {
	checks.push({ ok, what, saw });
	console.log(`   ${ok ? "✅" : "❌"} ${what}${ok ? "" : `  —— 看到的是：${saw}`}`);
}

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

/** Every agent request the fake model answered, by whose it was and whether a tool result came with it. */
const asked: { who: string; answered: boolean; firstUser: string; lastText: string }[] = [];

const write = (res: ServerResponse, events: [string, unknown][]) => {
	for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
};

/**
 * One streamed reply: a sentence, then optionally a tool call.
 *
 * `holdMs` keeps the sentence on screen before the call arrives — an archive that lands the instant
 * the reply does leaves nothing for the recording to show of the conversation it took away.
 */
function reply(res: ServerResponse, text: string, tool?: { name: string; input: unknown }, holdMs = 0, streamMs = 0): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	write(res, [
		["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "scripted", stop_reason: null, usage: { input_tokens: 900, output_tokens: 0 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
	]);
	setTimeout(() => {
		const finish = () => {
			write(res, [
				["message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } }],
				["message_stop", { type: "message_stop" }],
			]);
			res.end();
		};
		if (!tool) return finish();
		const id = `toolu_${Math.random().toString(36).slice(2, 10)}`;
		write(res, [["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: tool.name, input: {} } }]]);
		// `streamMs` 把参数一小段一小段吐出来，像真模型那样：调用还在写的那一段界面才有东西可看。
		const json = JSON.stringify(tool.input);
		const pieces = streamMs ? (json.match(/[\s\S]{1,12}/g) ?? [json]) : [json];
		const next = (i: number) => {
			if (i === pieces.length) {
				write(res, [["content_block_stop", { type: "content_block_stop", index: 1 }]]);
				return finish();
			}
			write(res, [["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: pieces[i] } }]]);
			setTimeout(() => next(i + 1), streamMs);
		};
		next(0);
	}, holdMs);
}

type Part = { type: string; text?: string };
type Body = { tools?: { name: string }[]; messages?: { role: string; content: string | Part[] }[] };

function startModel(): Server {
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			const body = JSON.parse(raw) as Body;
			// Side requests (the correction check, memory) carry no tools; a plain refusal is harmless to all of them.
			if (!body.tools?.some((tool) => tool.name === "read")) return reply(res, '{"isCorrection": false}');
			const users = (body.messages ?? []).filter((message) => message.role === "user");
			const parts = users.flatMap((message) => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content));
			const said = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
			const last = users.at(-1)?.content;
			const answered = Array.isArray(last) && last.some((part) => part.type === "tool_result");
			const lastText = Array.isArray(last) ? last.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : (last ?? "");
			// The suggesting conversation woken by what the started one handed back.
			const reported = lastText.includes("<session_result");
			const who = said.includes("ARCHIVE-PROBE") ? "archive" : said.includes("CHILD-PROMPT") ? "child" : said.includes("SPAWN-PROBE") ? (reported ? "report" : "spawn") : "other";
			const first = users[0]?.content;
			const firstUser = typeof first === "string" ? first : (first ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").find((text) => !text.startsWith("<env>")) ?? "";
			asked.push({ who, answered, firstUser, lastText });
			if (who === "spawn" && !answered) return reply(res, "先修登录按钮。顺手看到一处没人用的旧代码，单独建议一个会话去清理。", { name: "spawn_session", input: { title: TITLE, summary: SUMMARY, prompt: CHILD } }, 0, 120);
			if (who === "spawn") return reply(res, "SPAWN-DONE 登录按钮的点击区域修好了。");
			if (who === "report") return reply(res, "REPORT-ACK 新会话确认 legacyLogin 没人调用、已经删掉，登录这边不用再动。");
			if (who === "archive" && !answered) return reply(res, "错别字改好了，按你说的把这个对话归档。", { name: "archive_session", input: { reason: "README 错别字已改" } }, 2500);
			if (who === "archive") return reply(res, "ARCHIVE-FOLLOW-UP 这句不该被要出来");
			// Answered late, so the breathing mark of a running conversation is on screen long enough to be seen.
			if (who === "child") return reply(res, "CHILD-OK 搜过了，legacyLogin 没有调用方，已删掉它和对应的测试。", undefined, 7000);
			return reply(res, "好");
		});
	});
	server.listen(MODEL_PORT, "127.0.0.1");
	return server;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

async function seed(home: string): Promise<string> {
	const project = join(home, "project");
	await mkdir(join(project, "src"), { recursive: true });
	await writeFile(join(project, "src", "auth.ts"), "export function legacyLogin() {}\nexport function login() {}\n");
	await writeFile(join(project, "README.md"), "# 演示工程\n");
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			uiLocale: "zh-CN",
			providers: [
				{
					id: "local", name: "Local", baseUrl: `http://127.0.0.1:${MODEL_PORT}`, api: "anthropic-messages", apiKey: "not-a-key", enabled: true,
					models: [{ id: "local/scripted", providerId: "local", modelId: "scripted", name: "Scripted", contextWindow: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsImages: false, supportsTools: true }],
				},
			],
			mcpServers: [],
			projects: [{ id: "e2e", name: "演示工程", path: project, pinned: true, lastOpenedAt: Date.now() }],
			defaultModelId: "local/scripted",
			autoSummarizeTitle: false,
			permissionMode: "full",
			thinking: "off",
			retryAttempts: 0,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			sync: { enabled: false, port: 4523, token: null },
			// 截图拍不出毛玻璃：侧栏会是一片灰，浅色的线和点在上面看不见。关掉它，截图里就是不透明时的真实颜色。
			appearance: { theme: "dark", vibrancy: false },
		}),
	);
	return project;
}

// ---------------------------------------------------------------------------
// Driving the window
// ---------------------------------------------------------------------------

let app: RunningApp;

async function until(expression: string, what: string, ms = 30_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await app.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return true;
		await pause(200);
	}
	console.log(`   …等不到：${what}`);
	return false;
}

/** Whether the fake model has been asked by `who` yet, within 20 seconds. */
async function heard(who: string): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if (asked.some((one) => one.who === who)) return true;
		await pause(200);
	}
	return false;
}

const center = (selector: string) =>
	app.evaluate<{ x: number; y: number } | null>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`,
	);

/** A real mouse: settle the target, prove the point lands on it, then move, press, release. */
async function press(selector: string, what: string): Promise<void> {
	if (!(await until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`, what, 20_000))) throw new Error(`找不到要点的：${what}`);
	let point = await center(selector);
	for (let i = 0; i < 12; i++) {
		await pause(90);
		const again = await center(selector);
		if (again && point && again.x === point.x && again.y === point.y) break;
		point = again;
	}
	if (!point) throw new Error(`量不到位置：${what}`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	await pause(250);
	await app.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const x = ${point.x}; const y = ${point.y}; ${landsOn(what)} return true; })()`);
	await app.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await app.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function ask(text: string): Promise<void> {
	await app.evaluate(`(() => {
		const field = document.querySelector("main textarea");
		if (!field) throw new Error("no composer");
		field.focus();
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(field, ${JSON.stringify(text)});
		field.dispatchEvent(new Event("input", { bubbles: true }));
	})()`);
	await pause(900);
	await app.evaluate(`document.querySelector("main textarea").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
}

/** The conversation on screen, by the sidebar row that says it is the open one. */
// Scoped to the rows: other navigation (the sidebar's tabs) also says `aria-current`, and matching it read as "no conversation open".
const activeRow = () => app.evaluate<string | null>(`document.querySelector('[data-ly-row] [aria-current="page"]')?.closest("[data-ly-row]")?.getAttribute("data-ly-row") ?? null`);
const transcript = () => app.evaluate<string>(`document.querySelector("main")?.innerText ?? ""`);
type Meta = { id: string; title: string; projectId: string; archived?: boolean; spawnedFrom?: { sessionId: string; toolCallId: string; reportBack?: true } };
const listed = () => app.evaluate<Meta[]>(`window.plume.sessions.list()`);

/** `clip`: a selector, or several whose boxes are taken together (a parent row and the row nested under it). */
async function shot(name: string, clip?: string | string[]): Promise<void> {
	const selectors = clip === undefined ? [] : Array.isArray(clip) ? clip : [clip];
	const box = selectors.length
		? await app.evaluate<{ x: number; y: number; width: number; height: number } | null>(
				`(() => { const rs = ${JSON.stringify(selectors)}.map((one) => document.querySelector(one)?.getBoundingClientRect()).filter(Boolean); if (!rs.length) return null; const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)), right = Math.max(...rs.map((r) => r.right)), bottom = Math.max(...rs.map((r) => r.bottom)); return { x: Math.max(0, x - 16), y: Math.max(0, y - 16), width: right - x + 32, height: bottom - y + 32 }; })()`,
			)
		: null;
	const { data } = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(box ? { clip: { ...box, scale: 1 } } : {}) });
	await writeFile(join(OUT_DIR, `${STAMP}_${name}.png`), Buffer.from(data, "base64"));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });
	const home = await mkdtemp(join(tmpdir(), "plume-session-ops-"));
	// Commands and skills under ~/.claude would be read into the profile and into the pictures.
	const claudeDir = await mkdtemp(join(tmpdir(), "plume-session-ops-claude-"));
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	await seed(home);
	const model = startModel();
	const frames: Frame[] = [];
	let stopRecording: (() => Promise<void>) | null = null;
	try {
		app = await startApp({ port: PORT, reuseHome: home, scaleFactor: 2 });
		stopRecording = await startRecording(PORT, frames);
		await until(`document.querySelector("main textarea")`, "输入框");
		await pause(1200);

		console.log("【一】模型在做手头的事时，建议另开一个会话：卡片就在它提出来的地方");
		await ask(SPAWN_ASK);
		const CARD = "[data-ly-session-suggestion]";
		const ITEM = "[data-ly-environment-suggestion]";
		// 参数一段段写进来的那几秒：每 80ms 看一眼那个位置画的是什么。
		const seen: { state: string | null; section: boolean; start: boolean; title: string; summary: string; disabled: boolean | null }[] = [];
		let shotWriting = false;
		for (let i = 0; i < 200; i++) {
			const now = await app.evaluate<(typeof seen)[number]>(`(() => {
				const one = document.querySelector("${CARD}");
				const start = one?.querySelector('[data-ly-suggestion-action="start"]');
				return { state: one?.getAttribute("data-ly-session-suggestion") ?? null, section: one?.tagName === "SECTION", start: Boolean(start), title: one?.querySelector("[data-ly-suggestion-title]")?.textContent ?? "", summary: one?.querySelector("[data-ly-suggestion-summary]")?.textContent ?? "", disabled: start ? start.disabled : null };
			})()`);
			seen.push(now);
			if (now.state === "writing" && now.title.length > 4 && !shotWriting) {
				shotWriting = true;
				await shot("00_参数还在写_一行过程行", CARD);
			}
			if (now.state === "suggested") break;
			await pause(80);
		}
		const writing = seen.filter((one) => one.state === "writing");
		console.log(`      写的那几秒看到 ${writing.length} 帧：${[...new Set(writing.map((one) => one.title))].join(" → ")}`);
		check("参数还在写时是一行过程行：没有卡片框、没有「开始」，标题写到哪画到哪", writing.length >= 3 && writing.every((one) => !one.section && !one.start) && new Set(writing.map((one) => one.title)).size >= 2, JSON.stringify(writing.slice(0, 3)));
		const first = seen.find((one) => one.state === "suggested");
		check("写完整张卡片一次出现：第一帧就有完整标题、说明和能按的「开始」", Boolean(first && first.section && first.title === TITLE && first.summary === SUMMARY && first.disabled === false), JSON.stringify(first ?? null));
		const carded = await until(`document.querySelector('${CARD}[data-ly-session-suggestion="suggested"]') && document.body.innerText.includes("SPAWN-DONE")`, "卡片和这一轮的收尾");
		check("这一轮跑完了，对话里有一张等人决定的卡片", carded, (await transcript()).slice(-300));
		await pause(1200);
		const card = await app.evaluate<{ title: string; summary: string; start: string; report: string | null; visible: boolean; order: number[] }>(`(() => {
			const one = document.querySelector("${CARD}");
			const text = document.querySelector("main")?.innerText ?? "";
			return {
				title: one?.querySelector("[data-ly-suggestion-title]")?.textContent ?? "",
				summary: one?.querySelector("[data-ly-suggestion-summary]")?.textContent ?? "",
				start: one?.querySelector('[data-ly-suggestion-action="start"]')?.textContent ?? "",
				report: one?.querySelector("[data-ly-suggestion-report]")?.getAttribute("aria-pressed") ?? null,
				visible: Boolean(one?.checkVisibility()),
				order: [text.indexOf("先修登录按钮"), text.indexOf(${JSON.stringify(TITLE)}), text.indexOf("SPAWN-DONE")],
			};
		})()`);
		check("卡片上是标题 / 说明 / 开始，没有折进过程", card.title === TITLE && card.summary === SUMMARY && card.start === "开始" && card.visible, JSON.stringify(card));
		check("卡片站在调用的位置：提建议那句话之后、这一轮的回答之前", card.order[0] >= 0 && card.order[0] < card.order[1] && card.order[1] < card.order[2], JSON.stringify(card.order));
		check("模型没要交回，卡片上的「交回这里」默认关着", card.report === "false", String(card.report));
		check("右上角环境按钮上挂了一个圆点", await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-environment-dot]"))`));
		const callId = await app.evaluate<string>(`document.querySelector("${CARD}")?.getAttribute("data-ly-suggestion-call") ?? ""`);
		const origin = await activeRow();
		// Everything below compares against this; null would let "still on the same conversation" pass for nothing.
		check("提建议的对话是侧栏里选中的那一行", Boolean(origin), String(origin));
		const rowsBefore = await app.evaluate<number>(`document.querySelectorAll("[data-ly-row]").length`);
		check("开始之前什么都没跑：模型只被问了这一个对话", asked.every((one) => one.who === "spawn"), JSON.stringify(asked.map((one) => one.who)));
		await shot("01_对话里的建议卡片");
		await shot("01b_建议卡片特写", CARD);

		console.log("\n【二】真鼠标点卡片上的「开始」");
		await press(`${CARD} [data-ly-suggestion-action="start"]`, "开始");
		const started = await until(`document.querySelector('${CARD}[data-ly-session-suggestion="started"]')`, "卡片缩成已开始的一行");
		const LATE = `${CARD}[data-ly-session-suggestion="started"] [data-ly-suggestion-report]`;
		const gliding = await until(`document.querySelector("${CARD} .ly-glide") && document.querySelector('${LATE}')`, "那一行在扫光、挂着交回开关");
		const row = await app.evaluate<{ marks: number; status: number; text: string; late: string | null }>(`(() => {
			const one = document.querySelector("${CARD}");
			return { marks: one?.querySelectorAll("[data-ly-status-mark]").length ?? -1, status: one?.querySelectorAll("[data-ly-suggestion-status]").length ?? -1, text: one?.textContent ?? "", late: document.querySelector('${LATE}')?.getAttribute("aria-pressed") ?? null };
		})()`);
		check("卡片缩成一行：行首是新会话图标、不是状态点，行尾不写「进行中」「已开始」", started && gliding && row.marks === 0 && row.status === 0 && !/进行中|已开始|已完成/.test(row.text), JSON.stringify(row));
		check("第一轮在跑，那一行后面挂着「交回这里」，默认关", row.late === "false", String(row.late));
		await shot("02a_开始后那一行_交回关着", CARD);
		console.log("\n【二b】开始以后改主意：真鼠标打开那一行上的「交回这里」");
		await press(LATE, "交回这里");
		const turnedOn = await until(`document.querySelector('${LATE}')?.getAttribute("aria-pressed") === "true"`, "交回开着");
		const child = (await listed()).find((meta) => meta.spawnedFrom?.toolCallId === callId);
		check("新会话记着它是从这条建议开出来的，开始以后打开的交回也写进了 meta", turnedOn && Boolean(child) && child?.spawnedFrom?.sessionId === origin && child?.spawnedFrom?.reportBack === true, JSON.stringify(child?.spawnedFrom ?? null));
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
		await pause(500);
		await shot("02a2_开始后那一行_交回打开", CARD);
		const inSidebar = child ? await until(`document.querySelector('[data-ly-row="${child.id}"]')`, "侧栏里的新会话") : false;
		const rowsAfter = await app.evaluate<number>(`document.querySelectorAll("[data-ly-row]").length`);
		check("新会话出现在侧栏", inSidebar && rowsAfter === rowsBefore + 1, `${rowsBefore} → ${rowsAfter}`);
		if (child && origin) {
			const nest = await app.evaluate<{ nested: boolean; above: string | null; branchX: number; markX: number; indent: number; inside: boolean; line: { h: number; w: number; color: string; top: string } | null }>(`(() => {
				const rows = [...document.querySelectorAll("[data-ly-row]")];
				const row = document.querySelector('[data-ly-row="${child.id}"]');
				const parent = document.querySelector('[data-ly-row="${origin}"]');
				const lineEl = row?.querySelector("[data-ly-row-branch] > span");
				const line = lineEl?.getBoundingClientRect();
				const box = row?.getBoundingClientRect();
				const mark = (el) => { const r = el?.querySelector("[data-ly-status-mark]")?.parentElement?.getBoundingClientRect(); return r ? r.left + r.width / 2 : -1; };
				const title = (el) => el?.querySelector(".ly-fade-tail")?.getBoundingClientRect().left ?? -1;
				return {
					nested: row?.hasAttribute("data-ly-row-nested") ?? false,
					above: rows[rows.indexOf(row) - 1]?.getAttribute("data-ly-row") ?? null,
					branchX: line ? line.left : -1,
					markX: mark(parent),
					indent: title(row) - title(parent),
					// 整条线落在这一行自己的框里：不往上伸去连父会话，也不越过这一行的悬停底色。
					inside: Boolean(line && box && line.top >= box.top + 2 && line.bottom <= box.bottom),
					// What is actually on top at the middle of the line's upright: the line, or something covering it.
					line: line ? { h: line.height, w: line.width, color: getComputedStyle(lineEl).borderLeftColor, top: document.elementFromPoint(line.left + 0.5, line.top + line.height / 2)?.outerHTML.slice(0, 80) ?? "" } : null,
				};
			})()`);
			check("侧栏里它挂在提建议的那一行下面，不是并排的一行", nest.nested && nest.above === origin, JSON.stringify(nest));
			// 拐角在父会话那枚状态点的竖线位置再往右 5px，子行缩进一格。
			check("分支拐角在父会话状态点右侧 5px，子行缩进一格", Math.abs(nest.branchX - nest.markX - 4) <= 1.5 && nest.indent >= 25 && nest.indent <= 29, JSON.stringify(nest));
			console.log(`      分支线：${JSON.stringify(nest.line)}`);
			check("分支线是这一行里的一小段「└」：不越过这一行的框、不往上连到父会话", nest.inside && Boolean(nest.line && nest.line.h >= 6 && nest.line.h <= 12 && nest.line.w >= 6 && nest.line.top.includes("rounded-bl")), JSON.stringify({ inside: nest.inside, line: nest.line }));
		}
		const childAnswered = await heard("child");
		const childAsk = asked.find((one) => one.who === "child");
		check("新会话自己在后台跑了：发给模型的第一条就是建议背后那段提示词", childAnswered && childAsk?.firstUser === CHILD, childAsk?.firstUser ?? "（新会话没有问过模型）");
		await pause(600);
		await shot("02_点开始之后_侧栏挂在下面_在跑");
		if (child && origin) await shot("02b_侧栏父子两行特写", [`[data-ly-row="${origin}"]`, `[data-ly-row="${child.id}"]`]);
		await shot("02c_卡片在跑特写", CARD);

		console.log("\n【三】它跑完第一轮，回复交回提建议的那个对话");
		const delivered = await until(`document.querySelector('[data-delivery-kind="session"]') && document.body.innerText.includes("REPORT-ACK")`, "交回那一行和主会话接着说的话", 40_000);
		const deliveryText = await app.evaluate<string>(`document.querySelector('[data-delivery-kind="session"]')?.textContent ?? ""`);
		check("主会话里多了一行「来自新会话 · 标题」，接着就着它说了一段", delivered && deliveryText.includes("来自新会话") && deliveryText.includes(TITLE), deliveryText);
		const report = asked.find((one) => one.who === "report");
		check("交给主会话模型的是那个会话最后那段回复", Boolean(report?.lastText.includes("CHILD-OK")) && Boolean(report?.lastText.includes(`title="${TITLE}"`)), (report?.lastText ?? "（主会话没被叫醒）").slice(0, 300));
		const finished = await until(`!document.querySelector("${CARD} .ly-glide") && !document.querySelector('${LATE}') && !document.querySelector("${CARD} [data-ly-suggestion-status]")`, "那一行停了扫光、交回开关走了");
		check("第一轮结束：那一行停了扫光，交回开关跟着走了，行尾没有多一句「已完成」", finished, await app.evaluate<string>(`document.querySelector("${CARD}")?.outerHTML.slice(0, 300) ?? ""`));
		check("当前视图没切走：打开的还是原来那个对话", (await activeRow()) === origin && (await transcript()).includes("SPAWN-DONE"), `${await activeRow()} vs ${origin}`);
		if (child) {
			const stored = await app.evaluate<{ role: string; text: string }[]>(`window.plume.sessions.transcript(${JSON.stringify(child.id)}).then((s) => (s?.messages ?? []).map((m) => ({ role: m.role, text: (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === "text").map((c) => c.text).join("") })))`);
			check("新会话的记录里，第一条是那段提示词，后面跟着它自己的回答", stored[0]?.role === "user" && stored[0]?.text === CHILD && stored.some((one) => one.role === "assistant" && one.text.includes("CHILD-OK")), JSON.stringify(stored).slice(0, 300));
		}
		// 先把鼠标挪开：停在回复上会挂出时间的提示，盖住要拍的那一行。
		await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
		await pause(800);
		await shot("03_交回主会话");
		await shot("03b_交回那一行特写", ['[data-delivery-kind="session"]', CARD]);
		await pause(1200);

		console.log("\n【四】重启：卡片还是「已开始」，侧栏还挂着，交回只交过一次");
		await stopRecording();
		stopRecording = null;
		await app.stop();
		await pause(1500);
		app = await startApp({ port: PORT, reuseHome: home, scaleFactor: 2 });
		stopRecording = await startRecording(PORT, frames);
		await until(`document.querySelector("main textarea")`, "输入框");
		await pause(1000);
		if (origin) await press(`[data-ly-row="${origin}"]`, "原来那个对话");
		const reopened = await until(`document.body.innerText.includes("REPORT-ACK") && document.querySelector('${CARD}[data-ly-session-suggestion="started"]') && document.querySelector('[data-delivery-kind="session"]')`, "重开后卡片和交回那一行都在");
		check("重启后打开原对话：卡片是「已开始」，交回那一行还在，按钮上没有圆点", reopened && !(await app.evaluate<boolean>(`Boolean(document.querySelector("[data-ly-environment-dot]"))`)), String(reopened));
		// 环境卡片这一路没人打开过；打开它，那一节说的和卡片是同一件事。
		await press("[data-ly-environment-toggle]", "环境按钮");
		check("环境卡片里那一条也是「已开始」", await until(`document.querySelector('${ITEM}[data-state="started"]')`, "环境卡片里的已开始"));
		if (child) check("侧栏里还挂在原对话下面", await until(`document.querySelector('[data-ly-row="${child.id}"][data-ly-row-nested]')`, "重启后的子行"));
		const after = child ? (await listed()).find((meta) => meta.id === child.id) : undefined;
		check("条子撕掉了：新会话的 meta 里不再要交回，记着第一轮已经结束", Boolean(after) && after?.spawnedFrom?.reportBack === undefined && after?.spawnedFrom?.settled === true && after?.spawnedFrom?.toolCallId === callId, JSON.stringify(after?.spawnedFrom ?? null));
		check("重启后那一行没有交回开关", !(await app.evaluate<boolean>(`Boolean(document.querySelector('${LATE}'))`)));
		check("主会话只被交回叫醒过一次", asked.filter((one) => one.who === "report").length === 1, JSON.stringify(asked.map((one) => one.who)));
		await pause(1000);
		await shot("04_重启后仍是已开始");

		console.log("\n【五】点卡片那一行切到那个会话");
		await press(`${CARD} [data-ly-suggestion-action="open"]`, "打开");
		const switched = child ? await until(`document.querySelector('[data-ly-row="${child.id}"] [aria-current="page"]') && document.body.innerText.includes("CHILD-OK")`, "切到新会话") : false;
		check("切过去了，看得到新会话自己的回答", switched, String(await activeRow()));
		await pause(1500);
		await shot("05_打开新会话");

		console.log("\n【六】归档自己");
		await app.evaluate(`[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "新对话")?.setAttribute("data-qa-new-chat", "")`);
		await press("[data-qa-new-chat]", "新对话");
		await until(`!document.querySelector('[data-ly-row] [aria-current="page"]')`, "空白的新对话");
		await pause(800);
		await ask(ARCHIVE_ASK);
		await until(`document.body.innerText.includes("ARCHIVE-PROBE")`, "发出去了", 15_000);
		await pause(400);
		await shot("06_归档之前");
		const archivedMeta = await (async () => {
			for (let i = 0; i < 150; i++) {
				const found = (await listed()).find((meta) => meta.title.includes("ARCHIVE-PROBE") && meta.archived === true);
				if (found) return found;
				await pause(200);
			}
			return null;
		})();
		check("会话进了归档", Boolean(archivedMeta), JSON.stringify((await listed()).map((meta) => [meta.title.slice(0, 20), meta.archived ?? false])));
		await pause(1500);
		const archiveAsks = asked.filter((one) => one.who === "archive");
		check("这一轮停在归档那一下：模型只被问了一次，没有再追一句", archiveAsks.length === 1 && !archiveAsks.some((one) => one.answered), JSON.stringify(archiveAsks));
		if (archivedMeta) {
			const trail = await app.evaluate<string>(`window.plume.sessions.trajectory(${JSON.stringify(archivedMeta.id)}).then((entries) => JSON.stringify(entries))`);
			check("这一轮正常收尾：执行结束 · done，没有被砍成 aborted", trail.includes("执行结束 · done") && !trail.includes("执行结束 · aborted"), trail.slice(0, 200));
			const stored = await app.evaluate<{ role: string; isError?: boolean }[]>(`window.plume.sessions.transcript(${JSON.stringify(archivedMeta.id)}).then((s) => (s?.messages ?? []).map((m) => ({ role: m.role, isError: m.isError })))`);
			check("最后那条工具结果落进了记录，不是错误", stored.at(-1)?.role === "toolResult" && stored.at(-1)?.isError !== true, JSON.stringify(stored));
			const left = await until(`!document.querySelector('[data-ly-row="${archivedMeta.id}"]') && !document.querySelector("main")?.innerText.includes("ARCHIVE-PROBE")`, "界面离开");
			check("界面离开了它：侧栏没有这一行，屏幕上不再是这个对话", left, String(await activeRow()));
			await shot("07_归档之后_界面离开");
			await pause(1000);
		}
	} catch (error) {
		check("探针完整跑完", false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	} finally {
		if (stopRecording) await stopRecording().catch(() => {});
		await app?.stop().catch(() => {});
		await closeListeningServer(model);
		await rm(home, { recursive: true, force: true }).catch(() => {});
		await rm(claudeDir, { recursive: true, force: true }).catch(() => {});
	}

	const passed = checks.filter((one) => one.ok).length;
	console.log(`\n${passed}/${checks.length} 项通过，采到 ${frames.length} 帧`);
	if (frames.length > 0) {
		const out = join(OUT_DIR, `${STAMP}_会话级操作_${passed}of${checks.length}.mp4`);
		await encode(frames, out, 60, 1500);
		console.log(`视频：${out}`);
	}
	console.log(`截图：${OUT_DIR}`);
	if (passed !== checks.length) process.exitCode = 1;
}

await main();
