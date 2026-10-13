/**
 * MCP 工具的延迟加载（`tools/mcp-search.ts`）：哪些留在工具表外、目录和搜索找不找得到、`mcp_call` 的
 * 校验与纠正，以及审批、钩子、技能限制、并行判定、结果预算看到的是不是真正的那个工具。内置工具任何时候
 * 都在工具表里。
 *
 * 最后一组是这件事存在的理由：三条协议的真实请求编码下，服务器增减、工具被搜到和调用前后、下一轮，
 * 请求前缀一个字节不变——用 `prefix-fingerprint` 断言。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { lineageFrom } from "../src/agent/lineage.ts";
import { runAgent } from "../src/agent/loop.ts";
import { runTools } from "../src/agent/tool-run.ts";
import { streamAssistant } from "../src/ai/index.ts";
import { comparePrefix, payloadSegments } from "../src/ai/prefix-fingerprint.ts";
import { buildPromptContext } from "../src/prompt/system.ts";
import { currentSections, diffSections, promptSections, promptUpdateMessage } from "../src/prompt/update.ts";
import { PLAN_MODE_KEY, planModeTools } from "../src/runtime/plan-mode.ts";
import { SessionCapabilities } from "../src/runtime/session-capabilities.ts";
import { ACTIVE_SKILL_KEY } from "../src/skills/tool.ts";
import { builtinToolGroups } from "../src/tools/groups.ts";
import { imageTool } from "../src/tools/image.ts";
import { learnTool } from "../src/tools/learn.ts";
import { previewTool } from "../src/tools/preview.ts";
import { readTool } from "../src/tools/read.ts";
import { DEFER_MCP_TOKENS, planTools, routeMcpCall, MCP_CALL, MCP_SEARCH, mcpSearchTool, toolTable, withhold } from "../src/tools/mcp-search.ts";
import { schemaProblem } from "../src/tools/tool-schema-check.ts";
import { toolTokens } from "../src/tokens.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { emptyUsage, type ApiFormat, type ApprovalRequest, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool, type ToolResultMessage } from "../src/types.ts";
import { runConfig } from "./run-config.ts";
import { FIXTURE_SERVERS, fixtureTools } from "./mcp-catalog-fixture.ts";

const byServer = (tools: Tool[], id: string) => tools.filter((tool) => tool.mcp?.server().id === id);
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");
const names = (tools: readonly Tool[]) => tools.map((tool) => tool.name);
const plan = (tools: Tool[], options: { pinned?: string[]; sticky?: boolean } = {}) =>
	planTools({ tools, pinnedServers: new Set(options.pinned), mcpDeferred: options.sticky ?? false });

/** 一件手搓的 MCP 工具：服务器名、原名、参数、执行。 */
function mcpTool(server: string, tool: string, parameters: Tool["parameters"], execute: Tool["execute"]): Tool {
	return { name: `mcp__${server}__${tool}`, mcp: { tool, server: () => ({ id: server, name: server }) }, description: tool, parameters, execute };
}

// ---------------------------------------------------------------------------
// 哪些留在工具表外
// ---------------------------------------------------------------------------

test("MCP 工具少于阈值时全部常驻；超过就延迟，常驻的服务器留在工具表里", () => {
	const all = fixtureTools();
	const small = byServer(all, "slack");
	assert.ok(toolTokens(small) < DEFER_MCP_TOKENS, "一台普通服务器在阈值以下");
	assert.deepEqual(names(toolTable(plan(small).tools)), names(small));

	assert.deepEqual(names(toolTable(plan(all).tools)), [MCP_SEARCH, MCP_CALL]);
	const pinned = toolTable(plan(all, { pinned: ["github"] }).tools);
	assert.deepEqual(names(pinned), [...names(byServer(all, "github")), MCP_SEARCH, MCP_CALL]);
	assert.deepEqual(names(toolTable(plan(all, { pinned: FIXTURE_SERVERS.map((s) => s.id) }).tools)), names(all), "全部常驻就不切");
});

test("切到延迟以后，掉回阈值以下也不切回去（sticky）", () => {
	const small = byServer(fixtureTools(), "slack");
	const once = plan(small, { sticky: true });
	assert.equal(once.mcpDeferred, true);
	assert.ok(once.tools.every((tool) => tool.deferred));
});

test("内置工具任何时候都在工具表里：MCP 延迟时也一样；延迟的是副本，原定义不被改", () => {
	const builtins = builtinToolGroups().flat();
	const table = names(toolTable(plan([...builtins, ...fixtureTools()]).tools));
	assert.deepEqual(table, [...names(builtins), MCP_SEARCH, MCP_CALL]);
	assert.deepEqual(names(toolTable(plan(builtins).tools)), names(builtins), "没有 MCP 就没有入口");
	const linear = fixtureTools().find((tool) => tool.name === "mcp__linear__create_issue")!;
	assert.equal(withhold(linear).deferred, true);
	assert.equal(linear.deferred, undefined, "同一份定义所有会话共用");
});

test("会话：重组多少次，工具表都是同一份；两个入口是同一个对象", () => {
	const can = new SessionCapabilities();
	(can as unknown as { baseTools: Tool[] }).baseTools = [readTool, previewTool] as Tool[];
	can.mcp.allTools = () => fixtureTools();
	const compose = () => (can as unknown as { composeTools(): void }).composeTools();
	compose();
	const first = toolTable(can.tools);
	assert.deepEqual(names(first), ["read", "preview", MCP_SEARCH, MCP_CALL]);
	compose();
	const second = toolTable(can.tools);
	assert.deepEqual(names(second), names(first));
	assert.equal(second.at(-1), first.at(-1));
	assert.equal(second.at(-2), first.at(-2));
});

// ---------------------------------------------------------------------------
// 目录
// ---------------------------------------------------------------------------

const promptFor = (tools: Tool[]) => buildPromptContext({ cwd: "/w", tools, skills: [], projectInstructions: [], platform: "darwin", isGitRepo: false, scratchDir: "/s" });

test("目录：MCP 一台一行，没有内置工具；preview 照常直接点名", async () => {
	const tools = plan([readTool, previewTool, imageTool, learnTool, ...fixtureTools()] as Tool[]).tools;
	const prompt = await promptFor(tools);
	const sources = prompt.sections.map((section) => section.source).filter((source) => source.startsWith("deferred"));
	assert.deepEqual(sources, ["deferred", ...[...FIXTURE_SERVERS].map((server) => `deferred:mcp:${server.id}`).sort()]);
	assert.match(prompt.systemPrompt, /## MCP tools to search for[\s\S]*`mcp_search`[\s\S]*`mcp_call`/);
	assert.match(prompt.systemPrompt, /- MCP server Linear \(`linear`, 10 tools\): Issues, projects, cycles and teams in Linear\. Tools: create_comment, create_issue/);
	assert.match(prompt.systemPrompt, /use `preview` instead of writing files/);
	assert.doesNotMatch(prompt.systemPrompt, /`preview`[^\n]*mcp_search|- `(preview|learn|image_generate)`/);

	const none = await promptFor([readTool, previewTool] as Tool[]);
	assert.doesNotMatch(none.systemPrompt, /tools to search for/i, "没有被延迟的就没有目录");
});

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

const searchIn = (tools: Tool[]) => async (args: Record<string, unknown>) => {
	const result = await mcpSearchTool.execute(args, { cwd: "/w", sessionId: "s", state: new Map(), tools });
	return { result, top: ((result.details as { matches: string[] } | undefined)?.matches ?? []) };
};

test("搜 MCP：按工具名、服务器、描述匹配，带回完整 schema", async () => {
	const search = searchIn([readTool, previewTool, ...fixtureTools().map(withhold)] as Tool[]);
	assert.equal((await search({ query: "linear create issue" })).top[0], "mcp__linear__create_issue");
	assert.equal((await search({ query: "create an issue", source: "Linear" })).top[0], "mcp__linear__create_issue", "按服务器名限定");
	assert.equal((await search({ query: "stacktraces production error" })).top[0], "mcp__sentry__get_issue_details", "只在描述里出现的词");
	assert.equal((await search({ query: "mcp__slack__slack_post_message" })).top[0], "mcp__slack__slack_post_message", "完整名字");
	assert.ok((await search({ query: "merge pull requests" })).top.includes("mcp__github__merge_pull_request"), "复数");
	const one = await search({ query: "linear create issue", limit: 1 });
	assert.match(text(one.result), /mcp__linear__create_issue — MCP Linear: create_issue\n[\s\S]*Input schema: \{"type":"object","properties":\{"title"/);
	assert.match(text(one.result), /more matched/);
	assert.match(text((await search({ query: "zzzz" })).result), /No tool matched[\s\S]*Entries: [\s\S]*airtable/);
	assert.equal((await search({ query: "x", source: "nope" })).result.isError, true);
	assert.ok(!(await search({ query: "preview" })).top.includes("preview"), "工具表上的内置工具不在搜索范围里");
});

// ---------------------------------------------------------------------------
// 调用：校验、纠正，以及不绕开审批、钩子、技能限制
// ---------------------------------------------------------------------------

function harness(options: { approve?: "once" | "deny"; extra?: Tool[]; state?: Map<string, unknown>; planMode?: boolean } = {}) {
	const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
	const planned = plan([readTool as Tool, ...(options.extra ?? []), ...fixtureTools(calls)]).tools;
	const state = options.state ?? new Map<string, unknown>();
	// 和 `session-turn.ts` 一样，计划模式包的是整张列表，被延迟的那些也在里面。
	if (options.planMode) state.set(PLAN_MODE_KEY, true);
	const available = options.planMode ? planModeTools(planned, state) : planned;
	const approvals: ApprovalRequest[] = [];
	const hooks: string[] = [];
	const asked: string[] = [];
	const events: AgentEvent[] = [];
	// 照适配器的样子带上原文：经 `mcp_call` 的无参调用曾因外层原文被当成没解析的 JSON 拦下。
	const run = (name: string, args: Record<string, unknown>, argumentsText = JSON.stringify(args)) =>
		runTools(
			[{ type: "toolCall", id: `c${events.length}`, name, arguments: args, argumentsText }],
			{
				available,
				env: { cwd: "/w" },
				requestApproval: async (request) => {
					approvals.push(request);
					return options.approve === "deny" ? "reject" : "once";
				},
				beforeToolCall: async (call) => {
					hooks.push(call.toolName);
					return undefined;
				},
				permissionRequest: async (call) => {
					asked.push(call.toolName);
					return undefined;
				},
			} as never,
			{ sessionId: "s", signal: undefined, state },
			async (event) => {
				events.push(event);
			},
		).then((results) => results[0]!);
	return { calls, approvals, hooks, asked, events, run, available };
}

const goodIssue = { title: "Login fails on Safari", team: "ENG", priority: 2 };

test("mcp_call 换成真正的 MCP 工具：钩子、审批、事件、执行都对着它，参数原样到服务器", async () => {
	const h = harness();
	const result = await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: goodIssue });
	assert.equal(result.isError, false, text(result));
	assert.equal(result.toolName, "mcp__linear__create_issue");
	assert.deepEqual(h.calls, [{ server: "linear", tool: "create_issue", args: goodIssue }]);
	assert.deepEqual(h.hooks, ["mcp__linear__create_issue"], "PreToolUse 看到的是真名");
	assert.deepEqual(h.asked, ["mcp__linear__create_issue"], "替人答审批的钩子看到的也是真名");
	assert.equal(h.approvals[0]?.kind, "mcp");
	assert.equal(h.approvals[0]?.subject, "mcp__linear__create_issue", "「总是允许」记在真名上");
	const start = h.events.find((event) => event.type === "tool_start");
	assert.equal(start?.type === "tool_start" && start.toolName, "mcp__linear__create_issue");
});

test("MCP 注解照样生效：destructive 的进审批时带着标记；人拒绝就不执行", async () => {
	const h = harness({ approve: "deny" });
	const result = await h.run(MCP_CALL, { tool: "mcp__github__merge_pull_request", arguments: { owner: "o", repo: "r", pullNumber: 1 } });
	assert.equal(h.approvals[0]?.destructive, true);
	assert.equal(result.isError, true);
	assert.deepEqual(h.calls, []);
});

test("技能的 allowed-tools 按真名管：mcp_search 能用，经 mcp_call 叫名单外的工具照样被拒", async () => {
	const state = new Map<string, unknown>([[ACTIVE_SKILL_KEY, { name: "only-read", allowedTools: ["read"] }]]);
	const h = harness({ state });
	const refused = await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: goodIssue });
	assert.match(text(refused), /only-read[\s\S]*`mcp__linear__create_issue`/);
	assert.deepEqual(h.calls, []);
	const found = await h.run(MCP_SEARCH, { query: "linear create issue" });
	assert.equal(found.isError, false, text(found));
});

test("计划模式：经 mcp_call 或直接点名叫被延迟的 MCP 工具，会改东西的照样被拒、只读的放行；发出去的工具表不变", async () => {
	const h = harness({ planMode: true });
	const viaCall = await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: goodIssue });
	assert.equal(viaCall.toolName, "mcp__linear__create_issue");
	assert.match(text(viaCall), /Plan mode: it can change things, so "mcp__linear__create_issue" did not run/);
	const direct = await h.run("mcp__linear__create_issue", goodIssue);
	assert.match(text(direct), /Plan mode: it can change things/);
	assert.deepEqual(h.calls, [], "两条路都没到服务器");
	assert.deepEqual(h.approvals, [], "被拒的调用不会先弹审批");

	const read = await h.run(MCP_CALL, { tool: "mcp__linear__get_issue", arguments: { id: "ENG-1" } });
	assert.equal(read.isError, false, text(read));
	assert.deepEqual(h.calls, [{ server: "linear", tool: "get_issue", args: { id: "ENG-1" } }]);

	const sent = (tools: readonly Tool[]) => JSON.stringify(toolTable(tools).map(({ name, description, parameters }) => ({ name, description, parameters })));
	assert.equal(sent(h.available), sent(harness().available));
});

test("经 mcp_call 的 MCP 工具照它自己的执行模式：会改东西的一次一个，只读的能并行", async () => {
	const order: string[] = [];
	const slow = (name: string): Tool => ({
		...mcpTool("ops", name, { type: "object", properties: {} }, async () => {
			order.push(`start ${name}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(`end ${name}`);
			return { content: [{ type: "text", text: "ok" }] };
		}),
		executionMode: "sequential",
	});
	const available = [slow("one"), slow("two")].map(withhold);
	await runTools(
		[{ type: "toolCall", id: "a", name: MCP_CALL, arguments: { tool: "mcp__ops__one" } }, { type: "toolCall", id: "b", name: MCP_CALL, arguments: { tool: "mcp__ops__two" } }],
		{ available, env: { cwd: "/w" } } as never,
		{ sessionId: "s", signal: undefined, state: new Map() },
		async () => {},
	);
	assert.deepEqual(order, ["start one", "end one", "start two", "end two"]);
	const routed = routeMcpCall({ name: MCP_CALL, args: { tool: "mcp__linear__get_issue", arguments: { id: "ENG-1" } } }, plan(fixtureTools()).tools);
	assert.ok(routed && "tool" in routed);
	assert.equal(routed.tool.executionMode, "parallel", "只读的 MCP 工具照样能并行");
});

test("参数不合 schema：不执行、不问人、不过钩子，退回原因和完整 schema", async () => {
	const h = harness();
	const missing = await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: { title: "x" } });
	assert.match(text(missing), /must have required property 'team'[\s\S]*Input schema: \{"type":"object"/);
	assert.match(text(await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: { ...goodIssue, teamId: "ENG" } })), /not parameters of this tool: teamId/);
	assert.match(text(await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: { ...goodIssue, labels: 3 } })), /labels must be array/);
	assert.match(text(await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: "nope" })), /must be an object/);
	assert.match(text(await h.run(MCP_CALL, { tool: "mcp__linear__create_issue", arguments: { ...goodIssue, link: "https://x" } })), /mcp__linear__create_issue was not called[\s\S]*not parameters of this tool: link/);
	assert.match(text(await h.run("mcp__linear__create_issue", { title: "x" })), /must have required property 'team'/, "直接按名字叫也校验");
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.approvals, []);
	assert.deepEqual(h.hooks, []);
});

test("可以无歧义修好的照修：字符串数字、JSON 字符串形式的 arguments、服务器/工具的写法", async () => {
	const h = harness();
	const result = await h.run(MCP_CALL, { tool: "linear/create_issue", arguments: JSON.stringify({ ...goodIssue, priority: "2" }) });
	assert.equal(result.isError, false, text(result));
	assert.deepEqual(h.calls[0]?.args, goodIssue);
});

test("直接按名字叫一个被延迟的工具：照样校验、审批后执行", async () => {
	const h = harness();
	assert.equal((await h.run("mcp__linear__create_issue", goodIssue)).isError, false);
	assert.equal(h.approvals.length, 1);
	assert.equal(h.calls.length, 1);
});

test("无参工具经 mcp_call 照常执行；外层 JSON 没解析出来的不执行", async () => {
	let ran = 0;
	const list = mcpTool("ops", "list_jobs", { type: "object", properties: {} }, async () => {
		ran++;
		return { content: [{ type: "text", text: "job-1" }] };
	});
	const h = harness({ extra: [list] });
	const ok = await h.run(MCP_CALL, { tool: "mcp__ops__list_jobs", arguments: {} });
	assert.equal(ok.isError, false, text(ok));
	assert.equal(ran, 1);
	const broken = await h.run(MCP_CALL, {}, '{"tool": "mcp__ops__list_jobs", "argu');
	assert.equal(broken.isError, true);
	assert.equal(ran, 1, "没跑");
});

test("叫不到的：给最接近的几个并让它先搜；这一轮工具里没有的（比如子代理没给）经 mcp_call 也叫不到", async () => {
	const h = harness();
	assert.match(text(await h.run("mcp__linear__make_ticket", {})), /No tool named "mcp__linear__make_ticket"\. Closest: mcp__linear__[\s\S]*Use mcp_search/);
	assert.match(text(await h.run(MCP_CALL, { tool: "create_issue", arguments: goodIssue })), /No tool named "create_issue"[\s\S]*mcp__(github|linear)__create_issue/, "两台都有的原名不猜");
	assert.match(text(await h.run("frobnicate", {})), /is not available in this session\. Available tools: read, mcp_search, mcp_call\./, "列出来的是工具表上的");
	const withoutLinear = plan(fixtureTools().filter((tool) => tool.mcp?.server().id !== "linear")).tools;
	const missing = routeMcpCall({ name: MCP_CALL, args: { tool: "mcp__linear__create_issue", arguments: goodIssue } }, withoutLinear);
	assert.match(missing && "error" in missing ? missing.error : "", /No tool named "mcp__linear__create_issue"/);
	assert.deepEqual(h.calls, []);
});

test("schema 编译不了的不拦，交给工具；明说接受任意参数的不拦多出来的", () => {
	assert.equal(schemaProblem({ type: "object", properties: { a: { type: "nonsense-type" } } } as never, { a: 1 }), undefined);
	assert.equal(schemaProblem({ type: "object", properties: {}, additionalProperties: true }, { anything: 1 }), undefined);
});

test("结果预算照旧：经 mcp_call 跑出的十万字，发给模型前同样剪成头尾；工具表里没有被延迟的", async () => {
	const huge = mcpTool("reports", "big_report", { type: "object", properties: {} }, async () => ({ content: [{ type: "text", text: "x".repeat(100_000) }] }));
	const sent: { tools: string[]; messages: Message[] }[] = [];
	const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({ role: "assistant", content, api: "openai-responses", provider: "p", model: "m", stopReason, timestamp: Date.now(), usage: emptyUsage() });
	await runAgent(
		runConfig({
			session: { messages: [{ role: "user", content: [{ type: "text", text: "report" }], timestamp: 1 }] },
			model: {
				streamFn: async (context) => {
					sent.push({ tools: (context.tools ?? []).map((tool) => tool.name), messages: context.messages });
					return sent.length === 1 ? reply([{ type: "toolCall", id: "t1", name: MCP_CALL, arguments: { tool: "mcp__reports__big_report" } }], "toolUse") : reply([{ type: "text", text: "done" }], "stop");
				},
			},
			tools: { available: [readTool as Tool, withhold(huge)], env: { cwd: "/w" } },
		}),
		async () => {},
	);
	assert.deepEqual(sent[0]!.tools, ["read", MCP_SEARCH, MCP_CALL]);
	const result = sent[1]!.messages.find((message): message is ToolResultMessage => message.role === "toolResult")!;
	assert.equal(result.toolName, "mcp__reports__big_report");
	assert.match(JSON.stringify(result.content), /characters omitted/);
	assert.ok(JSON.stringify(result.content).length < 60_000);
});

test("压缩从上一次请求分叉时带的工具表，就是发出去的那份：被延迟的不在，两个入口在", async () => {
	const state = new Map<string, unknown>();
	const sent: string[][] = [];
	const reply: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider: "p", model: "m", stopReason: "stop", timestamp: 2, usage: emptyUsage() };
	await runAgent(
		runConfig({
			session: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }], state },
			model: {
				streamFn: async (context) => {
					sent.push((context.tools ?? []).map((tool) => tool.name));
					return reply;
				},
			},
			tools: { available: plan([readTool as Tool, ...fixtureTools()]).tools, env: { cwd: "/w" } },
		}),
		async () => {},
	);
	const lineage = lineageFrom(state, []);
	assert.deepEqual(sent, [["read", MCP_SEARCH, MCP_CALL]]);
	assert.deepEqual((lineage?.sent.tools ?? []).map((tool) => tool.name), sent[0], "分叉请求的工具段和主请求逐项相同");
});

// ---------------------------------------------------------------------------
// 前缀：三条协议的真实请求体
// ---------------------------------------------------------------------------

const API: ApiFormat[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

async function body(api: ApiFormat, systemPrompt: string, tools: Tool[], messages: Message[]): Promise<unknown> {
	const model: ModelConfig = { id: "p/m", providerId: "p", modelId: "m", name: "M", contextWindow: 200_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
	const provider: ProviderConfig = { id: "p", name: "P", baseUrl: "http://127.0.0.1:9", api, apiKey: "x", enabled: true, models: [model] };
	let sent: unknown;
	// 和 `loop.ts` 发请求时一样，经 `toolTable` 取工具表。
	const table = toolTable(tools).map(({ name, description, parameters }) => ({ name, description, parameters }));
	const stream = streamAssistant(provider, model, { systemPrompt, messages, tools: table }, {
		retryAttempts: 1,
		cacheKey: "s",
		onPayload: (payload) => {
			sent = payload;
		},
		fetch: async () => new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400 }),
	});
	for (let next = await stream.next(); !next.done; next = await stream.next());
	return sent;
}

const user = (content: string): Message => ({ role: "user", content: [{ type: "text", text: content }], timestamp: 1 });
const reply = (id: string, name: string, args: Record<string, unknown>): AssistantMessage => ({
	role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "openai-responses", provider: "p", model: "m", stopReason: "toolUse", timestamp: 2, usage: emptyUsage(),
});
const result = (id: string, name: string, content: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: content }], isError: false, timestamp: 3 });

function session(base: Tool[], mcp: () => Tool[]) {
	const can = new SessionCapabilities();
	can.mcp.allTools = mcp;
	(can as unknown as { baseTools: Tool[] }).baseTools = base;
	const compose = () => (can as unknown as { composeTools(): void }).composeTools();
	const prompt = () => promptFor(can.tools);
	const search = (query: string) => mcpSearchTool.execute({ query }, { cwd: "/w", sessionId: "s", state: new Map(), tools: can.tools });
	return { can, compose, prompt, search };
}

test("服务器增减、MCP 工具被搜到和调用、内置工具直接调用：三条协议的请求前缀都一个字节不变", async () => {
	let mcp = fixtureTools().filter((tool) => tool.mcp?.server().id !== "linear");
	const s = session([readTool, previewTool, learnTool] as Tool[], () => mcp);

	// 第一轮：29 台，提示词在这里冻结。
	s.compose();
	const frozen = await s.prompt();
	const tools1 = [...s.can.tools];
	const history: Message[] = [user("建一个 Linear issue，再画个图")];

	// Linear 晚连上：工具表不变，目录变化作为一条增量接在历史末尾（同 `session-turn.ts` 的 `settlePrompt`）。
	mcp = fixtureTools();
	s.compose();
	const tools2 = [...s.can.tools];
	const delta = promptUpdateMessage(diffSections(currentSections(frozen, history), promptSections(await s.prompt())));
	assert.deepEqual(delta?.promptUpdate?.map((change) => change.section), ["deferred:mcp:linear"], "增量里只有新连上的那一台");
	const history2: Message[] = [...history, delta!, user("继续")];

	// MCP 搜到 → 调用，内置的直接调用：都只往后接。
	const history3: Message[] = [
		...history2,
		reply("a", MCP_SEARCH, { query: "linear create issue" }),
		result("a", MCP_SEARCH, text(await s.search("linear create issue"))),
		reply("b", MCP_CALL, { tool: "mcp__linear__create_issue", arguments: goodIssue }),
		result("b", "mcp__linear__create_issue", "ok"),
		reply("c", "preview", { html: "<p>hi</p>" }),
		result("c", "preview", "shown"),
	];

	// 再断开一台：工具表照旧。
	mcp = mcp.filter((tool) => tool.mcp?.server().id !== "notion");
	s.compose();
	const tools3 = [...s.can.tools];
	for (const tools of [tools1, tools2, tools3]) assert.deepEqual(names(toolTable(tools)), ["read", "preview", "learn", MCP_SEARCH, MCP_CALL], "内置工具一直在工具表里");

	for (const api of API) {
		const one = payloadSegments(await body(api, frozen.systemPrompt, tools1, history));
		const two = payloadSegments(await body(api, frozen.systemPrompt, tools2, history2));
		const three = payloadSegments(await body(api, frozen.systemPrompt, tools3, history3));
		assert.ok(one.length >= 3, api);
		assert.equal(comparePrefix(one, two).change, undefined, `${api}：Linear 连上前后`);
		assert.equal(comparePrefix(two, three).change, undefined, `${api}：搜索、调用、Notion 断开前后`);
	}
});

test("MCP 工具用过以后，下一轮工具表照旧：内置工具还在，三条协议的前缀一个字节不变", async () => {
	const s = session([readTool, previewTool] as Tool[], () => fixtureTools());
	s.compose();
	const frozen = await s.prompt();
	const before = [...s.can.tools];
	const history: Message[] = [
		user("建一个 Linear issue，再画个图"),
		reply("a", MCP_SEARCH, { query: "linear create issue" }),
		result("a", MCP_SEARCH, text(await s.search("linear create issue"))),
		reply("b", MCP_CALL, { tool: "mcp__linear__create_issue", arguments: goodIssue }),
		result("b", "mcp__linear__create_issue", "ok"),
		reply("c", "preview", { html: "<p>hi</p>" }),
		result("c", "preview", "shown"),
	];
	// 下一轮开始：会话照常重组一遍。
	s.compose();
	const after = [...s.can.tools];
	assert.deepEqual(names(toolTable(after)), ["read", "preview", MCP_SEARCH, MCP_CALL], "用过的 MCP 工具也不回到工具表");
	const delta = promptUpdateMessage(diffSections(currentSections(frozen, history), promptSections(await s.prompt())));
	assert.equal(delta, null, "目录也没变");

	for (const api of API) {
		const one = payloadSegments(await body(api, frozen.systemPrompt, before, history));
		const two = payloadSegments(await body(api, frozen.systemPrompt, after, [...history, user("好")]));
		assert.equal(comparePrefix(one, two).change, undefined, api);
	}
});

test("对照：同样的事全部常驻时，服务器一连上，前缀从工具表就断了", async () => {
	const before = fixtureTools().filter((tool) => tool.mcp?.server().id !== "linear");
	const after = fixtureTools();
	for (const api of API) {
		const one = payloadSegments(await body(api, "sys", before, [user("x")]));
		const two = payloadSegments(await body(api, "sys", after, [user("x")]));
		assert.equal(comparePrefix(one, two).change?.segment, "tools", api);
	}
});
