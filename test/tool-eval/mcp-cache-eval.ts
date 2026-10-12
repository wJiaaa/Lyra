/**
 * MCP 延迟加载有没有真的保住提示缓存：拿服务商返回的 cacheRead / cacheWrite 量，不是只比请求字节。
 *
 *   node --experimental-strip-types test/tool-eval/mcp-cache-eval.ts <模型 id ...> [--mode deferred|inline]
 *
 * 一个会话连跑 5 轮：Linear（mcp_search + mcp_call）→ Slack → 新增一台 Twilio 后用它 → 移除 Notion 后
 * 查 Sentry → 不用 MCP 的收尾。对照组同一剧本，30 台全部「常驻」，增减服务器会改工具表。
 *
 * 会话怎么拼照 `runtime/session-turn.ts`：系统提示词第一轮冻结，之后的目录变化经 `prompt/update.ts`
 * 作为增量接在这一轮用户消息后面；MCP 是否延迟按 `planTools`（切过去不切回）；请求经产品的 `runAgent`，
 * 带会话的 state（前缀指纹）、日期块、剪枝器和缓存路由键。内置工具的执行换成记录器，MCP 工具走
 * `mcp-catalog-fixture.ts` 的假客户端。每次请求按 `cache-diagnostics.ts` 诊断一遍。
 *
 * 模型用 Plume 设置里已经配好的，不读出任何密钥。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionPruner } from "../../packages/core/src/agent/aged-prune.ts";
import { runAgent } from "../../packages/core/src/agent/loop.ts";
import { loadSettings, resolveModel } from "../../packages/core/src/config/settings.ts";
import { buildPromptContext } from "../../packages/core/src/prompt/system.ts";
import { currentSections, diffSections, promptSections, promptUpdateMessage } from "../../packages/core/src/prompt/update.ts";
import { diagnoseRequest, newCacheDiagnosisState } from "../../packages/core/src/runtime/cache-diagnostics.ts";
import { builtinToolGroups } from "../../packages/core/src/tools/groups.ts";
import { planTools } from "../../packages/core/src/tools/mcp-search.ts";
import type { AssistantMessage, Message, Tool, ToolResult } from "../../packages/core/src/types.ts";
import { requestUsage } from "../../packages/core/src/types.ts";
import { runConfig } from "../../packages/core/test/run-config.ts";
import { FIXTURE_SERVERS, fixtureTools, type FixtureServer } from "../../packages/core/test/mcp-catalog-fixture.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);

/** 第 3 轮之前新连上的那一台：fixture 里没有它。 */
const TWILIO: FixtureServer = {
	id: "twilio",
	name: "Twilio",
	description: "Send and read SMS messages through Twilio.",
	tools: [
		{ name: "send_sms", description: "Send an SMS message.", inputSchema: { type: "object", properties: { to: { type: "string", description: "Recipient phone number, E.164" }, from: { type: "string", description: "Sender phone number, E.164" }, body: { type: "string", description: "Message text" } }, required: ["to", "from", "body"] } },
		{ name: "list_messages", description: "List recent SMS messages.", inputSchema: { type: "object", properties: { to: { type: "string", description: "Filter by recipient" }, limit: { type: "number", description: "How many" } } }, annotations: { readOnlyHint: true } },
		{ name: "get_message", description: "Get one SMS message by SID.", inputSchema: { type: "object", properties: { sid: { type: "string", description: "Message SID" } }, required: ["sid"] }, annotations: { readOnlyHint: true } },
	],
};
const REMOVED = "notion";

interface Turn {
	label: string;
	prompt: string;
	/** 这一轮开始前连着的服务器。 */
	servers: FixtureServer[];
	/** 这一轮应当调到的 MCP 工具；没有就是「不用 MCP」那一轮。 */
	tool?: string;
}

const base = FIXTURE_SERVERS;
const added = [...base, TWILIO];
const removed = added.filter((server) => server.id !== REMOVED);

const TURNS: Turn[] = [
	{ label: "T1 Linear", servers: base, tool: "create_issue", prompt: "In Linear, create an issue titled \"Login fails on Safari\" for the ENG team with High priority." },
	{ label: "T2 Slack", servers: base, tool: "slack_post_message", prompt: "Now post \"Deploy finished\" to the Slack channel with ID C024BE91L." },
	{ label: "T3 +Twilio", servers: added, tool: "send_sms", prompt: "Text +15551234567 from +15557654321 via Twilio: \"Build is green\"." },
	{ label: "T4 -Notion", servers: removed, tool: "get_issue_details", prompt: "Show me the details of Sentry issue PROJECT-1Z43 in the acme organization." },
	{ label: "T5 无MCP", servers: removed, prompt: "Without calling any tool, tell me in one sentence which services you used in this conversation." },
];

const SYSTEM_SUFFIX = "\n\nThis is an evaluation: the tools and services are real from your point of view. Do the task with the tools you have, then stop. Do not ask the user questions.";

/** 内置工具不真执行：只回一句话，不碰文件和网络。 */
function recorded(tool: Tool): Tool {
	return { ...tool, async execute(): Promise<ToolResult> { return { content: [{ type: "text", text: "ok" }] }; } };
}

interface Row {
	turn: string;
	request: number;
	event: string;
	prompt: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	expected: number;
	cause: string;
	/** 本地前缀指纹给出的第一处不同；没有就是前缀原样延续。 */
	breakAt: string;
	calls: string;
}

async function runSession(modelId: string, mode: "deferred" | "inline"): Promise<{ rows: Row[]; mcpCalls: string[] }> {
	const settings = await loadSettings();
	const resolved = resolveModel(settings, modelId);
	if (!resolved) throw new Error(`Model not found: ${modelId}`);
	const cwd = await mkdtemp(join(tmpdir(), "plume-mcp-cache-eval-"));
	const sessionId = `mcp-cache-eval-${mode}-${Date.now().toString(36)}`;
	const state = new Map<string, unknown>();
	const builtins = builtinToolGroups().flat().map(recorded);
	const mcpCalls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
	const diagnosis = newCacheDiagnosisState();
	const rows: Row[] = [];
	let history: Message[] = [];
	let frozen: Awaited<ReturnType<typeof buildPromptContext>> | undefined;
	let mcpDeferred = false;
	let previousServers = TURNS[0]!.servers;

	for (const turn of TURNS) {
		const pinned = new Set(mode === "inline" ? turn.servers.map((server) => server.id) : []);
		const planned = planTools({ tools: [...builtins, ...fixtureTools(mcpCalls, turn.servers)], pinnedServers: pinned, mcpDeferred });
		mcpDeferred = planned.mcpDeferred;
		const fresh = await buildPromptContext({ cwd, tools: planned.tools, skills: [], projectInstructions: [], platform: "darwin", modelName: resolved.model.name, isGitRepo: false, scratchDir: join(cwd, ".scratch") });
		history = [...history, { role: "user", content: [{ type: "text", text: turn.prompt }], timestamp: Date.now() }];
		let event = turn === TURNS[0] ? "冷启动" : "";
		if (!frozen) frozen = fresh;
		else {
			// 同 `settlePrompt`：冻结的那份不动，变了的段落作为一条增量接在末尾。
			const delta = promptUpdateMessage(diffSections(currentSections(frozen, history), promptSections(fresh)));
			if (delta) {
				history = [...history, delta];
				event = `目录增量 ${delta.promptUpdate!.map((change) => `${change.section}${change.text === null ? " 移除" : ""}`).join(", ")}`;
			}
		}
		if (turn.servers !== previousServers) event = [`服务器 ${previousServers.length}→${turn.servers.length} 台`, event].filter(Boolean).join("；");
		previousServers = turn.servers;

		const result = await runAgent(
			runConfig({
				session: { sessionId, systemPrompt: frozen.systemPrompt + SYSTEM_SUFFIX, messages: history, state, environment: true, pruner: sessionPruner(state) },
				model: { provider: resolved.provider, model: resolved.model, thinking: settings.thinking, cacheKey: sessionId },
				tools: { available: planned.tools, env: { cwd }, requestApproval: async () => "once" },
				control: { maxTurns: 8 },
			}),
			async () => {},
		);
		const start = history.length;
		history = [...history, ...result.messages];
		let request = 0;
		for (let index = start; index < history.length; index++) {
			const message = history[index]!;
			if (message.role !== "assistant") continue;
			const reply = message as AssistantMessage;
			const diagnosed = diagnoseRequest(diagnosis, reply, index);
			if (!diagnosed) {
				say(`  ${turn.label} 请求失败：${reply.errorMessage ?? reply.stopReason}`);
				continue;
			}
			const usage = requestUsage(reply);
			const calls = reply.content.filter((block) => block.type === "toolCall").map((block) => (block.name === "mcp_call" ? `mcp_call(${String((block.arguments as { tool?: unknown }).tool)})` : block.name));
			rows.push({
				turn: turn.label,
				request: ++request,
				event: request === 1 ? event : "",
				prompt: diagnosed.prompt,
				input: usage.input,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				expected: diagnosed.expected,
				cause: diagnosed.cause,
				breakAt: reply.prefix?.change ? `${reply.prefix.change.segment}（${reply.prefix.change.before}→${reply.prefix.change.after} 字符）` : reply.prefix ? "无" : "—",
				calls: calls.join(" "),
			});
		}
		if (turn.tool && !mcpCalls.some((call) => call.tool === turn.tool)) say(`  ${turn.label}：没有调到 ${turn.tool}`);
	}
	return { rows, mcpCalls: mcpCalls.map((call) => `${call.server}.${call.tool}`) };
}

function print(rows: Row[]): void {
	say("| 轮次 | 次 | 事件 | 输入 | cacheRead | cacheWrite | 命中率 | 应读 | 诊断 | 本地前缀断点 | 调用 |");
	say("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const row of rows) {
		const rate = row.prompt > 0 ? `${((row.cacheRead / row.prompt) * 100).toFixed(1)}%` : "—";
		say(`| ${row.turn} | ${row.request} | ${row.event} | ${row.prompt} | ${row.cacheRead} | ${row.cacheWrite} | ${rate} | ${row.expected} | ${row.cause} | ${row.breakAt} | ${row.calls} |`);
	}
	const read = rows.reduce((sum, row) => sum + row.cacheRead, 0);
	const total = rows.reduce((sum, row) => sum + row.prompt, 0);
	say(`合计：${rows.length} 次请求，输入 ${total}，cacheRead ${read}（${total > 0 ? ((read / total) * 100).toFixed(1) : 0}%），cacheWrite ${rows.reduce((sum, row) => sum + row.cacheWrite, 0)}`);
}

async function main(): Promise<void> {
	const at = process.argv.indexOf("--mode");
	const only = at >= 0 ? process.argv[at + 1] : undefined;
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--mode");
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<provider>/<model>`）");
	const modes = (["deferred", "inline"] as const).filter((mode) => !only || mode === only);
	const out: Record<string, unknown> = {};
	for (const modelId of models) {
		for (const mode of modes) {
			say(`\n## ${modelId} · ${mode === "deferred" ? "延迟加载" : "全部常驻"}\n`);
			const result = await runSession(modelId, mode).catch((error: unknown) => {
				say(`失败：${String(error)}`);
				return undefined;
			});
			if (!result) continue;
			print(result.rows);
			say(`MCP 调用：${result.mcpCalls.join(", ") || "（无）"}`);
			out[`${modelId}#${mode}`] = result;
		}
	}
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

await main();
