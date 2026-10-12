/**
 * MCP 加固：一台慢、会崩、会改工具表、会发进度、会回超大结果的服务器面前，客户端做得对不对。
 *
 * 全部对着真进程（`mcp-stress-server.ts`，SDK 自己的服务端）：要钉住的多半是进程层面的事——
 * 它是不是被重启了、stderr 里写了什么、取消有没有真的送到服务器那一头。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { FRESH_RESULT_MAX_CHARS, pruneToolResults } from "../src/agent/prune.ts";
import { McpManager, type McpManagerOptions, type McpServerStatus, type McpStdioServer } from "../src/mcp/client.ts";
import { MCP_RESULT_CHARS } from "../src/mcp/result.ts";
import { builtInApprovalPolicy } from "../src/runtime/approval-policy.ts";
import { ApprovalGate } from "../src/runtime/approvals.ts";
import { mcpFailureNotice, SessionCapabilities } from "../src/runtime/session-capabilities.ts";
import type { ApprovalRequest, Message, Tool, ToolContext, ToolResult } from "../src/types.ts";

const SCRIPT = fileURLToPath(new URL("./mcp-stress-server.ts", import.meta.url));
const previousHome = process.env.PLUME_HOME;
let dir = "";
const cleanups: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "plume-mcp-hard-"));
	// 大图落进 `session-media`，那在 PLUME_HOME 下面：不能写进真实的 ~/.plume。
	process.env.PLUME_HOME = join(dir, "home");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
	for (const name of await readdir(dir).catch(() => [])) {
		const pid = name.endsWith(".pid") ? Number(name.slice(0, -4)) : NaN;
		if (alive(pid)) process.kill(pid, "SIGKILL");
	}
	await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

after(() => {
	if (previousHome === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = previousHome;
});

function stress(id: string, env: Record<string, string> = {}): McpStdioServer {
	return { id, name: id, transport: "stdio", command: process.execPath, args: [SCRIPT], env: { STRESS_DIR: dir, ...env }, enabled: true };
}

function manager(options: McpManagerOptions = {}): McpManager {
	const made = new McpManager({ timeoutMs: 5000, ...options });
	cleanups.push(() => made.dispose());
	return made;
}

function alive(pid: number): boolean {
	if (!Number.isInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pids(): Promise<number[]> {
	return (await readdir(dir)).filter((name) => name.endsWith(".pid")).map((name) => Number(name.slice(0, -4)));
}

async function until(condition: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await delay(10);
	}
}

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, sessionId: "s", state: new Map(), ...extra });
const textOf = (result: ToolResult) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
const tool = (m: McpManager, suffix: string): Tool => {
	const found = m.allTools().find((one) => one.name.endsWith(`__${suffix}`));
	assert.ok(found, `no tool ending in __${suffix}: ${m.allTools().map((one) => one.name).join(", ")}`);
	return found;
};
const stateOf = (m: McpManager, id: string): McpServerStatus | undefined => m.statuses().find((status) => status.id === id);

// ── 名字 ───────────────────────────────────────────────────────────────────

test("两台服务器的工具撞名（id 清洗后相同）：两边都换成带哈希的名字，各自调到自己的服务器", async () => {
	const m = manager();
	await m.connectAll([stress("a.b", { STRESS_ONLY: '["echo"]' }), stress("a_b", { STRESS_ONLY: '["echo"]' })]);
	const names = m.allTools().map((one) => one.name);
	assert.equal(names.length, 2);
	assert.equal(new Set(names).size, 2, `撞名没有分开：${names.join(", ")}`);
	for (const name of names) assert.match(name, /^mcp__a_b__echo_[0-9a-f]{8}$/);
	// 再连一次，名字一样：取决于 (服务器, 工具)，不取决于谁先连上。
	const again = manager();
	await again.connectAll([stress("a_b", { STRESS_ONLY: '["echo"]' }), stress("a.b", { STRESS_ONLY: '["echo"]' })]);
	assert.deepEqual(again.allTools().map((one) => one.name), names);
});

test("和宿主已有的工具重名：MCP 那个换名字，不覆盖、也不被覆盖", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["echo"]' })]);
	const [renamed] = m.allTools(new Set(["mcp__srv__echo"]));
	assert.notEqual(renamed?.name, "mcp__srv__echo");
	assert.match(renamed!.name, /^mcp__srv__echo_[0-9a-f]{8}$/);
	assert.equal(textOf(await renamed!.execute({}, ctx())), "called echo");
});

test("名字里有要换掉的字符、或超长的，名字只取决于工具自己：换个顺序列出来也不变", async () => {
	const long = `query_${"x".repeat(80)}`;
	const first = manager();
	await first.connectAll([stress("srv", { STRESS_ONLY: "[]", STRESS_TOOLS: JSON.stringify(["a_b", "a.b", long]) })]);
	const second = manager();
	await second.connectAll([stress("srv", { STRESS_ONLY: "[]", STRESS_TOOLS: JSON.stringify([long, "a.b", "a_b"]) })]);
	const names = first.allTools().map((one) => one.name);
	assert.deepEqual(second.allTools().map((one) => one.name), names);
	assert.ok(names.includes("mcp__srv__a_b"), "没被改过字的保留原名");
	for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
});

// ── 启动 ───────────────────────────────────────────────────────────────────

test("并行启动：一台慢、一台启动即崩，不拖住别的服务器，也不拖住会话打开", async () => {
	const failures: McpServerStatus[] = [];
	const can = new SessionCapabilities([], { mcpWait: 0, onMcpFailure: (status) => failures.push(status) });
	cleanups.push(() => can.dispose());
	const servers = [
		...Array.from({ length: 5 }, (_, index) => stress(`ok${index}`, { STRESS_ONLY: '["echo"]' })),
		stress("slow", { STRESS_ONLY: '["echo"]', STRESS_DELAY: "4000" }),
		stress("crash", { STRESS_CRASH: "Cannot find module 'left-pad'" }),
	];
	const started = Date.now();
	await can.load(dir, { ...DEFAULT_SETTINGS, mcpServers: servers });
	assert.ok(Date.now() - started < 1000, `会话打开等了 ${Date.now() - started}ms`);

	// 第一轮开始前只等一小会儿：正常的那几台赶得上，慢的那台不等。
	const waited = Date.now();
	await can.mcpReady(1500);
	assert.ok(Date.now() - waited < 2500, `第一轮等了 ${Date.now() - waited}ms`);
	const mcpTools = () => can.tools.filter((one) => one.name.startsWith("mcp__")).map((one) => one.name).sort();
	assert.deepEqual(mcpTools(), [0, 1, 2, 3, 4].map((index) => `mcp__ok${index}__echo`));
	assert.equal(can.mcpStatuses.find((status) => status.id === "slow")?.state, "connecting");

	// 崩掉的那台：原因带着 stderr 的最后几行，在状态里、也在对话里（`onMcpFailure`）。
	await until(() => failures.some((status) => status.id === "crash"));
	const crash = can.mcpStatuses.find((status) => status.id === "crash")!;
	assert.equal(crash.state, "failed");
	assert.match(crash.stderr ?? "", /Cannot find module 'left-pad'/);

	// 慢的那台连上以后加入工具表——会话从下一轮起用得上它。
	await until(() => can.mcpStatuses.find((status) => status.id === "slow")?.state === "connected", 8000);
	assert.ok(mcpTools().includes("mcp__slow__echo"));
});

test("对话里的失败提示带 stderr 里的原因那一行，不带调用栈", () => {
	const status = (stderr: string) => ({ id: "s", name: "S", transport: "stdio", state: "failed", error: "Connection closed", stderr }) as McpServerStatus;
	const node = mcpFailureNotice(status("starting\nError: config missing\n    at boot (a.ts:1:1)\n    at main (a.ts:2:1)\n"));
	assert.equal(node.type === "notice" && node.params?.error, "Connection closed — Error: config missing");
	const python = mcpFailureNotice(status('Traceback (most recent call last):\n  File "s.py", line 3, in <module>\nKeyError: \'TOKEN\''));
	assert.equal(python.type === "notice" && python.params?.error, "Connection closed — KeyError: 'TOKEN'");
	const quiet = mcpFailureNotice({ ...status(""), stderr: undefined });
	assert.equal(quiet.type === "notice" && quiet.params?.error, "Connection closed");
});

test("单台超时：一台一直不应答的服务器到点失败，进程被关掉", async () => {
	const m = manager({ timeoutMs: 400 });
	const [status] = await m.connectAll([stress("hang", { STRESS_DELAY: "60000" })]);
	assert.equal(status?.state, "failed");
	assert.match(status?.error ?? "", /timed out/);
	const [pid] = await pids();
	await until(() => !alive(pid!), 5000);
});

// ── 重连 ───────────────────────────────────────────────────────────────────

test("运行中退出：退避重连，工具表不变，同一个工具对象照样能用", async () => {
	const changes: McpServerStatus["state"][] = [];
	const m = manager({ reconnect: { baseMs: 50 }, onChange: (status) => changes.push(status.state) });
	await m.connectAll([stress("srv", { STRESS_ONLY: '["echo","exit"]' })]);
	const before = m.allTools();
	const [first] = await pids();
	const exited = await tool(m, "exit").execute({}, ctx());
	assert.equal(exited.isError, true);
	assert.match(textOf(exited), /told to exit/, "失败的调用带着 stderr 的最后几行");
	await until(() => stateOf(m, "srv")?.state === "connected" && changes.includes("reconnecting"));
	const after = await pids();
	assert.equal(after.length, 2, "重新起了一个进程");
	assert.ok(!alive(first!));
	assert.deepEqual(m.allTools(), before, "工具表一字未变：前缀不动");
	assert.equal(textOf(await before.find((one) => one.name.endsWith("__echo"))!.execute({}, ctx())), "called echo");
});

test("重连有上限：一直起不来就放弃，原因写明，工具从表里拿掉", async () => {
	const marker = join(dir, "crash-now");
	const m = manager({ reconnect: { baseMs: 20, attempts: 3 } });
	await m.connectAll([stress("srv", { STRESS_ONLY: '["echo","exit"]', STRESS_CRASH_IF_EXISTS: marker })]);
	await writeFile(marker, "");
	await tool(m, "exit").execute({}, ctx());
	await until(() => stateOf(m, "srv")?.state === "failed", 8000);
	const status = stateOf(m, "srv")!;
	assert.match(status.error ?? "", /Gave up after 3 reconnect attempts/);
	assert.match(status.stderr ?? "", /the marker file says crash/);
	assert.deepEqual(m.allTools(), []);
	assert.equal((await pids()).length, 4, "第一次启动加三次重连");

	// 设置页的「重新连接」：计数清零，马上再来一次。
	await rm(marker);
	await m.reconnect("srv");
	await until(() => stateOf(m, "srv")?.state === "connected");
	assert.equal(stateOf(m, "srv")?.attempt, undefined);
	assert.equal(m.allTools().length, 2);
});

// ── list_changed ───────────────────────────────────────────────────────────

test("tools/list_changed：重列、通知会话，会话的工具表跟着变", async () => {
	const can = new SessionCapabilities();
	cleanups.push(() => can.dispose());
	await can.load(dir, { ...DEFAULT_SETTINGS, mcpServers: [stress("srv", { STRESS_ONLY: '["echo","change"]' })] });
	assert.ok(!can.tools.some((one) => one.name === "mcp__srv__added"));
	await can.tools.find((one) => one.name === "mcp__srv__change")!.execute({}, ctx());
	await until(() => can.tools.some((one) => one.name === "mcp__srv__added"));
	assert.equal(can.mcpStatuses[0]?.toolCount, 3);
});

// ── 超时、取消、进度 ─────────────────────────────────────────────────────────

test("超时：既不回复也不报进度，到点取消，服务器收到 notifications/cancelled", async () => {
	const m = manager({ callTimeoutMs: 300 });
	await m.connectAll([stress("srv", { STRESS_ONLY: '["sleep"]' })]);
	const result = await tool(m, "sleep").execute({ ms: 3000 }, ctx());
	assert.equal(result.isError, true);
	assert.match(textOf(result), /timed out: "srv" sent neither a result nor progress for 300ms, so the call was cancelled/);
	await until(() => existsSync(join(dir, "cancelled-sleep")));
});

test("进度：报着进度的长任务不会被超时掐掉，进度推到界面上", async () => {
	const m = manager({ callTimeoutMs: 300 });
	await m.connectAll([stress("srv", { STRESS_ONLY: '["long"]' })]);
	const updates: string[] = [];
	const result = await tool(m, "long").execute({ steps: 6, interval: 150 }, ctx({ onProgress: (partial) => updates.push(textOf(partial)) }));
	assert.equal(result.isError, false, textOf(result));
	assert.equal(textOf(result), "done after 6 steps");
	assert.ok(updates.length >= 2, `进度只到了 ${updates.length} 次`);
	assert.match(updates.at(-1)!, /^\d\/6 · step \d$/);
});

test("取消：人按了停止，服务器那一头收到 notifications/cancelled", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["sleep"]' })]);
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 150);
	const result = await tool(m, "sleep").execute({ ms: 5000 }, ctx({ signal: stop.signal }));
	assert.equal(result.isError, true);
	await until(() => existsSync(join(dir, "cancelled-sleep")));
});

// ── 结果 ───────────────────────────────────────────────────────────────────

test("超大文本：压在首发剪枝线以内、留头尾，模型看到的不会再被剪成 5k；全文落在 scratch 里能读回", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["big_text"]' })]);
	const scratchDir = join(dir, "scratch");
	const result = await tool(m, "big_text").execute({ chars: 500_000 }, ctx({ scratchDir }));
	const text = textOf(result);
	assert.ok([...text].length <= MCP_RESULT_CHARS, `${text.length}`);
	assert.ok(text.startsWith("HEAD-MARK"));
	assert.ok(text.endsWith("TAIL-MARK"), "结尾（总数、错误常在这里）没有丢");
	assert.match(text, /characters omitted by Plume \(limit /);

	// 上限高过首发剪枝线时，满额结果会在模型看到前被剪成前 4k、后 1k。
	const message = { role: "toolResult", toolCallId: "c1", toolName: "mcp__srv__big_text", content: result.content, isError: false, timestamp: 0 } as Message;
	assert.equal(pruneToolResults([message], FRESH_RESULT_MAX_CHARS)[0], message);

	const path = /full result is saved at (\S+) /.exec(text)?.[1];
	assert.ok(path?.startsWith(scratchDir), text.slice(-400));
	const full = await readFile(path!, "utf8");
	assert.ok(full.startsWith("HEAD-MARK") && full.endsWith("TAIL-MARK") && full.length > 500_000);

	// 没有 scratch 目录（设置页探测、命令行之外的临时连接）时不给路径，只请它少要一点。
	const bare = textOf(await tool(m, "big_text").execute({ chars: 500_000 }, ctx()));
	assert.ok([...bare].length <= MCP_RESULT_CHARS);
	assert.match(bare, /ask the tool for less/);
});

test("大图片：超过 200 KiB 的不塞进请求，落盘给路径、界面照样能画；小图原样给", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["big_image","small_image"]' })]);
	const scratchDir = join(dir, "scratch");
	const big = await tool(m, "big_image").execute({ bytes: 600 * 1024 }, ctx({ scratchDir }));
	assert.equal(big.content.some((part) => part.type === "image"), false);
	const path = /saved at (\S+) /.exec(textOf(big))?.[1];
	assert.ok(path?.startsWith(scratchDir), textOf(big));
	assert.equal((await readFile(path!)).length, 600 * 1024);
	const parked = (big.details as { images?: { media?: string }[] }).images;
	assert.equal(parked?.length, 1);
	assert.ok(existsSync(join(process.env.PLUME_HOME!, "session-media", parked![0]!.media!)));

	const small = await tool(m, "small_image").execute({}, ctx({ scratchDir }));
	assert.equal(small.content.filter((part) => part.type === "image").length, 1);
});

test("structuredContent：文本里已经是同一份就不重复；只有结构没有文本时附给模型", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["structured"]' })]);
	const both = await tool(m, "structured").execute({}, ctx());
	assert.deepEqual(both.content, [{ type: "text", text: '{"count":2,"items":["a","b"]}' }]);
	const only = await tool(m, "structured").execute({ plain: 1 }, ctx());
	assert.equal(textOf(only), 'structuredContent: {"count":2,"items":["a","b"]}');
	assert.equal(only.isError, false);
});

test("resource_link、嵌入资源、二进制、音频：每一种都有去处，链接告诉模型怎么读", async () => {
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["links"]' })]);
	const result = await tool(m, "links").execute({}, ctx());
	const text = textOf(result);
	assert.match(text, /\[resource link\] Note one \(text\/plain\) — The first note: stress:\/\/notes\/1\. Read it with `read mcp:\/\/srv\/stress:\/\/notes\/1`/);
	assert.match(text, /\[resource stress:\/\/inline\.txt \(text\/plain\)\]\nembedded text body/);
	assert.match(text, /stress:\/\/blob\.bin \(application\/octet-stream, 3 KiB\) is binary/);
	assert.match(text, /\[audio \(audio\/wav, 1 KiB\) omitted/);
	// 链接里给的地址确实读得回来。
	assert.equal(await m.readResource("srv", "stress://notes/1"), "contents of stress://notes/1");
});

// ── annotations 与审批 ──────────────────────────────────────────────────────

test("annotations：destructive 让审批更严；readOnly 单凭自己不免审批，人信任这台服务器之后才免", async () => {
	const asked: ApprovalRequest[] = [];
	const approve = async (request: ApprovalRequest) => {
		asked.push(request);
		return "once" as const;
	};
	const m = manager();
	await m.connectAll([stress("srv", { STRESS_ONLY: '["wipe","peek","liar"]' })]);
	for (const name of ["wipe", "peek", "liar"]) await tool(m, name).execute({}, ctx({ requestApproval: approve }));
	const [wipe, peek, liar] = asked;
	const judge = (request: ApprovalRequest) => builtInApprovalPolicy.assess("mcp", request.subject, dir, request);
	assert.deepEqual(judge(wipe!), { risky: true, code: "mcp-destructive" });
	assert.deepEqual(judge(peek!), { risky: true }, "没被信任的只读声明不免审批");
	assert.deepEqual(judge(liar!), { risky: true, code: "mcp-destructive" }, "又说只读又说破坏的，按破坏算");
	assert.equal(tool(m, "peek").executionMode, "parallel");
	assert.equal(tool(m, "liar").executionMode, "sequential");

	// 人在设置里打开「信任只读声明」：换上新声明不重启进程。
	const [pid] = await pids();
	await m.connectAll([{ ...stress("srv", { STRESS_ONLY: '["wipe","peek","liar"]' }), trustReadOnly: true }]);
	assert.deepEqual(await pids(), [pid]);
	asked.length = 0;
	for (const name of ["wipe", "peek"]) await tool(m, name).execute({}, ctx({ requestApproval: approve }));
	assert.deepEqual(judge(asked[1]!), { risky: false }, "信任之后，只读的免审批");
	assert.deepEqual(judge(asked[0]!), { risky: true, code: "mcp-destructive" }, "信任也不免破坏性的");
});

test("annotations 经过审批闸门：auto 模式下只有被信任的只读工具不弹卡片，ask 模式一律弹", async () => {
	const cards: string[] = [];
	let mode: "auto" | "ask" = "auto";
	const gate = new ApprovalGate({
		mode: () => mode,
		cwd: () => dir,
		ask: async (pending) => {
			cards.push(pending.request.title);
			gate.resolve(pending.id, "once");
		},
		remember: () => {},
	});
	const m = manager();
	await m.connectAll([stress("trusted", { STRESS_ONLY: '["peek"]' }), stress("plain", { STRESS_ONLY: '["peek"]' })].map((server) => (server.id === "trusted" ? { ...server, trustReadOnly: true } : server)));
	const request = (approval: ApprovalRequest) => gate.request(approval);
	for (const one of m.allTools()) await one.execute({}, ctx({ requestApproval: request }));
	assert.deepEqual(cards, ["plain → peek"]);
	mode = "ask";
	cards.length = 0;
	for (const one of m.allTools()) await one.execute({}, ctx({ requestApproval: request }));
	assert.deepEqual(cards.sort(), ["plain → peek", "trusted → peek"]);
});
