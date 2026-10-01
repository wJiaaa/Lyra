import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession, type AgentSessionOptions } from "../src/runtime/session.ts";
import { summarizeTitle } from "../src/runtime/title-summary.ts";
import { SessionStore, type SessionMeta, type SessionRecordInput } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig, type UserMessage } from "../src/types.ts";

const model: ModelConfig = { id: "test/model", providerId: "test", modelId: "model", name: "Test", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "test", name: "Test", api: "openai-responses", apiKey: "test", baseUrl: "http://localhost", enabled: true, models: [model] };
const settings = { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id };
const prompt = "Please review the authentication code and fix the regression.";
function reply(text: string): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: provider.api, provider: provider.id, model: model.modelId, stopReason: "stop", usage: emptyUsage(), timestamp: 1 };
}
async function fixture(t: TestContext, options: Partial<Pick<AgentSessionOptions, "settings" | "titleSummaryStream" | "emit">> = {}) {
	const root = await mkdtemp(join(tmpdir(), "ly-title-life-"));
	const store = new SessionStore(join(root, "sessions"));
	const session = new AgentSession({ cwd: root, store, meta: await store.create(root, model.id), settings, streamFn: async () => reply("Done"), emit: () => {}, ...options });
	t.after(async () => { await session.dispose(); await rm(root, { recursive: true, force: true }); });
	return { root, store, session };
}

function completingStream(result: Promise<AssistantMessage>, onFinal: () => void): NonNullable<AgentSessionOptions["titleSummaryStream"]> {
	return () => {
		const iterator = (async function* () { yield { type: "text_start", index: 0 } as const; return result; })();
		const next = iterator.next.bind(iterator);
		iterator.next = (...args) => next(...args).then((value) => {
			// Settle the result first, then cancel before its awaiting consumer resumes.
			if (value.done) queueMicrotask(onFinal);
			return value;
		});
		return iterator;
	};
}

const billed = { ...emptyUsage(), input: 80, output: 5, reasoning: 0, total: 85, cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 } };

test("cancelling after the final result settles retains reported usage", async () => {
	const controller = new AbortController();
	const result = await summarizeTitle({ text: prompt, provider, model, signal: controller.signal,
		stream: completingStream(Promise.resolve({ ...reply("Automatic"), usage: billed }), () => controller.abort()) });
	assert.equal(controller.signal.aborted, true);
	assert.deepEqual(result, { title: null, usage: billed });
});

test("cancelling after a done event retains usage even without the generator return", async () => {
	const controller = new AbortController();
	const result = await summarizeTitle({ text: prompt, provider, model, signal: controller.signal, stream: async function* () {
		const message = { ...reply("Automatic"), usage: billed };
		yield { type: "done", message };
		controller.abort();
		return message;
	} });
	assert.deepEqual(result, { title: null, usage: billed });
});

test("rename racing with a returned title keeps its cost and the manual name", async (t) => {
	const result = Promise.withResolvers<AssistantMessage>();
	const renamed = Promise.withResolvers<void>();
	const { store, session } = await fixture(t, { titleSummaryStream: completingStream(result.promise, () => {
		void session.rename("Manual").then(renamed.resolve, renamed.reject);
	}) });
	await session.prompt([{ type: "text", text: prompt }]);
	result.resolve({ ...reply("Automatic"), usage: billed });
	await renamed.promise;
	assert.deepEqual(session.meta.usage, billed);
	assert.equal(session.meta.title, "Manual");
	assert.deepEqual((await store.load(session.meta.id))?.meta.usage, billed);
});

test("dispose waits for cancelled title usage to finish writing before deletion", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-title-usage-"));
	const result = Promise.withResolvers<AssistantMessage>();
	const usageStarted = Promise.withResolvers<void>();
	const allowUsage = Promise.withResolvers<void>();
	const disposing = Promise.withResolvers<void>();
	let started = false;
	let disposed = false;
	class PausedStore extends SessionStore {
		override async append(meta: SessionMeta, record: SessionRecordInput) {
			if (record.type === "usage") { started = true; usageStarted.resolve(); await allowUsage.promise; }
			return super.append(meta, record);
		}
	}
	const store = new PausedStore(join(root, "sessions"));
	const session = new AgentSession({ cwd: root, store, meta: await store.create(root, model.id), settings, emit: () => {}, streamFn: async () => reply("Done"),
		titleSummaryStream: completingStream(result.promise, () => {
			void session.dispose().then(() => { disposed = true; disposing.resolve(); }, disposing.reject);
		}) });
	t.after(async () => { allowUsage.resolve(); await session.dispose(); await rm(root, { recursive: true, force: true }); });
	await session.prompt([{ type: "text", text: prompt }]);
	result.resolve({ ...reply("Automatic"), usage: billed });
	await Promise.race([usageStarted.promise, disposing.promise]);
	assert.equal(started, true);
	assert.equal(disposed, false);
	allowUsage.resolve();
	await disposing.promise;
	assert.deepEqual(session.meta.usage, billed);
	assert.notEqual(session.meta.title, "Automatic");
	await store.delete(session.meta.id);
	assert.equal(await store.load(session.meta.id), null);
});

test("dispose before any reported usage does not invent costs or revive the deleted log", async (t) => {
	const result = Promise.withResolvers<AssistantMessage>();
	const lateFinal = Promise.withResolvers<void>();
	const { store, session } = await fixture(t, { titleSummaryStream: completingStream(result.promise, lateFinal.resolve) });
	await session.prompt([{ type: "text", text: prompt }]);
	const before = structuredClone(session.meta.usage);
	await session.dispose();
	await store.delete(session.meta.id);
	result.resolve({ ...reply("Too late"), usage: billed });
	await lateFinal.promise;
	assert.deepEqual(session.meta.usage, before);
	assert.equal(await store.load(session.meta.id), null);
});

test("title fallback preserves ordinary user prose and uses structured display text", async (t) => {
	const { session } = await fixture(t, { settings: { ...settings, autoSummarizeTitle: false } });
	const text = "使用已有技能优化页面。先检查菜单的滚动问题。";
	await session.prompt([{ type: "text", text }]);
	assert.equal(session.meta.title, text);
	const second = await fixture(t, { settings: { ...settings, autoSummarizeTitle: false } });
	await second.session.prompt([{ type: "text", text: "Injected context only" }], { displayText: "[上下文引用提示] 是用户正在讨论的标签" });
	assert.equal(second.session.meta.title, "[上下文引用提示] 是用户正在讨论的标签");
});

for (const action of ["dispose", "abort", "disable", "edit"] as const) {
	test(`${action} cancels the pending title request`, async (t) => {
		const result = Promise.withResolvers<AssistantMessage>();
		let signal: AbortSignal | undefined;
		let calls = 0;
		const { session } = await fixture(t, { titleSummaryStream: async function* (_provider, _model, _context, options) {
			calls++;
			if (calls > 1) { const message = reply("New title"); yield { type: "done", message }; return message; }
			signal = options?.signal;
			const message = await result.promise;
			yield { type: "done", message };
			return message;
		} });
		await session.prompt([{ type: "text", text: prompt }]);
		let pending: Promise<void> | undefined;
		if (action === "dispose") pending = session.dispose();
		else if (action === "abort") session.abort();
		else if (action === "disable") session.updateSettings({ ...settings, autoSummarizeTitle: false });
		else pending = session.editAndResend(0, [{ type: "text", text: "New question" }]);
		const cancelled = signal?.aborted;
		result.resolve(reply("Stale title"));
		await pending;
		assert.equal(cancelled, true);
	});
}

test("rename waits for an already-started automatic title write", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-title-write-"));
	const autoStarted = Promise.withResolvers<void>();
	const allowAuto = Promise.withResolvers<void>();
	let manualStarted = false;
	class PausedStore extends SessionStore {
		override async append(meta: SessionMeta, record: SessionRecordInput) {
			if (record.type === "title" && record.title === "Automatic") { autoStarted.resolve(); await allowAuto.promise; }
			if (record.type === "title" && record.title === "Manual") manualStarted = true;
			return super.append(meta, record);
		}
	}
	const store = new PausedStore(join(root, "sessions"));
	const session = new AgentSession({ cwd: root, store, meta: await store.create(root, model.id), settings, emit: () => {}, streamFn: async () => reply("Done"), titleSummaryStream: async function* () {
		const message = reply("Automatic"); yield { type: "done", message }; return message;
	} });
	t.after(async () => { allowAuto.resolve(); await session.dispose(); await rm(root, { recursive: true, force: true }); });
	const running = session.prompt([{ type: "text", text: prompt }]);
	await autoStarted.promise;
	const renaming = session.rename("Manual");
	const overlapped = manualStarted;
	allowAuto.resolve();
	await Promise.all([running, renaming]);
	assert.equal(overlapped, false);
	assert.equal(session.meta.title, "Manual");
	const loaded = await store.load(session.meta.id);
	assert.equal(loaded?.meta.title, "Manual");
	assert.equal(loaded?.meta.titleSetByUser, true);
});

test("title usage is counted and survives reopening without adding conversation messages", async (t) => {
	const titled = Promise.withResolvers<void>();
	const usage = { ...emptyUsage(), input: 100, output: 10, reasoning: 0, total: 110, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
	const { store, session } = await fixture(t, { emit: (event: AgentEvent) => { if (event.type === "title" && event.title === "Automatic") titled.resolve(); }, titleSummaryStream: async function* () {
		const message = { ...reply("Automatic"), usage }; yield { type: "done", message }; return message;
	} });
	await session.prompt([{ type: "text", text: prompt }]);
	await titled.promise;
	assert.deepEqual(session.meta.usage, usage);
	const loaded = await store.load(session.meta.id);
	assert.deepEqual(loaded?.meta.usage, usage);
	assert.equal(loaded?.messages.length, 2);
	await session.log.truncateFrom(0);
	assert.deepEqual((await store.load(session.meta.id))?.meta.usage, usage, "rewriting the prompt does not erase a title request that was already billed");
});

test("image-only opening retains a useful title", async (t) => {
	const { session } = await fixture(t);
	await session.prompt([{ type: "image", mimeType: "image/png", data: "AA==" }]);
	assert.equal(session.meta.title, "图片消息");
});

test("title requests bound long prompts without splitting Unicode characters", async () => {
	let sent = "";
	await summarizeTitle({ text: "😀".repeat(100000), provider, model, stream: async function* (_provider, _model, context) {
		sent = JSON.stringify(context.messages);
		const message = reply("Emoji task"); yield { type: "done", message }; return message;
	} });
	assert.ok(sent.length < 10000, `title request has ${sent.length} characters`);
	assert.doesNotMatch(sent, /\\ud[89ab][0-9a-f]{2}/i);
});

for (const resumed of [false, true]) {
	for (const reference of [{ skillRef: { name: "review" } }, { sessionRefs: [{ id: "previous", title: "菜单滚动问题" }] }]) {
		test(`${resumed ? "resumed" : "direct"} reference-only prompt keeps its visible reference title: ${JSON.stringify(reference)}`, async (t) => {
			const root = await mkdtemp(join(tmpdir(), "ly-title-reference-"));
			const store = new SessionStore(join(root, "sessions"));
			const title = reference.skillRef?.name ?? reference.sessionRefs[0].title;
			const message: UserMessage = { role: "user", content: [{ type: "text", text: "Injected reference instructions" }], timestamp: 1, displayText: "", ...reference };
			let meta = await store.create(root, model.id, title);
			if (resumed) {
				meta = await store.append(meta, { type: "message", message });
				meta = await store.append(meta, { type: "meta", meta: { ...meta, pendingPrompt: true } });
			}
			const session = new AgentSession({ cwd: root, store, meta, settings, streamFn: async () => reply("Done"), emit: () => {} });
			t.after(async () => { await session.dispose(); await rm(root, { recursive: true, force: true }); });
			if (resumed) {
				session.restore([message]);
				await session.resumePendingPrompt();
			} else await session.prompt(message.content, { displayText: "", ...reference });
			assert.equal(session.meta.title, title);
			assert.equal((await store.load(meta.id))?.meta.title, title);
		});
	}
}
