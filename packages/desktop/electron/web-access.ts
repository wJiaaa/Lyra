/**
 * Web access, owned here: built on first use, and kept in step with `settings.webAccess`.
 *
 * The settings are the only switch. Turning it on, changing the port and rotating the token are all
 * a settings write, and this follows the settings — so the IPC handlers, the settings page and the
 * app starting up with it already on are one path rather than three.
 *
 * Every start and stop goes through one queue. A settings write reaches here from the listener, and
 * the IPC handler that made the write then asks for the status; without the queue those two raced
 * — two binds of the same port, the second failing with `EADDRINUSE` about the service the first had
 * just started. Queued, the second finds it already serving what was asked for.
 */

import { randomUUID } from "node:crypto";
import type { SessionStorage, Settings } from "@plume/core";
import { workspaceInfo } from "./workspace-info.ts";
import { applySettings, onSettingsChanged, settings } from "./app-settings.ts";
import type { WebAccessStatus } from "./ipc-shapes.ts";
import {
	abortSession,
	createSession,
	deleteSessions,
	ensureLiveSession,
	disposeSession,
	editSessionMessage,
	promptSession,
	revertSessionMessage,
	sessions,
	snapshot,
	touchSession,
} from "./session-hub.ts";
import { WebServer } from "./web-server.ts";
import { listCommands } from "./commands-service.ts";
import { listReadableFiles, readReadableFile, resolveReadablePath } from "./file-read-service.ts";
import { generalScratchDir, scratchRoots } from "./scratch.ts";
import {
	sideChatAbort,
	sideChatAsk,
	sideChatClose,
	sideChatEditAndResend,
	sideChatReset,
	sideChatSetModel,
	sideChatState,
	tasksCancel,
	tasksDismiss,
	tasksList,
	tasksResume,
} from "./side-chat-service.ts";

let server: WebServer | null = null;
let queue: Promise<unknown> = Promise.resolve();
let readStore: () => SessionStorage = () => {
	throw new Error("web access used before configureWebAccess()");
};

/** The running server, or null. Read by the session hub to push events out. */
export function webServer(): WebServer | null {
	return server?.running ? server : null;
}

/** Run `work` after everything already queued, whatever became of it. */
function serial<T>(work: () => Promise<T>): Promise<T> {
	const next = queue.then(work, work);
	queue = next.catch(() => {});
	return next;
}

/** A browser may browse, and start conversations, only inside projects already opened here. */
function insideOpenProjects(target: string): Promise<string | null> {
	return resolveReadablePath(target, [...settings().projects.map((project) => project.path), ...scratchRoots()]);
}

function build(): WebServer {
	return new WebServer({
		store: readStore,
		settings,
		saveSettings: async (next) => void (await applySettings(next)),
		workspaceInfo: (path) => workspaceInfo(path),
		live: (id) => sessions.get(id),
		activate: ensureLiveSession,
		/*
		 * 浏览器只能在已经打开的项目里开会话。
		 *
		 * 白名单里没有 `terminal.*`，但如果能在机器上任何一个目录开一个会话再 `agent.prompt`，
		 * 那份能力就被等价地拿了回来，而且不受任何项目边界约束。所以 cwd 和 `files.list/read` 用同
		 * 一条判断（已打开的项目，加上草稿目录）：「浏览器看得见哪些地方」和「能在哪里开工」是同一个
		 * 答案。不在范围里就抛——一条说得出原因的错误，比一个在别处才炸的会话好。
		 */
		create: async (cwd, modelId, initial) => {
			const inside = await insideOpenProjects(cwd);
			if (!inside) throw new Error(`Web 访问只能在已打开的项目里新建会话，${cwd} 不在其中`);
			return createSession(inside, modelId, initial);
		},
		prompt: promptSession,
		editMessage: editSessionMessage,
		revertMessage: revertSessionMessage,
		abort: abortSession,
		dispose: disposeSession,
		remove: deleteSessions,
		snapshot: (session) => snapshot(session),
		touch: (id) => touchSession(id),
		sideChatState,
		sideChatSetModel,
		sideChatAsk,
		sideChatEditAndResend,
		sideChatAbort: async (id, sideId) => void sideChatAbort(id, sideId),
		sideChatReset,
		sideChatClose,
		tasksList: async (id) => tasksList(id),
		tasksCancel: async (id, taskId) => tasksCancel(id, taskId),
		tasksDismiss: async (id, taskId) => tasksDismiss(id, taskId),
		tasksResume: async (id, taskId) => tasksResume(id, taskId),
		commandsList: (cwd) => listCommands(cwd, settings()),
		filesList: async (dir) => listReadableFiles(await insideOpenProjects(dir)),
		filesRead: async (path) => readReadableFile(await insideOpenProjects(path), true),
		scratchRoots: async () => scratchRoots(),
		generalScratch: generalScratchDir,
	});
}

/** Bring the server in line with `next`: serving what it says, or stopped. */
function reconcile(next: Settings): Promise<WebAccessStatus> {
	return serial(async () => {
		const { enabled, port, token } = next.webAccess;
		if (!enabled || !token) {
			await server?.stop();
			return status();
		}
		server ??= build();
		return server.start(port, token);
	});
}

function status(): WebAccessStatus {
	return server?.status() ?? { running: false, port: settings().webAccess.port, urls: [], clients: 0, error: null };
}

/**
 * Wire it to the store and the settings, and start it if it was on when the app last closed.
 *
 * The listener is attached once and left: it does nothing while the feature is off, and settings
 * changes are what every connected browser has to hear about as well.
 */
export async function configureWebAccess(read: () => SessionStorage): Promise<void> {
	readStore = read;
	onSettingsChanged((next) => {
		server?.broadcastSettings(next);
		void reconcile(next);
	});
	/*
	 * Caught here and only here: a server that cannot start must not take the rest of the app's
	 * startup down with it. The settings page shows the failure the next time it asks.
	 */
	if (settings().webAccess.enabled) await reconcile(settings()).catch((error) => console.error("[web] start failed:", error));
}

/** Turn it on, with a token made now if there has never been one. */
export async function startWebAccess(): Promise<WebAccessStatus> {
	const current = settings();
	await applySettings({
		...current,
		webAccess: { ...current.webAccess, enabled: true, token: current.webAccess.token ?? newToken() },
	});
	return reconcile(settings());
}

export async function stopWebAccess(): Promise<WebAccessStatus> {
	const current = settings();
	await applySettings({ ...current, webAccess: { ...current.webAccess, enabled: false } });
	return reconcile(settings());
}

/** A new token: the restart that follows drops every browser holding the old one. */
export async function rotateWebAccessToken(): Promise<WebAccessStatus> {
	const current = settings();
	await applySettings({ ...current, webAccess: { ...current.webAccess, token: newToken() } });
	return reconcile(settings());
}

/** For quitting: close the port without touching the setting, so it comes back next launch. */
export function shutdownWebAccess(): Promise<void> {
	return serial(async () => {
		await server?.stop();
	});
}

function newToken(): string {
	return randomUUID().replace(/-/g, "");
}

/** Queried by the settings page while it is open. */
export function webAccessStatus(): Promise<WebAccessStatus> {
	// Behind the queue, so a status asked for mid-restart describes where the restart ended up.
	return serial(async () => status());
}
