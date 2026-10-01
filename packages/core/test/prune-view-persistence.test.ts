import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { AgedToolPruner } from "../src/runtime/aged-prune.ts";
import { compactIfNeeded } from "../src/runtime/compaction.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "m", modelId: "m", providerId: "p", name: "m", contextWindow: 20_000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "p", name: "p", api: "openai-responses", baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const reply = (content: AssistantMessage["content"], input = 0): AssistantMessage => ({ role: "assistant", api: "openai-responses", provider: "p", model: "m", stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", usage: { ...emptyUsage(), input }, content, timestamp: 1 });
const result = (id: string, text: string, uneventful = false): Message => ({ role: "toolResult", toolCallId: id, toolName: "grep", isError: false, content: [{ type: "text", text }], timestamp: 1, ...(uneventful ? { uneventful } : {}) });

/** One user turn through the real loop; returns what was sent and what the log would gain. */
async function turn(history: Message[], pruner: AgedToolPruner, answerUsage: number) {
	let sent: Message[] = [];
	const produced: Message[] = [];
	await runAgent({
		sessionId: "s", cwd: "/test", model, provider, messages: history, tools: [], systemPrompt: "", pruner,
		compact: (messages, active, observer) => compactIfNeeded(messages, active, provider, undefined, 0, false, undefined, undefined, undefined, observer),
		streamFn: async (context: LlmContext) => { sent = [...context.messages]; return reply([{ type: "text", text: "ok" }], answerUsage); },
	}, async (event) => { if (event.type === "message_end") produced.push(event.message); });
	return { sent, produced };
}

test("a result cut by compaction stays cut when the next turn rebuilds history from the log", async () => {
	const big = result("t1", "a".repeat(30_000));
	// Measured near the window, so compaction runs; pruning the one big result is enough on its own.
	const log: Message[] = [user("look"), reply([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }]), big, reply([{ type: "text", text: "found" }], 17_000), user("next")];
	const pruner = new AgedToolPruner();
	const first = await turn(log, pruner, 3_000);
	assert.match(JSON.stringify(first.sent[2]), /characters omitted/, "precondition: compaction cut the result");

	// The log keeps the original; the next turn starts from it, as `modelHistory` does.
	const second = await turn([...log, ...first.produced, user("again")], pruner, 3_000);
	assert.deepEqual(second.sent.slice(0, first.sent.length), first.sent, "the next request continues the prefix that was sent");
	assert.equal(big.content[0].type === "text" && big.content[0].text.length, 30_000, "and the log is untouched");
});

test("an emptied result is not restored once later turns make re-emptying look expensive", async () => {
	const empty = result("t1", "no matches\n".repeat(40), true);
	const log: Message[] = [user("look"), reply([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }]), empty, reply([{ type: "text", text: "nothing" }]), user("next")];
	const pruner = new AgedToolPruner();
	const first = await turn(log, pruner, 100);
	assert.match(JSON.stringify(first.sent[2]), /无结果/, "precondition: emptied while nothing sat below it");
	// Enough later text that rewriting the result now would break a large warm prefix.
	const later = [reply([{ type: "text", text: "x".repeat(40_000) }]), user("again")];
	const second = await turn([...log, ...first.produced, ...later], pruner, 100);
	assert.deepEqual(second.sent[2], first.sent[2]);
});

test("the tail kept beside a summary is rebuilt as the cut copy that was sent", async () => {
	const big = result("t9", "b".repeat(30_000));
	const filler = Array.from({ length: 24 }, (_, i) => (i % 2 ? user(`step ${i} ${"y".repeat(3000)}`) : reply([{ type: "text", text: `done ${i} ${"z".repeat(3000)}` }])));
	const log: Message[] = [user("start"), ...filler, reply([{ type: "toolCall", id: "t9", name: "grep", arguments: {} }]), big, reply([{ type: "text", text: "found" }], 19_000), user("next")];
	const pruner = new AgedToolPruner();
	let kept: number | undefined;
	let sent: Message[] = [];
	const produced: Message[] = [];
	await runAgent({
		sessionId: "s", cwd: "/test", model, provider, messages: log, tools: [], systemPrompt: "", pruner,
		compact: (messages, active, observer) => compactIfNeeded(messages, active, provider, async function* () { yield { type: "start" as const, partial: reply([]) }; return reply([{ type: "text", text: "summary" }]); }, 0, false, undefined, undefined, undefined, observer),
		streamFn: async (context: LlmContext) => { sent = [...context.messages]; return reply([{ type: "text", text: "ok" }], 3_000); },
	}, async (event) => {
		if (event.type === "compacted") kept = event.kept;
		if (event.type === "message_end") produced.push(event.message);
	});
	assert.ok(kept !== undefined && sent.some((message) => message.role === "toolResult" && /characters omitted/.test(JSON.stringify(message))), "precondition: summarised with the cut result in the tail");

	// What `modelHistory` rebuilds: the summary head, then the kept tail from the log's originals.
	const rebuilt = [...sent.slice(0, sent.length - kept!), ...log.slice(-kept!), ...produced, user("again")];
	const second = await turn(rebuilt, pruner, 3_000);
	assert.deepEqual(second.sent.slice(0, sent.length), sent);
});

test("a result cut by compaction is sent cut again after a restart, not rebuilt from the log's original", async (t) => {
	const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { DEFAULT_SETTINGS } = await import("../src/config/settings.ts");
	const { AgentSession } = await import("../src/runtime/session.ts");
	const { SessionStore } = await import("../src/session/store.ts");
	const root = await mkdtemp(join(tmpdir(), "ly-views-"));
	await mkdir(join(root, "home"), { recursive: true });
	process.env.PLUME_HOME = join(root, "home");
	t.after(async () => {
		delete process.env.PLUME_HOME;
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	});
	const settings = { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id, mcpServers: [], permissionMode: "full" as const };
	const store = new SessionStore(join(root, "sessions"));
	let meta = await store.create(root, model.id);
	// Measured near the window, so the next turn compacts; cutting the one big result is enough on its own.
	for (const message of [user("look"), reply([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }]), result("t1", "a".repeat(30_000)), reply([{ type: "text", text: "found" }], 17_000)]) {
		meta = await store.append(meta, { type: "message", message });
	}

	/** Open the stored session the way the desktop hub does, send one message, return what went out. */
	const open = async (text: string) => {
		const loaded = (await store.load(meta.id))!;
		let sent: Message[] = [];
		const session = new AgentSession({
			cwd: root, settings, store, meta: loaded.meta, emit: () => {},
			streamFn: async (context: LlmContext) => { sent = [...context.messages]; return reply([{ type: "text", text: "ok" }], 3_000); },
		});
		session.restore(loaded.messages, loaded.compaction, loaded.compactions);
		await session.initialize();
		await session.prompt([{ type: "text", text }]);
		session.abort();
		return sent;
	};

	const before = await open("next");
	const cut = before.find((message) => message.role === "toolResult");
	assert.match(JSON.stringify(cut), /characters omitted/, "precondition: compaction cut the result");

	const after = await open("again");
	assert.deepEqual(after.find((message) => message.role === "toolResult"), cut, "the restarted session sends what was sent before the restart");
});
