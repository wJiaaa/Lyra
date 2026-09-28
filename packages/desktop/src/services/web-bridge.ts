/**
 * `window.lyra`, spoken over one WebSocket instead of over Electron IPC.
 *
 * Web access serves this same renderer to a browser. The renderer knows how to talk to exactly one
 * thing, `window.lyra`; in a window the preload builds it out of IPC channels, and here it is built
 * out of the contract's method table and a socket back to the desktop that served the page. Nothing
 * about the interface is duplicated, so nothing about it can drift.
 *
 * Installed as a side effect of the first import in `main.tsx`, because the very first thing the
 * app does is read this object. It does nothing in a window (the preload got there first) and
 * nothing outside a page served over http(s).
 *
 * Not the security boundary. The desktop refuses every method outside `WEB_METHODS`; this file
 * only avoids asking, so a call that slipped past `available()` gets a quiet null rather than a
 * round trip to be told no.
 */

import { METHODS, WEB_METHODS } from "@lyra/contract";
import { translate } from "../i18n/translate.ts";
import type { LyraApi } from "../../electron/ipc-types.ts";

/** How the link to the desktop stands. The store and the banner both listen for this. */
export type WebConnection = "connecting" | "connected" | "reconnecting";

/** The event carrying a `WebConnection` in `detail`, dispatched on `window`. */
export const CONNECTION_EVENT = "lyra:connection";

/** The parts of `WebSocket` this uses, so a test can hand in something else. */
export interface SocketLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export interface WebBridgeOptions {
	url: string;
	createSocket(url: string): SocketLike;
	/** The viewer's system — it decides which shortcut glyphs the page prints. */
	platform: string;
	/** Told every time the connection changes. */
	onConnection?(status: WebConnection): void;
	/** How long a call may go unanswered. */
	timeoutMs?: number;
	/** How often an idle socket is checked for a peer that went away without closing. */
	heartbeatMs?: number;
}

export interface WebBridge {
	api: LyraApi;
	status(): WebConnection;
	/** Check the socket now rather than at the next heartbeat. */
	probe(): void;
	/** Stop reconnecting and close the socket. For tests; a page simply goes away. */
	close(): void;
}

const OPEN = 1;
const MAX_BACKOFF_MS = 10_000;
/** How long a ping may go unanswered before the socket is treated as dead. */
const PROBE_MS = 5_000;

/*
 * Calls that only read. While the link is down these wait for it to come back; everything else is
 * refused at once, because a message or an approval that goes out a minute after it was clicked is
 * worse than one that visibly failed.
 */
const READS = new Set([
	"settings.get",
	"workspace.info",
	"sessions.list",
	"sessions.running",
	"sessions.open",
	"sessions.transcript",
	"sessions.trajectory",
	"sessions.trajectoryChanges",
	"sessions.capabilities",
	"sessions.contextBreakdown",
	"subAgents.list",
	"subAgents.detail",
	"sideChat.state",
	"tasks.list",
	"commands.list",
	"files.list",
	"files.read",
	"rules.preview",
	"git.generalScratch",
	"git.scratchRoots",
]);

/**
 * What an unavailable method answers: null, whatever it is called.
 *
 * The same answer the desktop gives for a refused method, so a caller sees one thing whichever side
 * said no. Not a guess at the shape from the name — `windows.list()` answers `{ sessions, panels }`,
 * and an empty array standing in for that put `sessions: undefined` into the store and took the
 * sidebar down. Callers that run in a browser skip what is not `available()` instead; null is
 * what the rest see.
 */
export function absentValue(): null {
	return null;
}

/** An `onSomething`: subscribed to, and what it returns is later called to unsubscribe. */
function isSubscription(name: string): boolean {
	return name.length > 2 && name.startsWith("on") && name[2] === name[2].toUpperCase();
}

/*
 * The floor under everything this file does not name.
 *
 * `LyraApi` carries more than the contract: synchronous helpers from the preload, window-only
 * events, facts like `systemVersion`. Writing each out means the browser breaks every time the
 * window gains one, and it breaks hard — a missing method is a TypeError inside a render. So an
 * unknown name is a callable Proxy: call it and it resolves to null, reach through it and you get
 * another, to any depth. `then` is left undefined so awaiting one does not hang.
 */
const floorGet = (_target: unknown, prop: string | symbol): unknown => {
	if (typeof prop === "symbol" || prop === "then") return undefined;
	return isSubscription(prop) ? () => () => {} : floorNode();
};
const floorNode = (): unknown => new Proxy(function () {}, { get: floorGet, apply: () => Promise.resolve(null) });
function withFloor<T extends object>(target: T): T {
	return new Proxy(target, { get: (object, prop) => (prop in object ? Reflect.get(object, prop) : floorGet(object, prop)) });
}

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	frame: string;
	sent: boolean;
}

export function createWebBridge(options: WebBridgeOptions): WebBridge {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const listeners = {
		agent: new Set<(payload: never) => void>(),
		sideChat: new Set<(payload: never) => void>(),
		sessions: new Set<(payload: never) => void>(),
		settings: new Set<(payload: never) => void>(),
	};

	let status: WebConnection = "connecting";
	let everConnected = false;
	let closed = false;
	let socket: SocketLike | null = null;
	let backoff = 500;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let probeTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
	const pending = new Map<string, Pending>();
	let nextId = 0;

	const report = (next: WebConnection) => {
		if (next === status) return;
		status = next;
		options.onConnection?.(next);
	};
	const linked = () => socket !== null && socket.readyState === OPEN && status === "connected";

	const clearProbe = () => {
		if (probeTimer !== null) clearTimeout(probeTimer);
		probeTimer = null;
	};

	/** In-flight calls cannot be answered by a socket that is gone: fail them, keep the queued ones. */
	const failSent = () => {
		for (const [id, entry] of pending) {
			if (!entry.sent) continue;
			pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new Error(translate("web.disconnected")));
		}
	};

	const flush = () => {
		if (!linked()) return;
		for (const entry of pending.values()) {
			if (entry.sent) continue;
			entry.sent = true;
			socket!.send(entry.frame);
		}
	};

	const scheduleReconnect = () => {
		if (closed || reconnectTimer !== null) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, backoff);
		backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
	};

	const dropped = (current: SocketLike) => {
		if (socket !== current) return;
		clearProbe();
		socket = null;
		failSent();
		report(everConnected ? "reconnecting" : "connecting");
		scheduleReconnect();
	};

	const onMessage = (raw: unknown) => {
		let message: { type?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown; sessionId?: unknown; sideId?: unknown; event?: unknown; change?: unknown; settings?: unknown };
		try {
			message = JSON.parse(String(raw)) as typeof message;
		} catch {
			return;
		}
		switch (message.type) {
			case "pong":
				clearProbe();
				return;
			case "rpc_result": {
				const entry = typeof message.id === "string" ? pending.get(message.id) : undefined;
				if (!entry) return;
				pending.delete(message.id as string);
				clearTimeout(entry.timer);
				if (message.ok) entry.resolve(message.value);
				// Refused is not failed: the honest answer about a method this host lacks is nothing.
				else if (message.error === "method-not-allowed") entry.resolve(null);
				else entry.reject(new Error(typeof message.error === "string" && message.error ? message.error : translate("web.callFailed")));
				return;
			}
			case "agent_event":
				for (const fn of listeners.agent) fn({ sessionId: message.sessionId, event: message.event } as never);
				return;
			case "side_chat_event":
				for (const fn of listeners.sideChat) fn({ sessionId: message.sessionId, sideId: message.sideId, event: message.event } as never);
				return;
			case "session_changed":
				for (const fn of listeners.sessions) fn(message.change as never);
				return;
			case "settings_changed":
				for (const fn of listeners.settings) fn(message.settings as never);
				return;
		}
	};

	function connect(): void {
		if (closed || socket) return;
		report(everConnected ? "reconnecting" : "connecting");
		let current: SocketLike;
		try {
			current = options.createSocket(options.url);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = current;
		current.onopen = () => {
			if (socket !== current) return;
			everConnected = true;
			backoff = 500;
			report("connected");
			flush();
		};
		current.onmessage = (event) => {
			if (socket === current) onMessage(event.data);
		};
		current.onclose = () => dropped(current);
		current.onerror = () => {
			if (socket === current) current.close();
		};
	}

	/**
	 * Check that an open socket still has someone on the other end.
	 *
	 * A laptop that slept, a desktop that quit without closing: either can leave a socket that says
	 * OPEN and will never deliver anything again. A ping that goes unanswered is the only way to
	 * find out, and finding out is what lets the reconnect start.
	 */
	const probe = () => {
		if (!socket) {
			connect();
			return;
		}
		if (probeTimer !== null || socket.readyState !== OPEN) return;
		const current = socket;
		probeTimer = setTimeout(() => {
			probeTimer = null;
			if (socket !== current) return;
			current.close();
			dropped(current);
		}, PROBE_MS);
		current.send(JSON.stringify({ type: "ping" }));
	};
	const heartbeat = () => {
		heartbeatTimer = setTimeout(() => {
			probe();
			heartbeat();
		}, heartbeatMs);
	};

	const rpc = (method: string, args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			if (everConnected && !linked() && !READS.has(method)) {
				reject(new Error(translate("web.disconnected")));
				return;
			}
			const id = `r${++nextId}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(translate("web.noResponse")));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer, frame: JSON.stringify({ type: "rpc", id, method, args }), sent: false });
			flush();
		});

	const call = (name: string, method: string) => {
		const path = `${name}.${method}`;
		if (!WEB_METHODS.has(path)) return () => Promise.resolve(absentValue());
		return (...args: unknown[]) => rpc(path, args);
	};
	const subscribe = (set: Set<(payload: never) => void>) => (handler: (payload: never) => void) => {
		set.add(handler);
		return () => void set.delete(handler);
	};

	const groups: Record<string, Record<string, unknown>> = {};
	for (const [group, methods] of Object.entries(METHODS)) {
		groups[group] = {};
		for (const method of Object.keys(methods)) groups[group][method] = call(group, method);
	}
	groups.agent.onEvent = subscribe(listeners.agent);
	groups.sideChat.onEvent = subscribe(listeners.sideChat);
	groups.sessions.onChanged = subscribe(listeners.sessions);
	groups.settings.onChanged = subscribe(listeners.settings);
	// Synchronous helpers from the preload that return a string. There is no local file behind a
	// page in a browser, so there is no URL for one and no path for a dropped file.
	groups.files.mediaUrl = () => "";
	// Absent rather than floored: `picked.ts` asks whether it is a function, and the floor is one —
	// whose promise would then be taken for a dropped file's path.
	groups.files.pathForDrop = undefined;
	/*
	 * The viewer's machine, not the desktop's.
	 *
	 * These are contract methods, and sent over the socket they would do their work on the machine
	 * that served the page: a copied path would land on the desktop's clipboard, a link would open
	 * in a browser nobody is looking at. Answered here instead, by the page's own browser.
	 */
	groups.clipboard.write = (text: string) => writeClipboard(String(text));
	groups.clipboard.read = () => readClipboard();
	groups.system.openExternal = (url: string) => {
		window.open(String(url), "_blank", "noopener,noreferrer");
		return Promise.resolve();
	};

	const root: Record<string, unknown> = {
		platform: options.platform,
		host: "web",
		bootWindow: { id: "primary", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
	};
	for (const [group, members] of Object.entries(groups)) root[group] = withFloor(members);

	connect();
	heartbeat();

	return {
		api: withFloor(root) as unknown as LyraApi,
		status: () => status,
		probe,
		close() {
			closed = true;
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
			clearProbe();
			const current = socket;
			socket = null;
			current?.close();
			for (const entry of pending.values()) clearTimeout(entry.timer);
			pending.clear();
		},
	};
}

/**
 * Put text on the viewer's clipboard.
 *
 * `navigator.clipboard` exists only in a secure context, and a page served over plain http from an
 * address on the local network is not one — which is the ordinary way this page is opened. So the
 * old route is the fallback: a hidden field, selected, and the copy command.
 */
async function writeClipboard(text: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	field.style.position = "fixed";
	field.style.opacity = "0";
	document.body.append(field);
	field.select();
	try {
		document.execCommand("copy");
	} finally {
		field.remove();
	}
}

/** Read the viewer's clipboard — empty where the browser will not allow it, which is most places over http. */
async function readClipboard(): Promise<string> {
	if (typeof navigator === "undefined" || !navigator.clipboard || !window.isSecureContext) return "";
	try {
		return await navigator.clipboard.readText();
	} catch {
		return "";
	}
}

/** The viewer's system, as `process.platform` would spell it. */
export function browserPlatform(userAgent: string): string {
	if (/Mac|iPhone|iPad|iPod/i.test(userAgent)) return "darwin";
	if (/Win/i.test(userAgent)) return "win32";
	return "linux";
}

let installed: WebBridge | null = null;

/** Where the link stands, or null in a window, where there is no link to speak of. */
export function webConnection(): WebConnection | null {
	return installed?.status() ?? null;
}

/**
 * Build `window.lyra` for a page that has none.
 *
 * Only in a browser, only over http(s), and only when nothing got there first — in an Electron
 * window the preload runs before any script, so its object is already there, including in
 * development where the window loads the renderer over http from Vite.
 */
function installWebBridge(): void {
	if (typeof window === "undefined" || typeof location === "undefined" || typeof WebSocket === "undefined") return;
	const scope = window as unknown as { lyra?: LyraApi };
	if (scope.lyra || !/^https?:$/.test(location.protocol)) return;
	installed = createWebBridge({
		url: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
		createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
		platform: browserPlatform(navigator.userAgent),
		onConnection: (status) => window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: status })),
	});
	scope.lyra = installed.api;
	// A tab back from the background, or a machine back on the network, checks its socket at once
	// rather than at the next beat.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") installed?.probe();
	});
	window.addEventListener("online", () => installed?.probe());
}

installWebBridge();
