import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionStore } from "@plume/core";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

// The real handler, with Electron and the live-session hub replaced.
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const handlers = new Map();
export const broadcasts = [];
export const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
export const sessions = new Map();
export const broadcast = (id, event) => broadcasts.push({ id, event });
const unused = () => { throw new Error("not part of this test"); };
export const editSessionMessage = unused, revertSessionMessage = unused, deleteSessions = unused, disposeSession = unused,
	ensureLiveSession = unused, createSession = unused, abortSession = unused, promptSession = unused, snapshot = unused, touchSession = unused;
`)}`;
const source = new URL("../electron/ipc/sessions.ts", import.meta.url).href;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL === source && (specifier === "electron" || specifier === "../session-hub.ts")) return { url: fixtureUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const fixture: { handlers: Map<string, Handler>; broadcasts: { id: string; event: unknown }[] } = await import(fixtureUrl);
const { registerSessionsIpc } = await import("../electron/ipc/sessions.ts");
hooks.deregister();

const root = await mkdtemp(join(tmpdir(), "plume-rename-ipc-"));
const store = new SessionStore(join(root, "sessions"));
registerSessionsIpc({ store: () => store, settings: () => ({}) as never, saveSettings: async () => {} });
const rename = fixture.handlers.get("sessions:rename") as Handler;
after(async () => {
	store.close();
	await rm(root, { recursive: true, force: true });
});

test("renaming a cold conversation announces the new title", async () => {
	fixture.broadcasts.length = 0;
	const meta = await store.create(root, "m");
	const renamed = (await rename({}, meta.id, "  new name  ")) as { title?: string } | null;
	assert.equal(renamed?.title, "new name");
	assert.deepEqual(fixture.broadcasts, [{ id: meta.id, event: { type: "title", title: "new name" } }]);
});

test("a conversation deleted between the read and the write is not announced as renamed", async () => {
	fixture.broadcasts.length = 0;
	const meta = await store.create(root, "m");
	const get = store.get.bind(store);
	store.get = async (id) => {
		const found = await get(id);
		await store.delete(id);
		return found;
	};
	try {
		assert.equal(await rename({}, meta.id, "too late"), null);
		assert.deepEqual(fixture.broadcasts, [], "a window would otherwise show a title for a conversation that is gone");
	} finally {
		store.get = get;
	}
});
