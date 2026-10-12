/**
 * MCP 工具多了以后延迟加载，模型还找不找得到、调不调得对，多花多少：「延迟」对「全部常驻」。
 *
 *   node --experimental-strip-types test/tool-eval/mcp-search-eval.ts <模型 id ...> [--runs 2] [--task <id>]
 *
 * 两边都有 core 的全部内置工具（常驻），加上 `mcp-catalog-fixture.ts` 那 30 台、247 个工具的 MCP 服务器。
 * 唯一的差别是 MCP 工具延迟（超过阈值，产品默认）还是全部常驻（每台都拨了「常驻」）。工具表、系统提示词
 * 目录、`mcp_search` / `mcp_call` 都经产品里那几个函数，循环是产品的 `runAgent`。
 *
 * 所有工具的执行都换成记录器：只记下被叫了什么、回一句 ok，不碰文件和网络。
 * 每个任务只有一个正确答案：某个工具，带上任务里说出的几个参数值。
 *
 * 模型用 Plume 设置里已经配好的，不读出任何密钥。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../packages/core/src/agent/loop.ts";
import { loadSettings, resolveModel } from "../../packages/core/src/config/settings.ts";
import { buildSystemPrompt } from "../../packages/core/src/prompt/system.ts";
import { builtinToolGroups } from "../../packages/core/src/tools/groups.ts";
import { planTools } from "../../packages/core/src/tools/mcp-search.ts";
import type { AssistantMessage, Message, Tool, ToolResult } from "../../packages/core/src/types.ts";
import { requestUsage } from "../../packages/core/src/types.ts";
import { runConfig } from "../../packages/core/test/run-config.ts";
import { FIXTURE_SERVERS, fixtureTools } from "../../packages/core/test/mcp-catalog-fixture.ts";

const say = (line = "") => process.stderr.write(`${line}\n`);

interface Call {
	name: string;
	args: Record<string, unknown>;
}

interface Task {
	id: string;
	prompt: string;
	tool: string;
	/** 参数对不对：任务里说出的几个值都在。 */
	check: (args: Record<string, unknown>) => boolean;
}

const same = (a: unknown, b: unknown) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : JSON.stringify(a) === JSON.stringify(b));
const fields = (expected: Record<string, unknown>) => (args: Record<string, unknown>) => Object.entries(expected).every(([key, value]) => same(args[key], value));

const TASKS: Task[] = [
	{ id: "linear-issue", prompt: "In Linear, create an issue titled \"Login fails on Safari\" for the ENG team with High priority.", tool: "mcp__linear__create_issue", check: fields({ title: "Login fails on Safari", team: "ENG", priority: 2 }) },
	{ id: "slack-post", prompt: "Post \"Deploy finished\" to the Slack channel with ID C024BE91L.", tool: "mcp__slack__slack_post_message", check: fields({ channel_id: "C024BE91L", text: "Deploy finished" }) },
	{ id: "sentry-issue", prompt: "Show me the details of Sentry issue PROJECT-1Z43 in the acme organization.", tool: "mcp__sentry__get_issue_details", check: fields({ organizationSlug: "acme", issueId: "PROJECT-1Z43" }) },
	{ id: "github-pr", prompt: "Open a draft pull request on GitHub in acme/web from branch fix-login into main, titled \"Fix login\".", tool: "mcp__github__create_pull_request", check: fields({ owner: "acme", repo: "web", head: "fix-login", base: "main", title: "Fix login", draft: true }) },
	{ id: "cloudflare-dns", prompt: "Add a Cloudflare DNS A record for api.example.com pointing to 203.0.113.7 in zone 023e105f4ecef8ad9ca31a8372d0c353.", tool: "mcp__cloudflare__create_dns_record", check: fields({ zone_id: "023e105f4ecef8ad9ca31a8372d0c353", type: "A", name: "api.example.com", content: "203.0.113.7" }) },
	{ id: "stripe-refund", prompt: "Refund Stripe payment intent pi_3MtwBwLkdIwHu7ix28a3tqPa in full; the customer asked for it.", tool: "mcp__stripe__create_refund", check: fields({ payment_intent: "pi_3MtwBwLkdIwHu7ix28a3tqPa", reason: "requested_by_customer" }) },
	{ id: "calendar-event", prompt: "Put a meeting called \"Design review\" on my primary Google Calendar from 2026-10-14T15:00:00Z to 2026-10-14T16:00:00Z.", tool: "mcp__google-calendar__create_event", check: fields({ calendar_id: "primary", summary: "Design review", start: "2026-10-14T15:00:00Z", end: "2026-10-14T16:00:00Z" }) },
	{ id: "k8s-logs", prompt: "Get the logs of pod api-7d9f in the prod namespace on Kubernetes.", tool: "mcp__kubernetes__get_pod_log", check: fields({ namespace: "prod", pod: "api-7d9f" }) },
];

const SYSTEM_SUFFIX = "\n\nThis is an evaluation: the tools and services are real from your point of view. Do the task with the tools you have, then stop. Do not ask the user questions.";

/** 像样的回话：模型据此往下走，而不是对着一句 ok 犯嘀咕。 */
function answer(name: string): string {
	if (name === "read") return "Error: file not found.";
	if (name === "ls" || name === "glob") return "(empty)";
	if (name === "bash") return "";
	return name.startsWith("mcp__") ? `ok: ${name}` : "ok";
}

/** 产品里那一份工具，执行换成记录器。 */
function evalTools(calls: Call[]): Tool[] {
	const record = (tool: Tool): Tool => ({
		...tool,
		async execute(args): Promise<ToolResult> {
			calls.push({ name: tool.name, args });
			return { content: [{ type: "text", text: answer(tool.name) }] };
		},
	});
	return [...builtinToolGroups().flat(), ...fixtureTools()].map(record);
}

async function runOnce(task: Task, mode: "deferred" | "inline", modelId: string) {
	const settings = await loadSettings();
	const resolved = resolveModel(settings, modelId);
	if (!resolved) throw new Error(`Model not found: ${modelId}`);
	const cwd = await mkdtemp(join(tmpdir(), "plume-mcp-search-eval-"));
	const calls: Call[] = [];
	// 唯一的差别：MCP 照阈值延迟，还是每台都常驻。
	const pinned = new Set(mode === "inline" ? FIXTURE_SERVERS.map((server) => server.id) : []);
	const tools = planTools({ tools: evalTools(calls), pinnedServers: pinned, mcpDeferred: false }).tools;
	const systemPrompt = (await buildSystemPrompt({ cwd, tools, skills: [], projectInstructions: [], platform: "darwin", modelName: resolved.model.name, isGitRepo: false, scratchDir: join(cwd, ".scratch") })) + SYSTEM_SUFFIX;
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: task.prompt }], timestamp: Date.now() }];
	const result = await runAgent(
		runConfig({
			session: { sessionId: `mcp-search-eval-${task.id}-${mode}`, systemPrompt, messages },
			// 照产品发：用设置里的思考档位，不强加 temperature（有的模型直接拒收）。
			model: { provider: resolved.provider, model: resolved.model, thinking: settings.thinking },
			tools: { available: tools, env: { cwd }, requestApproval: async () => "once" },
			control: { maxTurns: 8 },
		}),
		async () => {},
	);
	const replies = result.messages.filter((m): m is AssistantMessage => m.role === "assistant");
	const input = replies.reduce((sum, m) => {
		const u = requestUsage(m);
		return sum + u.input + u.cacheRead + u.cacheWrite;
	}, 0);
	const refused = result.messages.filter((m) => m.role === "toolResult" && m.isError).length;
	const hit = calls.find((call) => call.name === task.tool && task.check(call.args));
	const wrongTool = calls.filter((call) => call.name !== task.tool && call.name !== "mcp_search").length;
	const failed = replies.find((m) => m.stopReason === "error");
	return { pass: Boolean(hit), toolOk: calls.some((call) => call.name === task.tool), refused, wrongTool, requests: replies.length, input, error: failed?.errorMessage, got: calls.find((call) => call.name === task.tool)?.args };
}

type Total = { pass: number; n: number; input: number; requests: number; refused: number };

async function main(): Promise<void> {
	const flag = (name: string) => {
		const at = process.argv.indexOf(name);
		return at >= 0 ? process.argv[at + 1] : undefined;
	};
	const runs = Number(flag("--runs") ?? 2);
	const one = flag("--task");
	const models = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith("--") && !["--runs", "--task"].includes(all[i - 1]!));
	if (models.length === 0) throw new Error("给一个或几个模型 id（设置里的 `<provider>/<model>`）");
	const tasks = TASKS.filter((task) => !one || task.id === one);
	for (const modelId of models) {
		say(`\nMCP 延迟 vs 全部常驻 · ${modelId} · 每个任务 ${runs} 次\n`);
		say(`${"任务".padEnd(16)} ${"方式".padEnd(9)} 结果  工具对 拦下 错工具 请求 输入 token`);
		const totals: Record<string, Total> = {};
		const add = (key: string, r: Awaited<ReturnType<typeof runOnce>>) => {
			const t = (totals[key] ??= { pass: 0, n: 0, input: 0, requests: 0, refused: 0 });
			t.n++;
			t.pass += r.pass ? 1 : 0;
			t.input += r.input;
			t.requests += r.requests;
			t.refused += r.refused;
		};
		for (const task of tasks) {
			for (const mode of ["deferred", "inline"] as const) {
				for (let i = 0; i < runs; i++) {
					const r = await runOnce(task, mode, modelId).catch((error: unknown) => ({ pass: false, toolOk: false, refused: 0, wrongTool: 0, requests: 0, input: 0, error: String(error), got: undefined }));
					add(mode, r);
					say(`${task.id.padEnd(16)} ${mode.padEnd(9)} ${r.pass ? "通过" : "失败"}  ${r.toolOk ? "是" : "否"}     ${String(r.refused).padEnd(4)} ${String(r.wrongTool).padEnd(6)} ${String(r.requests).padEnd(4)} ${r.input}${r.error ? `  ${r.error.slice(0, 80)}` : ""}${!r.pass && r.got ? `  得到 ${JSON.stringify(r.got).slice(0, 120)}` : ""}`);
				}
			}
		}
		for (const [key, t] of Object.entries(totals)) {
			say(`${key.padEnd(17)} 通过 ${t.pass}/${t.n} · 平均请求 ${(t.requests / t.n).toFixed(2)} 次 · 平均输入 ${Math.round(t.input / t.n)} token · 被退回共 ${t.refused} 次`);
		}
	}
}

await main();
