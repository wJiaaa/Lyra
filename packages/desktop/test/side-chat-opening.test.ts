/**
 * 侧边聊天打开到一半时，主会话不能被「按时间清理」当成空闲删掉；被点名删掉了，侧边聊天也不能装回去。
 *
 * 打开要先读侧边聊天的存档，读的这一下它还不在 `sideChats` 里，主会话看起来什么都没在做。
 * 清理恰好落在这一下，会把人正在打开的那条对话删掉；删完存档读回来，侧边聊天照样装上，
 * 挂在一条已经不存在的会话上，之后每说一句都往磁盘写一份没人认领的存档。
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SIDE_CHAT_ID } from "@plume/contract";

// Electron is not there under node; every name it exports is a no-op that answers anything.
const electronUrl = `data:text/javascript,${encodeURIComponent(`
const any = new Proxy(function () {}, { get: (_, key) => (key === "then" ? undefined : any), apply: () => any, construct: () => any });
export const app = any, BrowserWindow = any, clipboard = any, contextBridge = any, desktopCapturer = any, dialog = any,
	globalShortcut = any, ipcMain = any, ipcRenderer = any, Menu = any, nativeImage = any, nativeTheme = any, net = any,
	Notification = any, powerSaveBlocker = any, protocol = any, screen = any, session = any, shell = any,
	systemPreferences = any, Tray = any, webContents = any, webUtils = any;
export default any;
`)}`;
// The archive read is held open by the test; that read is the gap being tested.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const reads = [];
export const saves = [];
export const isSideId = (id) => typeof id === "string" && /^[a-z0-9]{1,32}$/.test(id);
export const loadSideChatSnapshot = () => new Promise((resolve) => reads.push(resolve));
export const saveSideChat = async (...args) => { saves.push(args); };
export const saveSideChatTranscript = async (...args) => { saves.push(args); };
export const settings = () => ({ sideChatModelId: "" });
`)}`;
const service = new URL("../electron/side-chat-service.ts", import.meta.url).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: electronUrl, shortCircuit: true };
		if (context.parentURL === service && (specifier === "./sidechat-store.ts" || specifier === "./app-settings.ts")) return { url: fixtureUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const fixture: { reads: ((snapshot: { messages: [] }) => void)[]; saves: unknown[][] } = await import(fixtureUrl);
const hub = await import("../electron/session-hub.ts");
const { sideChatSetModel } = await import("../electron/side-chat-service.ts");
hooks.deregister();

hub.configureHub({ store: () => ({ deleteMany: async () => {} }) as never, settings: () => ({}) as never, window: () => null });

/** A live conversation doing nothing: no turn, no background work, nothing to start or stop. */
function idleSession(id: string) {
	const session = {
		meta: { id, title: id },
		cwd: join(tmpdir(), "plume-side-opening-not-created"),
		running: false,
		can: { state: new Map() },
		subAgents: { list: () => [] },
		initialize: async () => {},
		dispose: async () => {},
	};
	hub.sessions.set(id, session as never);
}

async function archiveRequested(): Promise<void> {
	while (fixture.reads.length === 0) await new Promise((resolve) => setImmediate(resolve));
}

test("a conversation whose side chat is opening is not cleared as idle", async () => {
	idleSession("opening1");
	const opened = sideChatSetModel("opening1", DEFAULT_SIDE_CHAT_ID, null);
	await archiveRequested();

	assert.deepEqual(await hub.deleteIdleSessions(["opening1"]), [], "the person is opening a side chat on it");
	fixture.reads.shift()?.({ messages: [] });
	await opened;
	assert.ok(hub.liveSideChat("opening1", DEFAULT_SIDE_CHAT_ID));

	// Held only while opening: an open side chat that is not answering does not keep a clear away forever.
	assert.deepEqual(await hub.deleteIdleSessions(["opening1"]), ["opening1"]);
	assert.equal(hub.sideChats.has("opening1"), false);
});

test("a side chat whose conversation was deleted while it opened is not put in place", async () => {
	idleSession("deleted1");
	fixture.saves.length = 0;
	const opened = sideChatSetModel("deleted1", DEFAULT_SIDE_CHAT_ID, null);
	await archiveRequested();

	await hub.deleteSessions(["deleted1"]);
	fixture.reads.shift()?.({ messages: [] });
	await assert.rejects(opened, /not open/);
	assert.equal(hub.sideChats.has("deleted1"), false, "it would hang off a conversation that is gone");
	assert.deepEqual(fixture.saves, [], "and save an archive nobody owns");
});
