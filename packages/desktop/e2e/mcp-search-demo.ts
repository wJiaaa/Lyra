/* oxlint-disable no-console -- real-window verification prints measured evidence */
/**
 * MCP 延迟加载在真窗口里走一遍：接 30 台 MCP 服务器以后，请求的工具表里没有任何 MCP 工具，只有两个
 * 入口；系统提示词里有一份目录。内置工具（preview、生图、跨会话、浏览器……）从第一次请求起全在。
 *
 * - MCP：模型 `mcp_search` 再 `mcp_call`，对话里是一张搜索卡片和一张那台服务器的工具卡片。
 * - 内置：模型直接叫 `preview`，前缀一个字节不变。
 * - 人打开浏览器面板：工具表不变，模型直接叫 `browser_tabs`，前缀一个字节不变。
 * - 设置页把 Linear 拨成「常驻」：下一轮它的工具直接进了工具表。
 *
 * 30 台服务器是 `mcp-defer-server.ts`（`core/test/mcp-catalog-fixture.ts` 的工具，真的 stdio 进程）；
 * 模型是本进程里一台说 Anthropic SSE 的假服务器。应用跑在 `startApp` 给的一次性 PLUME_HOME 里，
 * 不碰 `~/.plume`，跑完连目录一起删。
 *
 * 用法：先 `pnpm --filter @plume/desktop build`，再
 * `node --experimental-strip-types packages/desktop/e2e/mcp-search-demo.ts`
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { comparePrefix, payloadSegments } from "../../core/src/ai/prefix-fingerprint.ts";
import { FIXTURE_SERVERS } from "../../core/test/mcp-catalog-fixture.ts";
import { closeListeningServer, startApp, type RunningApp } from "./app.ts";
import { click, closeSettings, expandLastTurn, frames as settleFrames, openPane, openSession, openSettings, press, until } from "./drive.ts";
import { encode, pause, startRecording, type Frame } from "./record.ts";
import { seedSessions } from "./session-fixture.ts";

const OUT = join(homedir(), "Desktop", "Plume工具延迟加载测试");
const STAMP = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[: ]/g, "-").slice(0, 16);
const PORT = 9813;
const SESSION = "mcp-defer";
const SERVER = join(import.meta.dirname, "mcp-defer-server.ts");
const ISSUE = { title: "Login fails on Safari", team: "ENG", priority: 2 };
const PAGE = `<div style="display:flex;gap:12px;align-items:flex-end;height:120px">${[["Q1", 120], ["Q2", 150], ["Q3", 90], ["Q4", 180]].map(([q, v]) => `<div style="flex:1;text-align:center"><div style="height:${Number(v) / 2}px;background:var(--chart-1);border-radius:4px"></div><small>${q} ${v}</small></div>`).join("")}</div>`;
/** 曾经试过延迟、现在一律常驻的那几件内置工具（`docs/architecture/mcp-search.md`）。 */
const RESIDENT_BUILTINS = ["preview", "image_generate", "learn", "list_sessions", "send_message", "wait_for_session"];
const BROWSER = ["browser_open", "browser_act", "browser_tabs", "browser_viewport", "browser_screenshot"];

const checks: { name: string; ok: boolean; measured: unknown }[] = [];
const check = (name: string, ok: boolean, measured: unknown) => {
	checks.push({ name, ok, measured });
	console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(measured)}`);
};

type Body = { tools?: { name: string }[]; system?: unknown; messages: { role: string; content: unknown }[] };
/** 模型每次收到的请求体，按先后。 */
const requests: Body[] = [];

function model() {
	return createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const body = JSON.parse(raw) as Body;
			requests.push(body);
			const last = body.messages.findLastIndex((message) => message.role === "assistant");
			const tail = JSON.stringify(body.messages.slice(last + 1));
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (tail.includes('"tool_use_id":"call-search"')) reply(res, "", { id: "call-mcp", name: "mcp_call", input: { tool: "mcp__linear__create_issue", arguments: ISSUE } });
			else if (tail.includes('"tool_use_id":"call-preview"')) reply(res, "图在上面：Q4 最高。");
			else if (tail.includes('"tool_use_id":"call-tabs"')) reply(res, "浏览器里开着一个空白标签。");
			else if (tail.includes('"tool_result"')) reply(res, "建好了：ENG 团队的「Login fails on Safari」。");
			else if (tail.includes("LINEAR")) reply(res, "", { id: "call-search", name: "mcp_search", input: { query: "linear create issue" } });
			else if (tail.includes("CHART")) reply(res, "", { id: "call-preview", name: "preview", input: { title: "季度销售", html: PAGE } });
			else if (tail.includes("BROWSER")) reply(res, "", { id: "call-tabs", name: "browser_tabs", input: { action: "list" } });
			else if (tail.includes("PINNED")) reply(res, "", { id: "call-direct", name: "mcp__linear__create_issue", input: ISSUE });
			else reply(res, "收到。");
		});
	});
}

function reply(res: ServerResponse, text: string, tool?: { id: string; name: string; input: object }) {
	const emit = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	emit("message_start", { message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 50, output_tokens: 0 } } });
	emit("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" } });
	emit("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
	emit("content_block_stop", { index: 0 });
	emit("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } });
	emit("message_stop", {});
	res.end();
}

async function seed(home: string, modelPort: number): Promise<void> {
	const cwd = join(home, "project");
	const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "README.md"), "# mcp\n");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const meta = { id: SESSION, title: "MCP 延迟加载", cwd, projectId, projectName: "MCP", createdAt: 1, updatedAt: 2, modelId: "qa/model", messageCount: 2, usage, seq: 3 };
	seedSessions(home, [{ meta, records: [
		{ type: "meta", meta, seq: 0, ts: 1 },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "开始吧。" }], timestamp: 1 }, seq: 1, ts: 1 },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "好。" }], api: "anthropic-messages", provider: "qa", model: "qa", usage, stopReason: "stop", timestamp: 2 }, seq: 2, ts: 2 },
		{ type: "meta", meta, seq: 3, ts: 3 },
	] }]);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 860, x: 40, y: 40 }));
	await writeFile(join(home, "settings.json"), JSON.stringify({
		providers: [{ id: "qa", name: "隔离测试模型", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${modelPort}`, apiKey: "test", enabled: true,
			models: [{ id: "qa/model", providerId: "qa", modelId: "model", name: "QA", contextWindow: 200000, maxOutputTokens: 4096, supportsImages: true, supportsTools: true, supportsThinking: false }] }],
		defaultModelId: "qa/model",
		mcpServers: FIXTURE_SERVERS.map((server) => ({ id: server.id, name: server.name, transport: "stdio", command: process.execPath, args: [SERVER], env: { FIXTURE_SERVER: server.id }, enabled: true })),
		hooks: [],
		permissionMode: "full",
		thinking: "off",
		projectMemory: false,
		appearance: { theme: "light", reduceMotion: "off" },
		projects: [{ id: projectId, path: cwd, name: "MCP", pinned: true, lastOpenedAt: 1 }],
	}));
}

const modelServer = model();
let app: RunningApp | undefined;
let stopRecording: (() => Promise<void>) | undefined;
const recorded: Frame[] = [];
let shots = 0;

async function snap(name: string): Promise<void> {
	await mkdir(OUT, { recursive: true });
	const image = await app!.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	shots += 1;
	await writeFile(join(OUT, `${STAMP}_${String(shots).padStart(2, "0")}_${name}.png`), Buffer.from(image.data, "base64"));
}

const beat = (ms = 1000) => pause(ms);
/** 把对话里写着这段字的那一处滚到视口里（`block`：放在上沿还是中间），截图要拍的是它。 */
async function reveal(text: string, block: "start" | "center" = "center"): Promise<void> {
	await app!.evaluate(`(()=>{
		const walker=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);
		let last=null;
		while(walker.nextNode()) if(walker.currentNode.textContent.includes(${JSON.stringify(text)})) last=walker.currentNode.parentElement;
		last?.scrollIntoView({block:${JSON.stringify(block)}});
	})()`);
	await settleFrames(app!, 12);
}
const mainText = () => app!.evaluate<string>(`document.querySelector('main')?.textContent ?? ''`);
const replies = async () => (await mainText()).split("建好了").length - 1;

async function send(text: string): Promise<void> {
	await click(app!, "main textarea");
	await app!.send("Input.insertText", { text });
	await settleFrames(app!, 4);
	await press(app!, "Enter", 13);
}

const toolNames = (body: Body) => (body.tools ?? []).map((tool) => tool.name);
/** 目录里出现过的服务器：冻结的系统提示词，加上历史里的增量。 */
const catalogued = (body: Body) => new Set([...JSON.stringify([body.system, body.messages]).matchAll(/- MCP server [^\n(]+ \(`([a-z0-9-]+)`, \d+ tools\)/g)].map((match) => match[1]));
const prefixChange = (a: Body, b: Body) => comparePrefix(payloadSegments(a), payloadSegments(b)).change ?? null;

try {
	await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
	const address = modelServer.address();
	assert.ok(address && typeof address !== "string");
	app = await startApp({ port: PORT, seed: (home) => seed(home, address.port) });
	stopRecording = await startRecording(PORT, recorded);
	await app.evaluate("document.fonts.ready");
	await openSession(app, SESSION);
	await beat();

	console.log("— 0. 先说一句，让会话把 30 台服务器连起来");
	await send("你好");
	await until(app, `document.querySelector('main').textContent.includes('收到。')`, 1800);
	await openSettings(app, "插件");
	await click(app, '[data-tab="mcp"]');
	await until(app, `[...document.querySelectorAll('[data-mcp-server]')].filter(c=>/\\d+ 个工具/.test(c.textContent)).length === ${FIXTURE_SERVERS.length}`, 3600);
	check("30 台服务器都连上了", true, FIXTURE_SERVERS.length);
	await closeSettings(app);
	await openSession(app, SESSION);

	console.log("— 1. 工具表里没有 MCP 工具，只有两个入口，内置工具全在；目录在提示词里");
	const startAt = requests.length;
	await send("LINEAR 在 Linear 里给 ENG 建一个 issue：Login fails on Safari，优先级高");
	await until(app, `document.querySelector('main').textContent.includes('建好了')`, 1800);
	const turn = requests.slice(startAt);
	const first = turn[0]!;
	const names = toolNames(first);
	check("请求的工具表里没有任何 mcp__ 工具，有 mcp_search 和 mcp_call 两个入口", !names.some((name) => name.startsWith("mcp__")) && names.includes("mcp_search") && names.includes("mcp_call"), { count: names.length, entries: names.filter((name) => name.startsWith("tool_")) });
	check("内置工具从第一次请求起全在工具表里（preview、生图、learn、跨会话）", [...RESIDENT_BUILTINS, "bash", "read", "edit", "recall", "lsp", "symbol"].every((name) => names.includes(name)), RESIDENT_BUILTINS.filter((name) => names.includes(name)));
	check("浏览器 5 件一开始就在工具表里", BROWSER.every((name) => names.includes(name)), names.filter((name) => name.startsWith("browser_")));
	check("目录里列着全部 30 台服务器", catalogued(first).size === FIXTURE_SERVERS.length, catalogued(first).size);
	const system = JSON.stringify(first.system);
	check("目录里只有 MCP 服务器，没有内置工具的行", system.includes("## MCP tools to search for") && !system.includes("- `preview`") && !system.includes("- `list_sessions`"), /## MCP tools to search for/.exec(system)?.[0]);
	const toolsChars = JSON.stringify(first.tools).length;
	check("工具表大小（字符）", toolsChars < 40_000, toolsChars);

	console.log("— 2. MCP：搜索 → 调用，一张搜索卡片、一张真正那台服务器的卡片");
	check("这一轮三次请求：搜索、调用、收尾", turn.length === 3, turn.length);
	const changes = turn.slice(1).map((now, index) => prefixChange(turn[index]!, now));
	check("三次请求之间，前缀（工具表、系统提示词、更早的消息）一个字节都没变", changes.every((change) => change === null), changes);
	await expandLastTurn(app, `document.querySelector('main').textContent.includes('Input schema')`);
	await beat(800);
	const text = await mainText();
	check("对话里有搜索卡片", text.includes("Search MCP tools “linear create issue”"), /Search MCP tools[^S]{0,40}/.exec(text)?.[0]);
	check("搜索结果里排第一的是 Linear 的 create_issue", /mcp__linear__create_issue — MCP Linear: create_issue/.test(text), /mcp__linear__create_issue[^\n]{0,40}/.exec(text)?.[0]);
	check("调用画成 Linear: create_issue 那台服务器的卡片，不是 mcp_call", text.includes("Linear: create_issue") && !/mcp_call/.test(text.replace(/Call one with mcp_call/g, "")), /Linear: create_issue/.exec(text)?.[0]);
	await reveal("使用工具 2 个", "start");
	await snap("MCP_搜索卡片与工具卡片");
	await expandLastTurn(app, `document.querySelector('main').textContent.includes('ok: Linear create_issue')`);
	await beat(800);
	check("服务器收到的参数就是模型给的那份", (await mainText()).includes(`ok: Linear create_issue ${JSON.stringify(ISSUE)}`), /ok: Linear create_issue[^}]*}/.exec(await mainText())?.[0]);
	await reveal("Linear: create_issue", "start");
	await snap("MCP_调用结果");

	console.log("— 3. 内置：preview 本来就在工具表里，模型直接叫它");
	const chartAt = requests.length;
	await send("CHART 把四个季度的销售画成柱状图");
	await until(app, `document.querySelector('main').textContent.includes('图在上面')`, 1800);
	const chart = requests.slice(chartAt);
	check("这一轮两次请求：直接调 preview、收尾，不经 mcp_search / mcp_call", chart.length === 2 && JSON.stringify(chart[1]!.messages).includes('"name":"preview"'), chart.length);
	check("preview 在这一轮的工具表里", toolNames(chart[0]!).includes("preview"), "preview");
	const chartChanges = [prefixChange(turn.at(-1)!, chart[0]!), prefixChange(chart[0]!, chart[1]!)];
	check("从上一轮到这一轮的两次请求，前缀一个字节都没变", chartChanges.every((change) => change === null), chartChanges);
	await until(app, `document.querySelector('main [data-ly-preview]')`, 1800);
	await beat(1200);
	check("对话里画出了 preview 卡片（页面就在回复上方）", await app.evaluate<boolean>(`Boolean(document.querySelector('main [data-ly-preview]'))`), "main [data-ly-preview]");
	await reveal("图在上面", "center");
	await snap("内置preview从第一次请求起就在工具表里");

	console.log("— 4. 人打开浏览器面板：工具表不变，浏览器工具本来就在");
	const browserAt = requests.length;
	await openPane(app, "浏览器");
	await until(app, `document.querySelector('[data-panel-tab^="browser:"]')`, 1800);
	await beat(1000);
	await send("BROWSER 看看浏览器里开着什么");
	await until(app, `document.querySelector('main').textContent.includes('浏览器里开着一个空白标签')`, 1800);
	const browsing = requests.slice(browserAt);
	const browsingNames = toolNames(browsing[0]!);
	check("工具表和第一次请求时一模一样：浏览器 5 件和 preview 都在", JSON.stringify(browsingNames) === JSON.stringify(names) && [...BROWSER, "preview"].every((name) => browsingNames.includes(name)), browsingNames.filter((name) => name.startsWith("browser_") || name.startsWith("mcp_") || name === "preview"));
	check("开面板前后没有任何目录增量", !JSON.stringify(browsing[0]!.messages).includes("deferred:browser"), "deferred:browser");
	const opened = [prefixChange(chart.at(-1)!, browsing[0]!), ...browsing.slice(1).map((now, index) => prefixChange(browsing[index]!, now))];
	check("开面板前后、这一轮里，前缀一个字节都没变", opened.every((change) => change === null), opened);
	check("模型直接叫 browser_tabs（不经 mcp_search / mcp_call）", JSON.stringify(browsing.at(-1)!.messages).includes('"name":"browser_tabs"'), "browser_tabs");
	await beat(800);
	await reveal("BROWSER 看看浏览器里开着什么", "start");
	await snap("浏览器工具一开始就在工具表里");

	console.log("— 5. 设置页：把 Linear 拨成「常驻」");
	await openSettings(app, "插件");
	await click(app, '[data-tab="mcp"]');
	await until(app, `document.querySelector('[data-mcp-server="linear"]')`, 1800);
	await app.evaluate(`document.querySelector('[data-mcp-server="linear"]').scrollIntoView({ block: 'center' })`);
	await settleFrames(app, 10);
	await click(app, '[data-mcp-server="linear"] button[aria-label="启动方式与环境变量"]');
	await until(app, `document.querySelector('[data-mcp-server="linear"] button[role="switch"][aria-label="常驻"]')?.checkVisibility()`, 1800);
	await beat(800);
	await app.evaluate(`document.querySelector('[data-mcp-server="linear"] button[aria-label="常驻"]').scrollIntoView({ block: 'center' })`);
	await settleFrames(app, 10);
	await click(app, '[data-mcp-server="linear"] button[role="switch"][aria-label="常驻"]');
	await until(app, `document.querySelector('[data-mcp-server="linear"] button[aria-label="常驻"]').getAttribute('aria-checked') === 'true'`, 1800);
	await beat(1000);
	check("常驻开关打开", true, "aria-checked=true");
	await snap("常驻开关_开");
	await closeSettings(app);
	await openSession(app, SESSION);

	console.log("— 6. 下一轮：Linear 的工具直接在工具表里");
	const pinnedAt = requests.length;
	await send("PINNED 再建一个");
	await until(app, `document.querySelector('main').textContent.split('建好了').length - 1 >= 2`, 1800);
	const pinned = requests[pinnedAt]!;
	const pinnedNames = toolNames(pinned);
	const linear = pinnedNames.filter((name) => name.startsWith("mcp__linear__"));
	check("Linear 的 10 个工具进了工具表，其余照旧延迟", linear.length === 10 && pinnedNames.includes("mcp_search") && !pinnedNames.some((name) => name.startsWith("mcp__github__")), { linear: linear.length, total: pinnedNames.length });
	check("系统提示词没动（目录里去掉 Linear 走的是历史末尾的增量）", JSON.stringify(pinned.system) === system && JSON.stringify(pinned.messages).includes('section-update id=\\"deferred:mcp:linear\\" removed=\\"true\\"'), { sameSystem: JSON.stringify(pinned.system) === system });
	check("模型直接叫常驻的工具，调用成功", (await replies()) >= 2, await replies());
	await beat(1200);
	await reveal("PINNED 再建一个", "start");
	await snap("常驻后直接调用");
} catch (error) {
	check("验证脚本跑完", false, String(error));
	console.error(error);
} finally {
	await stopRecording?.();
	await app?.stop();
	await closeListeningServer(modelServer);
	await mkdir(OUT, { recursive: true });
	const pass = checks.filter((item) => item.ok).length;
	const name = `${STAMP}_工具延迟加载_${pass}of${checks.length}`;
	await writeFile(join(OUT, `${name}.json`), JSON.stringify({ checks, requests: requests.map((body) => ({ tools: toolNames(body).length, names: toolNames(body).filter((n) => !n.startsWith("mcp__")) })) }, null, 2));
	if (recorded.length) await encode(recorded, join(OUT, `${name}.mp4`), 30);
	console.log(`证据：${join(OUT, name)}（${recorded.length} 帧）`);
	if (checks.some((item) => !item.ok)) process.exitCode = 1;
}
