/**
 * `window.plume` over a WebSocket, for a browser opened through Web access.
 *
 * The claims: a call goes out as one frame and comes back as its answer; a method the desktop
 * refuses is nothing rather than an error; a method outside `WEB_METHODS` is never sent at all; the
 * events the store subscribes to arrive where it subscribed; and a dropped socket fails what was in
 * flight, refuses new messages, and reconnects on its own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { absentValue, browserPlatform, createWebBridge, type SocketLike, type WebConnection } from "../src/services/web-bridge.ts";
import { available, onWeb } from "../src/services/host.ts";

/** A socket the test drives by hand. */
class FakeSocket implements SocketLike {
	readyState = 0;
	sent: { type: string; id?: string; method?: string; args?: unknown[] }[] = [];
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.onclose?.({});
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(message: unknown) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	/** The last rpc frame sent. */
	get call() {
		const calls = this.sent.filter((frame) => frame.type === "rpc");
		return calls[calls.length - 1];
	}
}

function harness() {
	const sockets: FakeSocket[] = [];
	const statuses: WebConnection[] = [];
	const bridge = createWebBridge({
		url: "ws://desk/ws",
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		platform: "darwin",
		onConnection: (status) => statuses.push(status),
		timeoutMs: 1000,
		heartbeatMs: 60_000,
	});
	return { bridge, api: bridge.api, sockets, statuses, socket: () => sockets[sockets.length - 1] };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a call queued before the socket opens goes out once it does, and resolves with the answer", async () => {
	const { bridge, api, socket } = harness();
	try {
		const listed = api.sessions.list();
		assert.equal(socket().sent.length, 0, "nothing can be sent into a socket that is not open");
		socket().open();
		assert.equal(socket().call?.method, "sessions.list");
		socket().receive({ type: "rpc_result", id: socket().call?.id, ok: true, value: [{ id: "a" }] });
		assert.deepEqual(await listed, [{ id: "a" }]);
	} finally {
		bridge.close();
	}
});

test("arguments travel as they were given", async () => {
	const { bridge, api, socket } = harness();
	try {
		socket().open();
		const sent = api.agent.abort("s1");
		assert.deepEqual(socket().call?.args, ["s1"]);
		socket().receive({ type: "rpc_result", id: socket().call?.id, ok: true, value: null });
		await sent;
	} finally {
		bridge.close();
	}
});

test("a refused method is nothing, not an error; a real failure still throws", async () => {
	const { bridge, api, socket } = harness();
	try {
		socket().open();
		const refused = api.sessions.list();
		socket().receive({ type: "rpc_result", id: socket().call?.id, ok: false, error: "method-not-allowed" });
		assert.equal(await refused, null);
		const failed = api.sessions.list();
		socket().receive({ type: "rpc_result", id: socket().call?.id, ok: false, error: "boom" });
		await assert.rejects(failed, /boom/);
	} finally {
		bridge.close();
	}
});

test("a method outside the allowlist is null, whatever it is called, and is never sent", async () => {
	const { bridge, api, socket } = harness();
	try {
		socket().open();
		/*
		 * Null for a `list` too. Guessing `[]` from the name was wrong for `windows.list()`, which
		 * answers `{ sessions, panels }` — the empty array put `sessions: undefined` into the store and
		 * took the sidebar down on the first frame.
		 */
		assert.equal(await api.terminal.list(), null);
		assert.equal(await api.windows.list(), null);
		assert.equal(await api.settings.save({} as never), null);
		assert.equal(socket().sent.length, 0);
		for (const name of ["list", "listAll", "status", "save", "anything"]) assert.equal(absentValue(), null, name);
	} finally {
		bridge.close();
	}
});

test("in a browser, the sidebar's detached-window list is never replaced by something that is not a list", async () => {
	const { bridge, api } = harness();
	const scope = globalThis as { plume?: unknown };
	scope.plume = api;
	try {
		const { useSessionWindows, watchSessionWindows } = await import("../src/features/split/session-windows.ts");
		const stop = watchSessionWindows();
		await tick();
		assert.ok(Array.isArray(useSessionWindows.getState().sessions), "SessionRow calls `.includes` on it every render");
		stop();
	} finally {
		delete scope.plume;
		bridge.close();
	}
});

test("a dropped file has no path in a browser, rather than a promise mistaken for one", () => {
	const { bridge, api } = harness();
	try {
		assert.equal(typeof api.files.pathForDrop, "undefined");
	} finally {
		bridge.close();
	}
});

test("members the contract does not know resolve quietly instead of throwing inside a render", async () => {
	const { bridge, api } = harness();
	try {
		const loose = api as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
		assert.equal(typeof loose.onTrayCommand(() => {}), "function", "an onSomething hands back an unsubscribe");
		assert.equal(typeof loose.windows.onChanged(() => {}), "function", "inside a group as well");
		assert.equal(await loose.nothing.here(), null, "and anything else can be called to any depth");
		assert.equal(api.files.mediaUrl("/x.png"), "", "there is no local file behind a browser page");
		assert.equal(api.host, "web");
		assert.equal(api.platform, "darwin");
	} finally {
		bridge.close();
	}
});

test("pushes reach the handlers the store subscribed, and unsubscribing stops them", () => {
	const { bridge, api, socket } = harness();
	try {
		socket().open();
		const agent: unknown[] = [];
		const sessions: unknown[] = [];
		const settings: unknown[] = [];
		const side: unknown[] = [];
		const stop = api.agent.onEvent((payload) => agent.push(payload));
		api.sessions.onChanged((change) => sessions.push(change));
		api.settings.onChanged((next) => settings.push(next));
		api.sideChat.onEvent((payload) => side.push(payload));
		socket().receive({ type: "agent_event", sessionId: "s1", event: { type: "turn_start" } });
		socket().receive({ type: "session_changed", change: { id: "s1" } });
		socket().receive({ type: "settings_changed", settings: { a: 1 } });
		socket().receive({ type: "side_chat_event", sessionId: "s1", sideId: "default", event: { kind: "x" } });
		assert.deepEqual(agent, [{ sessionId: "s1", event: { type: "turn_start" } }]);
		assert.deepEqual(sessions, [{ id: "s1" }]);
		assert.deepEqual(settings, [{ a: 1 }]);
		assert.deepEqual(side, [{ sessionId: "s1", sideId: "default", event: { kind: "x" } }]);
		stop();
		socket().receive({ type: "agent_event", sessionId: "s1", event: { type: "turn_end" } });
		assert.equal(agent.length, 1);
	} finally {
		bridge.close();
	}
});

test("a dropped socket fails what was in flight, refuses new messages, and reconnects", async () => {
	const { bridge, api, sockets, statuses, socket } = harness();
	try {
		socket().open();
		const inFlight = api.sessions.list();
		socket().close();
		await assert.rejects(inFlight, "a call the old socket carried cannot be answered by a new one");
		assert.equal(bridge.status(), "reconnecting");
		await assert.rejects(api.agent.prompt("s1", "hi" as never), "a message sent a minute late is worse than one that visibly failed");
		const read = api.sessions.list();

		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.equal(sockets.length, 2, "a new socket after the first backoff");
		socket().open();
		assert.equal(bridge.status(), "connected");
		assert.deepEqual(statuses, ["connected", "reconnecting", "connected"]);
		assert.equal(socket().call?.method, "sessions.list", "reads wait for the link and go out on it");
		socket().receive({ type: "rpc_result", id: socket().call?.id, ok: true, value: [] });
		assert.deepEqual(await read, []);
	} finally {
		bridge.close();
	}
});

test("a call that is never answered fails instead of spinning forever", async () => {
	const { bridge, api, socket } = harness();
	try {
		socket().open();
		await assert.rejects(api.sessions.list());
	} finally {
		bridge.close();
	}
	await tick();
});

test("the viewer's system decides the shortcut glyphs", () => {
	assert.equal(browserPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "darwin");
	assert.equal(browserPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "darwin");
	assert.equal(browserPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "win32");
	assert.equal(browserPlatform("Mozilla/5.0 (X11; Linux x86_64)"), "linux");
});

test("available(): every method in a window, only the allowlist in a browser, never a typo", () => {
	const scope = globalThis as { plume?: unknown };
	try {
		assert.equal(onWeb(), false);
		assert.equal(available("terminal", "open"), true);
		assert.equal(available("terminal", "nope"), false, "a name the contract does not have exists nowhere");
		scope.plume = { host: "web" };
		assert.equal(onWeb(), true);
		assert.equal(available("agent", "prompt"), true);
		assert.equal(available("terminal", "open"), false);
		assert.equal(available("settings", "save"), false);
	} finally {
		delete scope.plume;
	}
});
