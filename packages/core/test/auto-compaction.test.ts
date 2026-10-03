import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactStep } from "../src/agent/compact-step.ts";
import { runAgent } from "../src/agent/loop.ts";
import type { AgentModelContext, AgentRunConfig, AgentSessionContext } from "../src/agent/run-config.ts";
import type { AgentEvent, CommandRun } from "../src/agent/events.ts";
import { compactionTriggerTokens, compactWith } from "../src/runtime/compaction.ts";
import { estimateTokens } from "../src/tokens.ts";
import { completedCompaction } from "../src/runtime/compaction-lifecycle.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { SessionStore } from "../src/session/store.ts";
import { projectTrajectory } from "../src/trajectory/project.ts";
import { classifyFailure, FailureError } from "../src/ai/failure.ts";
import type { streamAssistant } from "../src/ai/index.ts";
import { emptyUsage, type AssistantMessage, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 10000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "test", name: "Test", baseUrl: "http://localhost", api: "anthropic-messages", apiKey: "fixture", enabled: true, models: [model] };
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2, api: provider.api, provider: provider.id, model: model.id, stopReason: "stop", usage: emptyUsage() });
const history = () => Array.from({ length: 12 }, (_, i) => [user(`request ${i} ${"x".repeat(4000)}`), reply("y".repeat(4000))]).flat();
const success: typeof streamAssistant = async function* () { yield { type: "start", partial: reply("") }; return reply("Saved decisions and remaining work."); };
const config = (streamFn = success, signal?: AbortSignal, main?: Pick<AgentSessionContext, "messages"> & Pick<AgentModelContext, "streamFn">): AgentRunConfig => runConfig({
	session: {
		sessionId: "test", systemPrompt: "", messages: main?.messages ?? [],
		compact: (messages, activeModel, observer) => compactWith({ messages, model: activeModel, provider, streamFn, observer }),
	},
	model: { provider, model, streamFn: main?.streamFn },
	tools: { available: [], env: { cwd: tmpdir() } },
	control: { signal },
});
/** What `compactStep` takes from a run: the session group and the stop signal. */
const scope = (run: AgentRunConfig) => [run.session, run.control.signal] as const;

test("automatic compaction records retries in order, commits completion with the boundary and keeps metadata out of the prompt", async () => {
	const events: AgentEvent[] = [];
	const stream: typeof streamAssistant = async function* (_p, _m, _c, options) {
		for (let i = 1; i <= 2; i++) options?.onRetry?.({ attempt: i, delayMs: 1000, reason: "provider secret", failure: classifyFailure({ from: "status", status: 503, body: "provider secret" }) });
		yield { type: "start", partial: reply("") };
		return reply("Saved summary");
	};
	const result = await compactStep(...scope(config(stream)), history(), model, event => { events.push(event); });
	assert.ok(result);
	assert.deepEqual(events.map(e => e.type === "command_status" ? e.command.automatic?.phase : e.type), ["summarizing", "retrying", "retrying", "compacted"]);
	const end = events.at(-1);
	assert.equal(end?.type, "compacted");
	if (end?.type !== "compacted") return;
	assert.equal(end.command?.status, "done");
	assert.equal(end.command?.automatic?.outcome, "summary");
	assert.equal(end.command?.automatic?.retries, 2);
	assert.ok(end.commandId);
	assert.equal(JSON.stringify(events).includes("provider secret"), false);
	assert.equal(JSON.stringify(result.messages).includes(end.commandId), false);
});

for (const failure of ["throw", "fatal", "fatal-message", "error", "empty"] as const) test(`automatic ${failure} failure records a distinguishable local fallback`, async () => {
	const events: AgentEvent[] = [];
	const stream: typeof streamAssistant = async function* () {
		yield { type: "start", partial: reply("") };
		if (failure === "throw") throw new Error("network down");
		if (failure === "fatal") throw new FailureError(classifyFailure({ from: "status", status: 401 }));
		return failure === "empty" ? reply("") : { ...reply(""), stopReason: "error", errorMessage: "service unavailable", ...(failure === "fatal-message" ? { failure: classifyFailure({ from: "status", status: 401 }) } : {}) };
	};
	assert.ok(await compactStep(...scope(config(stream)), history(), model, event => { events.push(event); }));
	const fallback = events.find(e => e.type === "command_status" && e.command.automatic?.phase === "fallback");
	assert.ok(fallback);
	const end = events.at(-1);
	assert.ok(end?.type === "compacted");
	assert.equal(end.command?.automatic?.outcome, "fallback");
	if (failure.startsWith("fatal")) assert.equal(end.command?.automatic?.fault?.kind, "fatal");
	assert.equal(end.command?.status, "done");
	assert.match(end.command?.detail ?? "", /兜底/);
});

test("cancelling during summary retry records cancellation without fallback, boundary or another model request", async () => {
	const controller = new AbortController();
	const events: AgentEvent[] = [];
	let mainCalls = 0;
	const stream: typeof streamAssistant = async function* (_p, _m, _c, options) {
		options?.onRetry?.({ attempt: 1, delayMs: 5000, reason: "offline" });
		controller.abort();
		yield { type: "start", partial: reply("") };
		return { ...reply(""), stopReason: "aborted" };
	};
	const result = await runAgent(config(stream, controller.signal, { messages: history(), streamFn: async () => { mainCalls++; return reply("unexpected"); } }), event => { events.push(event); });
	assert.equal(result.reason, "aborted");
	assert.equal(mainCalls, 0);
	assert.equal(events.some(e => e.type === "compacted"), false);
	const statuses = events.filter(e => e.type === "command_status");
	assert.equal(statuses.at(-1)?.command.status, "cancelled");
	assert.equal(statuses.some(e => e.command.automatic?.phase === "fallback"), false);
});

test("below-threshold history has no phantom operation or summary call", async () => {
	const events: AgentEvent[] = [];
	const result = await compactStep(...scope(config(() => { throw new Error("must not call"); })), [user("hello")], model, event => { events.push(event); });
	assert.equal(result, null);
	assert.deepEqual(events, []);
});

test("a summary too big to fit falls back to dropping the oldest turns instead of leaving history over the window", async () => {
	// 原样返回 null 的话，下一轮带着同一份超长历史再来一遍、再失败一遍。
	const events: AgentEvent[] = [];
	const stream: typeof streamAssistant = async function* () { yield { type: "start", partial: reply("") }; return reply("s".repeat(200000)); };
	const result = await compactStep(...scope(config(stream)), history(), model, event => { events.push(event); });
	assert.ok(result, "it still came back with something sendable");
	assert.equal(result.summary, "", "by dropping, since the summary could not be used");
	assert.ok(estimateTokens(result.messages) < compactionTriggerTokens(model.contextWindow));
});

for (const phase of ["summarizing", "retrying", "fallback"] as const) test(`restart during ${phase} retains the old boundary and does not retry`, async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-auto-recovery-"));
	try {
		const store = new SessionStore(root);
		const log = new SessionLog(store, () => {}, await store.create(root, model.id));
		await log.emit({ type: "compacted", before: 24, after: 8, kept: 6, summary: "old boundary" });
		await log.emit({ type: "command_status", command: { id: "auto", name: "compact", timestamp: 1, at: 99, input: "", status: "running", detail: phase, automatic: { phase, retries: 2 } } });
		const loaded = await new SessionStore(root).load(log.meta.id);
		assert.equal(loaded?.compaction?.summary, "old boundary");
		assert.equal(loaded?.commandRuns?.[0].status, "cancelled");
		assert.equal(loaded?.commandRuns?.[0].automatic?.retries, 2);
		assert.equal(loaded?.commandRuns?.[0].at, 0);
		assert.equal(loaded?.meta.seq, log.meta.seq);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a committed fallback restores as completed after delivery fails; a rejected append retains the old boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-auto-recovery-"));
	try {
		const store = new SessionStore(root);
		let rejectAppend = false;
		const append = store.append.bind(store);
		store.append = (meta, record) => {
			if (rejectAppend && record.type === "event" && record.event.type === "compacted") return Promise.reject(new Error("disk full"));
			return append(meta, record);
		};
		const log = new SessionLog(store, event => { if (event.type === "compacted") throw new Error("window closed"); }, await store.create(root, model.id));
		const command: CommandRun = { id: "auto", name: "compact", timestamp: 1, at: 0, input: "", status: "running", detail: "retrying", automatic: { phase: "fallback", retries: 3, fault: { kind: "upstream" } } };
		await log.emit({ type: "command_status", command });
		const boundary: AgentEvent = { type: "compacted", before: 24, after: 8, summary: "fallback", kept: 6, commandId: command.id, command: completedCompaction(command, 24, 8) };
		await assert.rejects(log.emit(boundary), /window closed/);
		assert.equal(log.commandRuns[0].status, "done");
		const loaded = await store.load(log.meta.id);
		assert.equal(loaded?.commandRuns?.[0].automatic?.outcome, "fallback");
		assert.equal(loaded?.commandRuns?.[0].status, "done");
		const records = []; for await (const record of store.read(log.meta.id)) records.push(record);
		const entries = projectTrajectory(records);
		assert.equal(entries.filter(e => e.source === "compaction").length, 1);
		assert.equal(entries.find(e => e.correlationId === "auto")?.status, "done");
		rejectAppend = true;
		await log.emit({ type: "command_status", command: { ...command, id: "auto-2" } });
		await assert.rejects(log.emit({ ...boundary, commandId: "auto-2", summary: "never written" }), /disk full/);
		const recovered = await store.load(log.meta.id);
		assert.equal(recovered?.compaction?.summary, "fallback");
		assert.equal(recovered?.commandRuns?.[1].status, "cancelled");
	} finally { await rm(root, { recursive: true, force: true }); }
});
