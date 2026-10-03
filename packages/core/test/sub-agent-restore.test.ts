/**
 * 从会话日志里把子代理读回来：名单上那一行，和续跑要的上下文。
 *
 * 第一条是基准：同一次运行，从日志读回来之后续跑发出的第一个请求，和不重启、从内存里续跑发出的
 * 那一个逐条相同（时间戳除外）——前缀差一个字，服务商那边还在的缓存就整段作废。其余每条对应日志里
 * 一种会让供应商拒掉整段请求、或让续跑丢东西的情况。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentEvent } from "../src/agent/events.ts";
import type { AgentDefinition } from "../src/agents-builtin.ts";
import type { Settings } from "../src/config/settings.ts";
import { useCompaction } from "../src/runtime/compaction.ts";
import { runSubAgent } from "../src/runtime/sub-agent.ts";
import { restoreSubAgents, type Rebuild } from "../src/runtime/sub-agent-restore.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import { historyFrom } from "../src/runtime/session-turn.ts";
import type { SessionRecord } from "../src/session/types.ts";
import { TODOS_KEY } from "../src/tools/todo.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig, type Tool, type ToolResultMessage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };
const GENERAL: AgentDefinition = { name: "general", description: "通用", systemPrompt: "do the work", tools: "*", source: "builtin" };
const rebuild: Rebuild = () => ({ model: MODEL.id, history: (messages, boundary) => historyFrom(messages, boundary, PROVIDER, MODEL) });

const read: Tool = {
	name: "read",
	snippet: "reads",
	description: "reads",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: [], additionalProperties: false },
	summarize: (args) => `读 ${String((args as { path?: string }).path)}`,
	async execute(args) {
		return { content: [{ type: "text", text: `内容：${String((args as { path?: string }).path)}` }] };
	},
};

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: 1, content: parts };
}
const call = (id: string, name = "read", args: Record<string, unknown> = { path: `${id}.ts` }) => assistant([{ type: "toolCall", id, name, arguments: args, argumentsText: JSON.stringify(args) }]);
const result = (id: string, text = `内容：${id}.ts`): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 });
const said = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const shape = (messages: readonly Message[]) => messages.map((message) => `${message.role}:${message.role === "toolResult" ? message.toolCallId : textOf(message) || message.content.map((part) => (part.type === "toolCall" ? part.id : "")).join("")}`);

/** A log written by hand: `[event, …]` in order, numbered as the store would. */
function log(...events: AgentEvent[]): SessionRecord[] {
	return events.map((event, index) => ({ seq: index + 1, ts: 1_000 + index, type: "event", event }) as SessionRecord);
}
const dispatch = (id = "s:sub:1", extra: Partial<Extract<AgentEvent, { type: "subagent" }>> = {}): AgentEvent => ({ type: "subagent", id, agent: "general", description: "梳理", prompt: "梳理登录流程", tools: ["read"], ...extra });
const message = (message: Message, id = "s:sub:1"): AgentEvent => ({ type: "subagent_message", id, message });
const nested = (event: Extract<AgentEvent, { type: "subagent_event" }>["event"], id = "s:sub:1"): AgentEvent => ({ type: "subagent_event", id, event });
const done = (id = "s:sub:1", status: "done" | "aborted" = "done"): AgentEvent => ({ type: "subagent_done", id, steps: [], answer: "好了", status });

test("resumed after a restart, the first request is the one a resume without the restart sends", async () => {
	// Its compaction cuts `a` and keeps everything else: the cut copy is what went out from then on.
	let cutNext = false;
	useCompaction({
		compact: async ({ messages }) => {
			if (!cutNext) return null;
			cutNext = false;
			return { messages: messages.map((one) => (one.role === "toolResult" && one.toolCallId === "a" ? { ...one, content: [{ type: "text" as const, text: "[cut]" }] } : one)), summary: "" };
		},
	});
	try {
		const records: SessionRecord[] = [];
		const persisted = new Set(["subagent", "subagent_message", "subagent_event", "subagent_done", "subagent_views"]);
		const requests: Message[][] = [];
		// Every reply carries provider handles, which a resume on the same model must send back as they were.
		const handled = (id: string) => assistant([{ type: "thinking", thinking: "想", signature: `rs_${id}` }, { type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` }, argumentsText: "{}", signature: `fc_${id}` }]);
		let replies = [handled("a"), handled("b"), assistant([{ type: "text", text: "先停", signature: "msg_1" }], "stop")];
		const run = (registry: SubAgentRegistry, input: { description: string; prompt: string; resume?: string }) => {
			let turn = 0;
			return runSubAgent(
				{
					sessionId: "s",
					cwd: "/tmp",
					settings: { thinking: "off" } as unknown as Settings,
					tools: [read],
					skills: [],
					agents: [GENERAL],
					registry,
					requestApproval: async () => "once",
					emit: async (event) => {
						if (persisted.has(event.type)) records.push({ seq: records.length + 1, ts: Date.now(), type: "event", event } as SessionRecord);
					},
					streamFn: async (context) => {
						requests.push(context.messages.map(({ timestamp: _timestamp, ...rest }) => rest as Message));
						if (turn === 1) cutNext = true;
						return replies[turn++]!;
					},
				},
				input,
				PROVIDER,
				MODEL,
			);
		};
		const memory = new SubAgentRegistry();
		const first = await run(memory, { description: "梳理", prompt: "梳理登录流程" });
		const written = [...records];
		const cut = written.find((record) => record.type === "event" && record.event.type === "subagent_views");
		assert.ok(cut, "the cut is in the log");

		replies = [assistant([{ type: "text", text: "读完了" }], "stop")];
		requests.length = 0;
		await run(memory, { description: "接着", prompt: "接着读", resume: first.id });
		const withoutRestart = requests[0]!;

		const reopened = new SubAgentRegistry();
		reopened.restore(restoreSubAgents(written, rebuild));
		requests.length = 0;
		await run(reopened, { description: "接着", prompt: "接着读", resume: first.id });
		const afterRestart = requests[0]!;

		assert.ok(JSON.stringify(afterRestart).includes('"rs_a"'), "the handles are still there");
		assert.ok(JSON.stringify(afterRestart).includes("[cut]"), "and the cut result goes out cut");
		assert.deepEqual(afterRestart, withoutRestart);
	} finally {
		useCompaction(null);
	}
});

test("resumed on another model, what came before is stripped of the old provider's handles, as it was then", () => {
	const seen: { provider?: string; model?: string }[] = [];
	const [restored] = restoreSubAgents(
		log(
			dispatch(),
			message(assistant([{ type: "text", text: "先停", signature: "msg_old" }], "stop")),
			done("s:sub:1", "aborted"),
			message({ ...said("接着"), origin: "parent" }),
			dispatch("s:sub:1", { resumed: true, provider: "other", model: "m2" }),
			message(assistant([{ type: "text", text: "又停", signature: "msg_new" }], "stop")),
			done("s:sub:1", "aborted"),
		),
		(ran) => (seen.push(ran), rebuild(ran)),
	);
	assert.deepEqual(seen, [{ provider: "other", model: "m2" }], "rebuilt for the model it ran on last");
	const text = JSON.stringify(restored!.conversation!.view);
	assert.ok(!text.includes("msg_old") && text.includes("msg_new"));
});

test("one the process died under is stopped, and a call it was running is answered as interrupted, with what that call left", () => {
	const [restored] = restoreSubAgents(
		log(
			dispatch(),
			message(call("a")),
			nested({ type: "tool_start", toolCallId: "a", toolName: "read", args: {}, summary: "读 a.ts" }),
			message(result("a")),
			message(assistant([
				{ type: "toolCall", id: "b", name: "task", arguments: {}, argumentsText: "{}" },
				{ type: "toolCall", id: "c", name: "read", arguments: {}, argumentsText: "{}" },
			])),
			nested({ type: "tool_start", toolCallId: "b", toolName: "task", args: {}, summary: "派" }),
			nested({ type: "tool_left", toolCallId: "b", result: { content: [{ type: "text", text: '传 resume: "s:sub:2"' }], details: { subAgentId: "s:sub:2" } } }),
		),
		rebuild,
	);
	assert.equal(restored!.summary.status, "aborted");
	assert.equal(restored!.summary.resumable, undefined, "the roster decides that from the context it holds");
	const view = restored!.conversation!.view;
	const [running, never] = view.slice(-2) as ToolResultMessage[];
	assert.deepEqual([running!.toolCallId, never!.toolCallId], ["b", "c"], "every call answered, in order, right after the reply");
	assert.match(textOf(running!), /Plume exited while this call was running/);
	assert.match(textOf(running!), /resume: "s:sub:2"/, "with what it said it leaves behind");
	assert.equal((running!.details as { subAgentId?: string }).subAgentId, "s:sub:2");
	assert.match(textOf(never!), /before this call started/, "one that never started is said never to have run");
});

test("something said to it while a tool ran goes back after that tool's result, where the loop read it", () => {
	const [restored] = restoreSubAgents(log(dispatch(), message(call("a")), message(said("先看 b.ts")), message(result("a")), message(call("b")), message(result("b"))), rebuild);
	const view = restored!.conversation!.view.filter((one) => !(one.role === "user" && one.synthetic));
	assert.deepEqual(shape(view), ["user:梳理登录流程", "assistant:a", "toolResult:a", "user:先看 b.ts", "assistant:b", "toolResult:b"]);
	assert.deepEqual(shape(restored!.messages).slice(1, 4), ["assistant:a", "user:先看 b.ts", "toolResult:a"], "the pane keeps the order it was said in");
});

test("a sub-agent that compacted comes back on its summary and the tail it kept, not on the whole transcript", () => {
	const [restored] = restoreSubAgents(
		log(
			dispatch(),
			message(call("a")),
			message(result("a")),
			message(call("b")),
			message(result("b")),
			nested({ type: "compacted", before: 6, after: 4, summary: "SUMMARY-读过 a.ts", kept: 2 }),
			message(call("c")),
			message(result("c")),
		),
		rebuild,
	);
	const view = restored!.conversation!.view;
	const all = view.map(textOf).join("\n");
	assert.match(all, /SUMMARY-读过 a\.ts/);
	assert.ok(!view.some((one) => one.role === "toolResult" && one.toolCallId === "a"), "what was summarised away stays away");
	assert.deepEqual(
		view.filter((one) => one.role === "toolResult" || (one.role === "assistant" && one.content.some((part) => part.type === "toolCall"))).map((one) => shape([one])[0]),
		["assistant:b", "toolResult:b", "assistant:c", "toolResult:c"],
		"after the summary, exactly the tail it kept and what came after",
	);
	assert.equal(restored!.messages.length, 7, "the pane still has all of it");
});

test("a resume is the same row again, and its plan comes back with it", () => {
	const plan = [{ content: "读 a.ts", status: "completed" }, { content: "读 b.ts", status: "in_progress" }];
	const restored = restoreSubAgents(
		log(
			dispatch(),
			message(call("t", "todo_write", { todos: plan })),
			message({ ...result("t", "ok"), toolName: "todo_write", details: { kind: "todo", todos: plan } }),
			done("s:sub:1", "aborted"),
			message({ ...said("接着读"), origin: "parent" }),
			dispatch("s:sub:1", { resumed: true }),
			message(assistant([{ type: "text", text: "读完了" }], "stop")),
			done(),
		),
		rebuild,
	);
	assert.equal(restored.length, 1);
	assert.deepEqual({ status: restored[0]!.summary.status, resumes: restored[0]!.summary.resumes }, { status: "done", resumes: 1 });
	assert.deepEqual(restored[0]!.conversation!.state.get(TODOS_KEY), plan);
});

test("one dispatched in a stretch the conversation was rewound past is gone, like the turn that sent it", () => {
	const records = [...log(dispatch("s:sub:1"), message(call("a"), "s:sub:1"), dispatch("s:sub:2", { parentId: "s:sub:1" })), { seq: 4, ts: 2_000, type: "truncate", afterSeq: 2 } as SessionRecord];
	assert.deepEqual(restoreSubAgents(records, rebuild).map((one) => one.summary.id), ["s:sub:1"]);
});

test("a nested one is one level down, and without a model to rebuild against the rows come back without a context", () => {
	const restored = restoreSubAgents(log(dispatch("s:sub:1"), dispatch("s:sub:2", { parentId: "s:sub:1" })));
	assert.deepEqual(restored.map((one) => [one.summary.depth, one.summary.parentId ?? null, one.conversation === undefined]), [[1, null, true], [2, "s:sub:1", true]]);
});

test("the roster takes them back once, and keeps what it already has", () => {
	const registry = new SubAgentRegistry();
	const [restored] = restoreSubAgents(log(dispatch(), message(call("a")), message(result("a"))), rebuild);
	registry.restore([restored!]);
	registry.restore([{ ...restored!, summary: { ...restored!.summary, description: "第二次" } }]);
	assert.deepEqual(registry.list().map(({ id, description, resumable }) => ({ id, description, resumable })), [{ id: "s:sub:1", description: "梳理", resumable: true }]);
	assert.ok(!("refusal" in registry.lookupResumable("s:sub:1")), "and resume finds it");
});

test("one taken off the roster by hand stays off", () => {
	const restored = restoreSubAgents([...log(dispatch("s:sub:1"), dispatch("s:sub:2"), done("s:sub:1")), { seq: 4, ts: 2_000, type: "event", event: { type: "subagent_dismissed", id: "s:sub:1" } } as SessionRecord], rebuild);
	assert.deepEqual(restored.map((one) => one.summary.id), ["s:sub:2"]);
});
