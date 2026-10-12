/**
 * 子代理跑的钩子记在它自己名下。
 *
 * 照 ZCode 的做法：主对话那个钩子按钮只列主对话自己的钩子；子代理里的进它自己的面板，`at` 数的是
 * 它自己的转录，落盘、重开之后也还在。主对话看得到那次调用失败，是哪条钩子拦的去子代理那里看。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent, HookRun } from "../src/agent/events.ts";
import { loadTurnHooks, toolHooks } from "../src/runtime/run-policy.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { runSubAgent } from "../src/runtime/sub-agent/sub-agent.ts";
import { restoreSubAgents } from "../src/runtime/sub-agent/sub-agent-restore.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agent/sub-agents.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig, Settings, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

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

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}

const probe: Tool = {
	name: "probe",
	snippet: "does nothing",
	description: "does nothing",
	parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	summarize: () => "看了一眼",
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

// 钩子进程用 `node -e`，不经过 shell，Windows 上也成立。
const script = "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('子代理也不许');process.exit(2)})";
const hooks = { events: { PreToolUse: [{ matcher: "probe", hooks: [{ type: "process", command: process.execPath, args: ["-e", script] }] }] } };

const hookRunsIn = (events: readonly AgentEvent[]): HookRun[] =>
	events.flatMap((event) => (event.type === "subagent_event" && event.event.type === "hook_run" ? [event.event.run] : []));

test("子代理跑的钩子记在它自己名下：位置数它自己的转录，不进主会话的钩子，落盘只记终态、重开还在", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "plume-sub-hooks-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new SessionStore(join(root, "sessions"));
	const meta = await store.create(root, MODEL.id);
	const events: AgentEvent[] = [];
	const log = new SessionLog(store, () => {}, meta);
	const registry = new SubAgentRegistry();
	let turn = 0;

	await runSubAgent(
		{
			sessionId: meta.id,
			cwd: root,
			settings: { thinking: "off", hooks } as unknown as Settings,
			tools: [probe],
			skills: [],
			agents: [],
			registry,
			requestApproval: async () => "allow",
			emit: async (event) => {
				events.push(event);
				await log.emit(event);
			},
			streamFn: async () =>
				turn++ === 0
					? reply([{ type: "toolCall", id: "c1", name: "probe", arguments: {}, argumentsText: "{}" }], "toolUse")
					: reply([{ type: "text", text: "被拦了" }], "stop"),
		},
		{ description: "跑一下", prompt: "去", agentType: "general" },
		PROVIDER,
		MODEL,
	);

	assert.ok(!events.some((event) => event.type === "hook_run"), "主会话自己的钩子单子里没有它");

	const live = hookRunsIn(events);
	assert.deepEqual(live.map((run) => run.status), ["running", "blocked"], "开始和结局各报一次");
	// 它的转录：0 是派它出去那一句，1 是调 probe 的那条回复——钩子在那之后跑。
	assert.deepEqual(live.map((run) => run.at), [2, 2], "位置数的是它自己的转录，两次是同一个");

	const id = registry.list()[0]!.id;
	assert.ok(!("hookRuns" in registry.list()[0]!), "名单每次变动都要广播，不带这一份");
	const detail = registry.detail(id)!;
	assert.equal(detail.hookRuns?.length, 1);
	assert.equal(detail.hookRuns?.[0]?.status, "blocked");
	assert.match(detail.hookRuns?.[0]?.reason ?? "", /子代理也不许/);
	const anchored = detail.messages[detail.hookRuns![0]!.at - 1];
	assert.ok(anchored?.role === "assistant" && anchored.content.some((part) => part.type === "toolCall" && part.name === "probe"), "位置落在那次调用之后");

	const records = await store.subAgentRecords(meta.id);
	const written = records.flatMap((record) => (record.type === "event" ? hookRunsIn([record.event]) : []));
	assert.deepEqual(written.map((run) => run.status), ["blocked"], "「开始了」不落盘，只记终态");

	const restored = restoreSubAgents(records);
	assert.deepEqual(restored[0]?.hookRuns, detail.hookRuns, "重开之后读回来的和跑着时的是同一份");

	const reopened = new SubAgentRegistry();
	reopened.restore(restored);
	assert.deepEqual(reopened.detail(id)?.hookRuns, detail.hookRuns, "放回名单后面板读得到");
});

test("钩子分得出是哪一个子代理：agentId / agent_id 是它自己的 id，主对话里没有这两个字段", async (t) => {
	/*
	 * 只有 `agentName` 时，两个并行的 general 收到的输入一模一样。字段名照 Claude Code：子代理里的
	 * 工具事件带 `agent_id` 和 `agent_type`。
	 */
	const root = await mkdtemp(join(tmpdir(), "plume-sub-hook-id-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const seen = join(root, "seen.jsonl");
	const record =
		"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);" +
		"require('fs').appendFileSync(process.argv[1],JSON.stringify({agentId:i.agentId,agent_id:i.agent_id,agentName:i.agentName,agent_type:i.agent_type})+'\\n')})";
	const settings = { thinking: "off", hooks: { events: { PreToolUse: [{ matcher: "probe", hooks: [{ type: "process", command: process.execPath, args: ["-e", record, seen] }] }] } } } as unknown as Settings;
	const registry = new SubAgentRegistry();
	const turns = new Map<string, number>();
	const dispatch = (prompt: string) =>
		runSubAgent(
			{
				sessionId: "s1",
				cwd: root,
				settings,
				tools: [probe],
				skills: [],
				agents: [],
				registry,
				requestApproval: async () => "allow",
				emit: async () => {},
				streamFn: async () => {
					const turn = turns.get(prompt) ?? 0;
					turns.set(prompt, turn + 1);
					return turn === 0 ? reply([{ type: "toolCall", id: "c1", name: "probe", arguments: {}, argumentsText: "{}" }], "toolUse") : reply([{ type: "text", text: "好了" }], "stop");
				},
			},
			{ description: prompt, prompt, agentType: "general" },
			PROVIDER,
			MODEL,
		);
	await Promise.all([dispatch("一号"), dispatch("二号")]);

	const ids = registry.list().map((one) => one.id).sort();
	const lines = (await readFile(seen, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, string>);
	assert.equal(lines.length, 2);
	assert.deepEqual(lines.map((line) => line.agentId).sort(), ids, "各是各的 id");
	for (const line of lines) {
		assert.equal(line.agent_id, line.agentId, "snake_case 别名和 camelCase 是同一个值");
		assert.equal(line.agentName, "general");
		assert.equal(line.agent_type, "general");
	}

	await rm(seen);
	const main = toolHooks(await loadTurnHooks({ settings, cwd: root, sessionId: "s1", signal: undefined }));
	await main.beforeToolCall({ toolName: "probe", args: {}, toolCallId: "m1" });
	const own = JSON.parse((await readFile(seen, "utf8")).trim()) as Record<string, unknown>;
	assert.deepEqual(own, {}, `主对话不带 agent 的字段：${JSON.stringify(own)}`);
});
