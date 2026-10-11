/**
 * 侧边聊天会话在窗口这一侧住在哪：`sessionCache` 里，和分屏另一屏的会话一样——但它从不上台、不进
 * 会话列表，读进来的过程中到的事件要接得上，缓存满了也不能被挤掉。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { AssistantMessage, Message, SessionMeta } from "@plume/core";
import type { SessionSnapshot } from "../../electron/ipc-shapes.ts";
import { useSide } from "../../src/features/dock/sideStore.ts";
import { prune, type Cache } from "../../src/store/derive.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { applySessionChange } from "../../src/store/session-changes.ts";
import { readSideSession } from "../../src/store/session-read.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string, timestamp = 1): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });
const answer: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "qa", model: "qa", content: [{ type: "text", text: "Live answer" }], timestamp: 2, stopReason: "stop", usage };
const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({ id, title: "", cwd: "/p", projectId: "p", projectName: "p", createdAt: 1, updatedAt: 1, modelId: "", messageCount: 1, usage, seq: 1, ...extra });
const side = meta("side1", { parentId: "main", sideId: "default" });

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { resolve, promise };
}

let previous: { app: AppState; side: ReturnType<typeof useSide.getState> };
beforeEach(() => {
	previous = { app: useApp.getState(), side: useSide.getState() };
	useApp.setState({ activeSessionId: "main", sessions: [meta("main")], sessionCache: {}, activity: {} });
	useSide.setState({ sides: { main: { default: side } } });
});
afterEach(() => {
	useApp.setState(previous.app, true);
	useSide.setState(previous.side, true);
	Reflect.deleteProperty(window, "plume");
});

test("读进来的过程中答完的那一段接得上，不丢也不重复", async () => {
	const transcript = deferred<SessionSnapshot>();
	Object.defineProperty(window, "plume", { configurable: true, value: { sessions: { transcript: () => transcript.promise } } });
	const reading = readSideSession(side, useApp.setState, useApp.getState);
	const { applyEvent } = useApp.getState();
	applyEvent("side1", { type: "message_start", message: { ...answer, stopReason: "pending" } } as never);
	applyEvent("side1", { type: "message_end", message: answer } as never);
	applyEvent("side1", { type: "agent_end", reason: "done" } as never);
	transcript.resolve({ meta: side, messages: [user("Old question")], running: true, pendingApprovals: [] } as unknown as SessionSnapshot);
	await reading;

	const cached = useApp.getState().sessionCache.side1;
	assert.deepEqual(cached?.messages, [user("Old question"), answer]);
	assert.equal(cached?.state?.running, false);
	assert.equal(useApp.getState().activeSessionId, "main", "it never takes the stage");
});

test("缓存满了，开着的侧边聊天不被挤掉", () => {
	const entry = (one: SessionMeta): Cache[string] => ({ meta: one, messages: [], toolRuns: {} });
	const cache: Cache = { side1: entry(side) };
	for (let index = 0; index < 20; index++) cache[`s${index}`] = entry(meta(`s${index}`));
	const kept = prune(cache, "s19");
	assert.ok(kept.side1, "the side chat is only ever read from here");
	assert.equal(Object.keys(kept).filter((id) => id !== "side1").length, 12);
});

test("侧边聊天会话变了不进会话列表，没了就连缓存一起拿掉", () => {
	useApp.setState({ sessionCache: { side1: { meta: side, messages: [user("q")], toolRuns: {} } } });
	const titled = { ...side, title: "为什么报错", seq: 2 };
	applySessionChange({ id: "side1", projectId: "p", meta: titled }, useApp.setState, useApp.getState);
	assert.deepEqual(useApp.getState().sessions.map((one) => one.id), ["main"]);
	assert.equal(useApp.getState().sessionCache.side1?.meta.title, "为什么报错");

	applySessionChange({ id: "side1", projectId: "p", meta: null }, useApp.setState, useApp.getState);
	assert.equal(useApp.getState().sessionCache.side1, undefined);
	assert.equal(useApp.getState().activeSessionId, "main");
});

test("那一格记着最新的会话，旧的一份不盖新的，没了就摘掉", () => {
	useSide.getState().noteSide({ ...side, title: "新标题", seq: 5 });
	useSide.getState().noteSide({ ...side, title: "旧标题", seq: 4 });
	assert.equal(useSide.getState().sides.main?.default?.title, "新标题");
	useSide.getState().forgetSide("side1");
	assert.equal(useSide.getState().sides.main?.default, undefined);
});
