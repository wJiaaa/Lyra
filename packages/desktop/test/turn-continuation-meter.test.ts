import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { AgentEvent, AssistantContent, AssistantMessage, Message, StopReason, ToolCallContent } from "@plume/core";

// Mock window and window.plume before importing store
const storage: Record<string, string> = {};
(globalThis as unknown as { window: unknown }).window = {
	addEventListener: () => {},
	removeEventListener: () => {},
	localStorage: {
		getItem: (k: string) => storage[k] ?? null,
		setItem: (k: string, v: string) => {
			storage[k] = v;
		},
		removeItem: (k: string) => {
			delete storage[k];
		},
	},
	matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	plume: {
		sessions: {
			list: async () => [],
			running: async () => false,
		},
	},
};

const { useApp } = await import("../src/store/index.ts");
const { applyAgentEvent } = await import("../src/store/apply-event.ts");
const { computeTurnStats, liveTurnMeter } = await import("../src/features/conversation/grouping.ts");
const { CARRY_ON_PROMPTS } = await import("../src/store/derive.ts");

const SESSION = "test-session";
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function user(text: string, timestamp = T0): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(content: AssistantContent[], stopReason: StopReason, timestamp = T0 + SECOND, durationMs = SECOND, output = 100): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "p",
		model: "m",
		usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, total: output },
		stopReason,
		timestamp,
		durationMs,
	};
}

function call(id: string, name = "todo_write", args: Record<string, unknown> = {}): ToolCallContent {
	return { type: "toolCall", id, name, arguments: args };
}

function todoResult(id: string, todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>, timestamp = T0 + 2 * SECOND): Message {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "todo_write",
		content: [{ type: "text", text: "ok" }],
		details: { kind: "todo", todos },
		isError: false,
		timestamp,
	};
}

function feed(event: AgentEvent): void {
	applyAgentEvent(SESSION, event, (partial) => useApp.setState(partial as never), () => useApp.getState());
}

beforeEach(() => {
	useApp.setState({
		activeSessionId: SESSION,
		turns: {},
		carried: {},
		turnStartedAt: null,
		turnTokens: 0,
		queued: {},
		running: false,
		todos: [],
	});
});

test("agent_end with reason max_turns preserves meter in carried and relights on auto-continuation agent_start", () => {
	// Start initial turn
	feed({ type: "agent_start", sessionId: SESSION });
	useApp.setState({
		turns: { [SESSION]: { startedAt: Date.now() - 5000, tokens: 5000 } },
		turnStartedAt: Date.now() - 5000,
		turnTokens: 5000,
	});
	const initialTurn = useApp.getState().turns[SESSION];
	assert.ok(initialTurn);
	const startedAt = initialTurn.startedAt;

	// Loop hits max_turns and emits agent_end
	feed({ type: "agent_end", reason: "max_turns" } as AgentEvent);

	// Meter should be frozen into carried, not wiped to null!
	const carried = useApp.getState().carried[SESSION];
	assert.ok(carried, "carried should not be null after max_turns");
	assert.equal(carried.tokens, 5000);

	// Auto-continuation loop fires agent_start
	feed({ type: "agent_start", sessionId: SESSION });

	// The turn should be relighted from carried rather than starting from zero!
	const relighted = useApp.getState().turns[SESSION];
	assert.ok(relighted, "turn meter should exist after agent_start");
	assert.equal(relighted.tokens, 5000, "tokens should carry across auto-continuation");
	assert.equal(useApp.getState().turnTokens, 5000);
	// Elapsed time should be preserved (startedAt should correspond to now - elapsedMs)
	assert.ok(relighted.startedAt <= startedAt + 100);
	assert.equal(useApp.getState().turnStartedAt, relighted.startedAt);
});

test("agent_end with reason done but unfinished todos preserves meter in carried", () => {
	useApp.setState({
		todos: [
			{ content: "Step 1", status: "completed" },
			{ content: "Step 2", status: "in_progress" },
		],
	});
	feed({ type: "agent_start", sessionId: SESSION });
	useApp.setState({
		turns: { [SESSION]: { startedAt: Date.now() - 10000, tokens: 12000 } },
		turnStartedAt: Date.now() - 10000,
		turnTokens: 12000,
	});

	feed({ type: "agent_end", reason: "done" } as AgentEvent);

	const carried = useApp.getState().carried[SESSION];
	assert.ok(carried, "carried should preserve meter when todos are unfinished");
	assert.equal(carried.tokens, 12000);
});

test("grouping resumesTurn recognizes CARRY_ON_PROMPTS[2] after normal stop with unfinished todos", () => {
	const prompt = CARRY_ON_PROMPTS[2]; // "继续，把清单里没做完的做完。"
	const messages: Message[] = [
		user("请完成这些任务", T0),
		assistant([call("c1", "todo_write")], "toolUse", T0 + SECOND, SECOND, 500),
		todoResult("c1", [
			{ content: "任务 1", status: "completed" },
			{ content: "任务 2", status: "pending" },
		], T0 + 2 * SECOND),
		assistant([{ type: "text", text: "第一步做完了，接下来做第二步。" }], "stop", T0 + 3 * SECOND, 10 * SECOND, 1000),
		user(prompt, T0 + 5 * MINUTE),
		assistant([{ type: "text", text: "全部搞定。" }], "stop", T0 + 5 * MINUTE + SECOND, 5 * SECOND, 200),
	];

	const stats = computeTurnStats(messages, 5);
	// Paused for 5 minutes, running time was (3s-0s)+10s = 13s for first part, plus 1s+5s = 6s for second part => 19s
	assert.ok(stats.durationMs < 60 * SECOND, `reading pause should not be counted into duration, got: ${stats.durationMs}`);
	assert.equal(stats.outputTokens, 1700, "tokens should carry across continuation");
});

test("a running turn the window missed the start of reads its clock back from the transcript, pause excluded", () => {
	// 刷新过窗口，`turns` 里没有这一轮的表；运行行要从转录里读回同一块表，不然耗时一格是空的。
	const messages: Message[] = [
		user("请完成这些任务", T0),
		assistant([call("c1", "todo_write")], "toolUse", T0 + SECOND, SECOND, 500),
		todoResult("c1", [
			{ content: "任务 1", status: "completed" },
			{ content: "任务 2", status: "pending" },
		], T0 + 2 * SECOND),
		assistant([{ type: "text", text: "第一步做完了，接下来做第二步。" }], "stop", T0 + 3 * SECOND, 10 * SECOND, 1000),
		user(CARRY_ON_PROMPTS[2], T0 + 5 * MINUTE),
		assistant([{ type: "text", text: "正在写" }], "pending", T0 + 5 * MINUTE + SECOND, 0, 300),
	];
	const meter = liveTurnMeter(messages);
	assert.ok(meter);
	// 前一段跑了 13 秒，读清单停下的五分钟不算；第二段从「继续」那一刻起，到现在 20 秒。
	assert.equal(T0 + 5 * MINUTE + 20 * SECOND - meter.startedAt, 33 * SECOND);
	// 正在流的那条由运行行另外数（`live`），这里只算收了尾的。
	assert.equal(meter.tokens, 1500);
	// 和这一轮结束时印在回复底下的那份是同一个钟：截到同一条消息，两边一样长。
	assert.equal(T0 + 5 * MINUTE + SECOND - meter.startedAt, computeTurnStats(messages, 5).durationMs);
});

test("a transcript with no turn yet has no clock to read back", () => {
	assert.equal(liveTurnMeter([]), null);
});
