/**
 * 侧边聊天会话在主进程这一侧的起落：按「会话 + 面板 id」建一次、关掉就删、跟着父会话删，
 * 父会话被撤空时一起收掉；以及正在建、正在答的时候，父会话不被「按时间清理」当成空闲删掉。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";
import { SessionStore } from "@plume/core";

// Electron is not there under node; every name it exports is a no-op that answers anything.
const electronUrl = `data:text/javascript,${encodeURIComponent(`
const any = new Proxy(function () {}, { get: (_, key) => (key === "then" ? undefined : any), apply: () => any, construct: () => any });
export const app = any, BrowserWindow = any, clipboard = any, contextBridge = any, desktopCapturer = any, dialog = any,
	globalShortcut = any, ipcMain = any, ipcRenderer = any, Menu = any, nativeImage = any, nativeTheme = any, net = any,
	Notification = any, powerSaveBlocker = any, protocol = any, screen = any, session = any, shell = any,
	systemPreferences = any, Tray = any, webContents = any, webUtils = any;
export default any;
`)}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: electronUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const hub = await import("../electron/session-hub.ts");
const { sideChatClose, sideChatList, sideChatOpen } = await import("../electron/side-chat-service.ts");
hooks.deregister();

// Deleting a session sweeps the app's own directory; it must be a throwaway one.
const home = await mkdtemp(join(tmpdir(), "plume-hub-"));
process.env.PLUME_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));

const store = new SessionStore(join(home, "sessions"));
hub.configureHub({ store: () => store, settings: () => ({ sideChatModelId: "" }) as never, window: () => null });

/** A conversation on disk, live and doing nothing: no turn, no background work. */
async function idleSession(overrides: Record<string, unknown> = {}) {
	const meta = await store.create(home, "qa/model");
	const session = {
		meta,
		cwd: home,
		running: false,
		messages: [{ role: "user" }],
		can: { state: new Map() },
		subAgents: { list: () => [] },
		initialize: async () => {},
		dispose: async () => {},
		...overrides,
	};
	hub.sessions.set(meta.id, session as never);
	return meta.id;
}

test("同一格同时开两次只建一个，关掉就连记录一起删", async () => {
	const parent = await idleSession();
	const [a, b] = await Promise.all([sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID), sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID)]);
	assert.equal(a.id, b.id);
	assert.equal(a.parentId, parent);
	assert.equal(a.modelId, "", "no model of its own: it follows the main session");
	const other = await sideChatOpen(parent, "x1");
	assert.deepEqual((await sideChatList(parent)).map((meta) => meta.id).sort(), [a.id, other.id].sort());
	assert.ok(!(await store.listSessions()).some((meta) => meta.parentId), "not in the session list");

	await sideChatClose(parent, DEFAULT_SIDE_CHAT_ID);
	assert.equal(await store.get(a.id), null);
	assert.ok(await store.get(other.id), "the other panel's session stays");
	assert.ok(await store.get(parent), "and so does the conversation");
});

test("删掉会话，旁边的侧边聊天一起删", async () => {
	const parent = await idleSession();
	const side = await sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID);
	await hub.deleteSessions([parent]);
	assert.equal(await store.get(side.id), null);
	assert.deepEqual(await sideChatList(parent), []);
});

test("主会话撤空，旁边的侧边聊天跟着收掉；撤到中间不碰", async () => {
	const messages = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
	const parent = await idleSession({ messages, revert: async (index: number) => { messages.length = index; } });
	await hub.ensureLiveSession(parent);
	const side = await sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID);

	await hub.revertSessionMessage(parent, 1);
	assert.ok(await store.get(side.id), "the main session still has something for it to be about");

	await hub.revertSessionMessage(parent, 0);
	assert.equal(await store.get(side.id), null);
	assert.ok(await store.get(parent));
});

test("侧边聊天还在答，父会话不算空闲", async () => {
	const parent = await idleSession();
	const side = await sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID);
	const live = { meta: side, parent: hub.sessions.get(parent), running: true, can: { state: new Map() }, subAgents: { list: () => [] }, dispose: async () => {} };
	hub.sessions.set(side.id, live as never);

	assert.deepEqual(await hub.deleteIdleSessions([parent]), [], "the person is talking to it");
	live.running = false;
	assert.deepEqual(await hub.deleteIdleSessions([parent]), [parent]);
	assert.equal(await store.get(side.id), null);
});

test("建侧边聊天的过程中父会话被删了，不留一个挂在空处的会话", async () => {
	const parent = await idleSession();
	const opening = sideChatOpen(parent, DEFAULT_SIDE_CHAT_ID);
	await hub.deleteSessions([parent]);
	await opening.catch(() => {});
	assert.deepEqual((await store.listSessions({ children: true })).filter((meta) => meta.parentId === parent), []);
});

test("a prompt admitted before cleanup is not cleared as idle", async () => {
	let finishPrompt!: () => void;
	let disposed = false;
	const id = await idleSession({
		dispose: async () => { disposed = true; },
		prompt: async () => new Promise<void>((resolve) => { finishPrompt = resolve; }),
	});
	await hub.ensureLiveSession(id);
	const prompted = hub.promptSession(id, "hello");

	assert.deepEqual(await hub.deleteIdleSessions([id]), [], "the prompt crossed its first await");
	await prompted;
	assert.equal(disposed, false);

	finishPrompt();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(await hub.deleteIdleSessions([id]), [id]);
});

test("deleting a conversation takes what it wrote outside the project", async () => {
	const left = [join(home, "previews", "gone1"), join(home, "scratch", "gone1")];
	for (const dir of left) await mkdir(dir, { recursive: true });
	await mkdir(join(home, "scratch", "kept1"), { recursive: true });

	await hub.deleteSessions(["gone1"]);
	for (const dir of left) await assert.rejects(stat(dir), `${dir} belonged to the deleted conversation`);
	await stat(join(home, "scratch", "kept1"));
});
