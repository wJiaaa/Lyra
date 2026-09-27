import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { readTodos, type TodoItem } from "../src/tools/todo.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig } from "../src/types.ts";

function fixtures(): { model: ModelConfig; provider: ProviderConfig } {
	const model: ModelConfig = {
		id: "test/model",
		providerId: "test",
		modelId: "model",
		name: "Test",
		contextWindow: 128000,
		maxOutputTokens: 4096,
		supportsThinking: false,
		supportsImages: false,
		supportsTools: true,
	};
	return {
		model,
		provider: {
			id: "test",
			name: "Test",
			api: "openai-responses",
			apiKey: "test",
			baseUrl: "http://localhost",
			enabled: true,
			models: [model],
		},
	};
}

test("revert cuts the message and does not start another turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-revert-"));
	const { model, provider } = fixtures();
	let streams = 0;
	const seen: string[] = [];
	const session = new AgentSession({
		cwd: root,
		store: new SessionStore(join(root, "sessions")),
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id },
		emit: async (event) => {
			seen.push(event.type);
		},
		streamFn: async (): Promise<AssistantMessage> => {
			streams += 1;
			return {
				role: "assistant",
				content: [{ type: "text", text: "Replied" }],
				api: provider.api,
				provider: provider.id,
				model: model.modelId,
				stopReason: "stop",
				usage: emptyUsage(),
				timestamp: Date.now(),
			};
		},
	});
	await session.initialize();
	await session.prompt([{ type: "text", text: "First" }]);
	await session.prompt([{ type: "text", text: "Second" }]);
	assert.equal(session.messages.length, 4);
	assert.equal(streams, 2);

	await session.revert(2);
	assert.equal(session.messages.length, 2);
	assert.equal((session.messages[0].content[0] as { text: string }).text, "First");
	assert.equal(streams, 2, "undo is a cut, not another prompt");
	assert.ok(seen.includes("rewound"));
	await session.dispose();
	await rm(root, { recursive: true, force: true });
});

/**
 * 撤回也要把手边那份清单带走。
 *
 * 清单写在两处：日志里那条 `todo_write` 的结果，和给这一轮用的运行时状态。截断只动得到前者，
 * 留下的那份就成了没人写过的计划——下一轮撞上步数上限时，`continueWhileWorkRemains` 会照着它
 * 自花两百步。界面那一半在 `desktop/test/revert-clears-turn-state.test.ts`。
 */
test("revert takes the task plan back with it", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-revert-plan-"));
	const { model, provider } = fixtures();
	const plan = (content: string): TodoItem[] => [{ content, status: "in_progress", activeForm: content }];
	const script: AssistantMessage[] = [];
	const session = new AgentSession({
		cwd: root,
		store: new SessionStore(join(root, "sessions")),
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id },
		emit: async () => {},
		streamFn: async (): Promise<AssistantMessage> => script.shift() ?? reply([{ type: "text", text: "好了。" }], "stop"),
	});

	function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
		return { role: "assistant", content, api: provider.api, provider: provider.id, model: model.modelId, stopReason, usage: emptyUsage(), timestamp: Date.now() };
	}
	const writes = (id: string, todos: TodoItem[]): AssistantMessage =>
		reply([{ type: "toolCall", id, name: "todo_write", arguments: { todos }, argumentsText: "{}" }], "toolUse");

	await session.initialize();
	script.push(writes("t1", plan("第一份计划")));
	await session.prompt([{ type: "text", text: "第一问" }]);
	assert.deepEqual(readTodos(session.can.state), plan("第一份计划"), "前提：第一轮写下了一份计划");
	const firstRound = session.messages.length;

	script.push(writes("t2", plan("第二份计划")));
	await session.prompt([{ type: "text", text: "第二问" }]);
	assert.deepEqual(readTodos(session.can.state), plan("第二份计划"), "前提：第二轮改写了它");

	await session.revert(firstRound);
	assert.deepEqual(readTodos(session.can.state), plan("第一份计划"), "撤到第一轮之后，算数的是第一轮那份");

	await session.revert(0);
	assert.deepEqual(session.messages, [], "转录空了");
	assert.deepEqual(readTodos(session.can.state), [], "再没有谁写过任何计划");

	await session.dispose();
	await rm(root, { recursive: true, force: true });
});

/** 编辑重发截掉的跟撤回一样多，清单也要一样回到截断点——而且在重发的那一轮开跑之前。 */
test("edit-and-resend takes the task plan back with it too", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-edit-plan-"));
	const { model, provider } = fixtures();
	const plan = (content: string): TodoItem[] => [{ content, status: "in_progress", activeForm: content }];
	const script: AssistantMessage[] = [];
	let seenByResend: TodoItem[] | undefined;
	const session = new AgentSession({
		cwd: root,
		store: new SessionStore(join(root, "sessions")),
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id },
		emit: async () => {},
		streamFn: async (): Promise<AssistantMessage> => {
			const next = script.shift();
			if (next) return next;
			seenByResend = readTodos(session.can.state);
			return reply([{ type: "text", text: "好了。" }], "stop");
		},
	});

	function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
		return { role: "assistant", content, api: provider.api, provider: provider.id, model: model.modelId, stopReason, usage: emptyUsage(), timestamp: Date.now() };
	}
	const writes = (id: string, todos: TodoItem[]): AssistantMessage =>
		reply([{ type: "toolCall", id, name: "todo_write", arguments: { todos }, argumentsText: "{}" }], "toolUse");

	await session.initialize();
	script.push(writes("t1", plan("第一份计划")), reply([{ type: "text", text: "记下了。" }], "stop"));
	await session.prompt([{ type: "text", text: "第一问" }]);
	const firstRound = session.messages.length;
	script.push(writes("t2", plan("第二份计划")), reply([{ type: "text", text: "改好了。" }], "stop"));
	await session.prompt([{ type: "text", text: "第二问" }]);
	assert.deepEqual(readTodos(session.can.state), plan("第二份计划"), "前提：第二轮改写了它");

	await session.editAndResend(firstRound, [{ type: "text", text: "改过的第二问" }]);
	assert.deepEqual(seenByResend, plan("第一份计划"), "重发的那一轮看到的是截断点之前那份");
	assert.deepEqual(readTodos(session.can.state), plan("第一份计划"));

	await session.dispose();
	await rm(root, { recursive: true, force: true });
});

test("revert refuses while a turn is still running", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-revert-run-"));
	const { model, provider } = fixtures();
	const gate = Promise.withResolvers<void>();
	const session = new AgentSession({
		cwd: root,
		store: new SessionStore(join(root, "sessions")),
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id },
		emit: async () => {},
		streamFn: async (): Promise<AssistantMessage> => {
			await gate.promise;
			return {
				role: "assistant",
				content: [{ type: "text", text: "Later" }],
				api: provider.api,
				provider: provider.id,
				model: model.modelId,
				stopReason: "stop",
				usage: emptyUsage(),
				timestamp: Date.now(),
			};
		},
	});
	await session.initialize();
	const pending = session.prompt([{ type: "text", text: "Hold" }]);
	await assert.rejects(session.revert(0), /running/);
	gate.resolve();
	await pending;
	await session.dispose();
	await rm(root, { recursive: true, force: true });
});
