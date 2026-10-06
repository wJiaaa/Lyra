/**
 * The live sessions, and how their events get out.
 *
 * A session is expensive: it owns MCP servers as real child processes and a visible browser tabs. So
 * this is also where they are kept to a bounded number and evicted by recency — an afternoon of
 * moving between conversations should not leave a dozen sets of processes running.
 *
 * Everything the rest of the main process needs from a session goes through here, which is what
 * keeps the map from being reachable — and therefore mutable — from six different files.
 */

import { AgentSession, backgroundJobs, plumeHome, removeSessionArtifacts, type AgentEvent, type SessionStorage, type Settings, type SideChat } from "@plume/core";
import type { BrowserWindow } from "electron";
import { browserState, closeSessionBrowser } from "./browser-workspace.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { autoCreateSessionWorktree, cleanOldWorktrees } from "./git-worktrees.ts";
import type { SessionChange } from "./ipc-shapes.ts";
import type { SessionSnapshot, PlumeApi } from "./ipc-types.ts";
import { createStoredSession, type InitialPrompt } from "./create-session.ts";
import { initialPrompt, promptContent, promptOptions } from "./prompt-input.ts";
import { ensureSessionWorkspace } from "./scratch.ts";
import { discardSideChat } from "./sidechat-discard.ts";
import { listSideChats, removeSideChats } from "./sidechat-store.ts";
import { notifyAgentEvent } from "./notify.ts";
import { slimSnapshot } from "./display-transcript.ts";
import { eachAppWindow } from "./window.ts";

export interface HubDeps {
	store(): SessionStorage;
	settings(): Settings;
	window(): BrowserWindow | null;
}

let deps: HubDeps = {
	store: () => {
		throw new Error("session hub used before configure()");
	},
	settings: () => {
		throw new Error("session hub used before configure()");
	},
	window: () => null,
};

export function configureHub(next: HubDeps): void {
	deps = next;
}

export const sessions = new Map<string, AgentSession>();
const ready = new Set<string>();
const submitted = new Set<string>();
const initializing = new Map<string, Promise<AgentSession | null>>();
const retiring = new Set<string>();
const abortedWhileStarting = new Set<string>();
/** Chosen for deletion and not gone yet: nothing new may start on them. See `deleteIdleSessions`. */
const deleting = new Set<string>();

export async function createSession(cwd: string, modelId: string, initial?: InitialPrompt): Promise<SessionSnapshot> {
	const saved = await createStoredSession(deps.store(), deps.settings(), cwd, modelId, initialPrompt(initial));
	stageSession(saved);
	if (initial) submitted.add(saved.meta.id);
	return saved;
}

function stageSession(saved: SessionSnapshot): AgentSession {
	const browser = createBrowserTools();
	const session = new AgentSession({ cwd: saved.meta.cwd, settings: deps.settings(), store: deps.store(), meta: saved.meta,
		extraTools: browser.tools, emit: (event) => broadcast(saved.meta.id, event) });
	session.restore(saved.messages);
	sessions.set(saved.meta.id, session);
	browsers.set(saved.meta.id, browser.dispose);
	return session;
}

export const promptSession: PlumeApi["agent"]["prompt"] = async (id, content, options) => {
	const release = holdSessionOperation(id);
	let handedOff = false;
	try {
		const input = promptContent(content);
		const requested = promptOptions(options);
		const session = await ensureLiveSession(id);
		if (!session) throw new Error(`Session ${id} is not open.`);
		// Both transports return after activation; a multi-minute turn is delivered by events.
		const turn = requested.resumePending ? session.resumePendingPrompt() : session.prompt(input, requested);
		handedOff = true;
		void turn.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			broadcast(id, { type: "notice", level: "error", message });
			broadcast(id, { type: "agent_end", reason: "error", error: message });
		}).finally(release);
		return session.meta;
	} finally {
		submitted.delete(id);
		if (!handedOff) release();
	}
};
/** Disposers for each session's browser tools, keyed the same way. */
export const browsers = new Map<string, () => void>();
/**
 * Side chats, built on first use and dropped with the session.
 *
 * 一个会话可以同时开好几个，里面一层按侧边聊天的 id 分——见 `@plume/contract` 的 `DEFAULT_SIDE_CHAT_ID`。
 * 一个都没有的会话不留空的那一层：回收会话时按「这里有没有它」判断它旁边是不是还有对话。
 */
export const sideChats = new Map<string, Map<string, SideChat>>();

export function liveSideChat(sessionId: string, sideId: string): SideChat | undefined {
	return sideChats.get(sessionId)?.get(sideId);
}

/** Session operations admitted before their first await, so cleanup cannot race their startup. */
const sessionOperationHolds = new Map<string, number>();

function holdSessionOperation(sessionId: string): () => void {
	sessionOperationHolds.set(sessionId, (sessionOperationHolds.get(sessionId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (sessionOperationHolds.get(sessionId) ?? 1) - 1;
		if (left > 0) sessionOperationHolds.set(sessionId, left);
		else sessionOperationHolds.delete(sessionId);
	};
}

/**
 * Count the session as in use while a side chat on it opens; call what this returns once it is in place or failed.
 *
 * Taken before the first await. A clear by date that ran while the archive was read found nothing
 * in flight and deleted the conversation being opened.
 */
export function holdForSideChat(sessionId: string): () => void {
	return holdSessionOperation(sessionId);
}

/**
 * Put an opened side chat in place; false when `main` was stopped or deleted while it opened.
 * Installed anyway, it would outlive `disposeSession`'s sweep and keep saving an archive for a conversation that is gone.
 */
export function installSideChat(sessionId: string, main: AgentSession, sideId: string, chat: SideChat): boolean {
	if (sessions.get(sessionId) !== main || retiring.has(sessionId) || deleting.has(sessionId)) return false;
	const chats = sideChats.get(sessionId) ?? new Map<string, SideChat>();
	chats.set(sideId, chat);
	sideChats.set(sessionId, chats);
	return true;
}

/** 这个会话旁边有哪些侧边聊天：有存档的，加上这次开着、还没来得及存下东西的。 */
async function sideChatIds(sessionId: string): Promise<string[]> {
	const ids = new Set(await listSideChats(sessionId));
	for (const id of sideChats.get(sessionId)?.keys() ?? []) ids.add(id);
	return Array.from(ids);
}


export async function editSessionMessage(
	sessionId: string,
	index: number,
	content: Parameters<PlumeApi["agent"]["editMessage"]>[2],
	options: Parameters<PlumeApi["agent"]["editMessage"]>[3] = {},
): Promise<void> {
	const release = holdSessionOperation(sessionId);
	try {
		const session = await ensureLiveSession(sessionId);
		if (!session) throw new Error("找不到这个会话。");
		if (session.running) throw new Error("请先停止当前回复，再编辑消息。");
		// Acknowledge submission immediately; the rerun and any failure arrive on the shared stream.
		void session.editAndResend(index, content, options).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			broadcast(sessionId, { type: "notice", level: "error", message });
			broadcast(sessionId, { type: "agent_end", reason: "error", error: message });
		}).finally(release);
	} catch (error) {
		release();
		throw error;
	}
}

export async function revertSessionMessage(sessionId: string, index: number): Promise<void> {
	const release = holdSessionOperation(sessionId);
	try {
		const session = await ensureLiveSession(sessionId);
		if (!session) throw new Error("找不到这个会话。");
		if (session.running) throw new Error("回合进行中，无法撤销");
		await session.revert(index);
		// 整个撤空的话，旁边那几场对话就没有了依附的对象，跟着一起收掉——见 `sidechat-discard.ts`。
		if (session.messages.length > 0) return;
		for (const sideId of await sideChatIds(sessionId)) {
			await discardSideChat(sessionId, sideId, {
				mainMessagesLeft: session.messages.length,
				live: liveSideChat(sessionId, sideId),
				defaultModelId: deps.settings().sideChatModelId || null,
				broadcast: (event) => broadcastSideChat(sessionId, sideId, event),
			});
		}
	} finally {
		release();
	}
}

export function broadcastSessionChange(change: SessionChange): void {
	eachAppWindow((win) => win.webContents.send("sessions:changed", change));
}

export function broadcast(sessionId: string, event: AgentEvent): void {
	eachAppWindow((win) => win.webContents.send("agent:event", { sessionId, event }));
	notifyAgentEvent(sessionId, event, sessions.get(sessionId)?.meta.title);
}

/**
 * Side-chat events have their own channel so they cannot enter the main thread.
 */
export function broadcastSideChat(sessionId: string, sideId: string, event: import("@plume/core").SideChatUpdate): void {
	eachAppWindow((win) => win.webContents.send("sidechat:event", { sessionId, sideId, event }));
}

export async function getOrCreateSession(cwd: string, _modelId: string): Promise<AgentSession> {
	// A project-less conversation runs in a directory under the app's home, and that directory can
	// be gone — swept by a version of this app that used to, or removed by hand. Put it back before
	// a session is built around a working directory that is not there.
	await ensureSessionWorkspace(cwd).catch(() => false);

	const appSettings = deps.settings();
	// Generate a temporary session id prefix for potential worktree naming
	const tempId = Math.random().toString(36).slice(2, 10);
	const worktreeResult = await autoCreateSessionWorktree(cwd, appSettings, tempId).catch(() => ({
		cwd,
		worktreeCreated: false,
	}));
	const sessionCwd = worktreeResult.cwd;

	const browser = createBrowserTools();
	// `emit` closes over `session`, which is only ever invoked after `initialize()` has
	// assigned `meta`, so the self-reference is safe — but it needs an explicit type.
	const session: AgentSession = new AgentSession({
		cwd: sessionCwd,
		settings: appSettings,
		store: deps.store(),
		extraTools: browser.tools,
		emit: (event: AgentEvent) => broadcast(session.meta.id, event),
	});
	await session.initialize();
	sessions.set(session.meta.id, session);
	ready.add(session.meta.id);
	browsers.set(session.meta.id, browser.dispose);

	// Trigger async cleanup if enabled in settings
	if (appSettings.worktrees?.autoCleanOld) {
		const liveCwds = new Set(Array.from(sessions.values()).map((s) => s.cwd));
		void cleanOldWorktrees(cwd, appSettings, liveCwds).catch(() => {});
	}

	return session;
}

/**
 * How many sessions stay warm.
 *
 * Each one owns its MCP servers — real child processes — plus a visible browser tabs, so an
 * unbounded map meant an afternoon of browsing left a dozen sets of them running. Three keeps
 * the conversations you are actually moving between instant without hoarding processes.
 */
const MAX_LIVE_SESSIONS = 8;

/** Move a session to the end of the map, which is the recency order eviction walks. */
export function touchSession(sessionId: string): void {
	const session = sessions.get(sessionId);
	if (!session) return;
	sessions.delete(sessionId);
	sessions.set(sessionId, session);
}

export async function snapshot(session: AgentSession): Promise<SessionSnapshot> {
	return slimSnapshot({
		meta: session.meta,
		messages: session.messages,
		/*
		 * The same field the stored read returns, so a session being read live is not missing
		 * something a session read from disk has.
		 *
		 * Leaving it out did not break anything — the window defaults it to an empty list — it just
		 * quietly dropped every compaction mark for as long as the session was running, and put them
		 * all back the moment it stopped. A turn long enough to summarise its own history is exactly
		 * the one where those marks are worth drawing.
		 */
		compactions: session.log.compactions,
		commandRuns: session.log.commandRuns,
		hookRuns: session.log.hookRuns,
		running: session.running || submitted.has(session.meta.id),
		pendingApprovals: session.listPendingApprovals().map(({ id, request, expiresAt }) => ({
			id,
			...request,
			// A question reopened from a snapshot still has a deadline, and still has to show it.
			expiresAt,
		})),
	});
}

/** Tear down a live session's agent, MCP servers and browser. Safe to call for unknown ids. */
export async function disposeSession(sessionId: string): Promise<void> {
	retiring.add(sessionId);
	submitted.delete(sessionId);
	try { await initializing.get(sessionId); } catch { /* Failed initialization still owns resources to release. */ }
	await sessions.get(sessionId)?.dispose();
	closeSessionBrowser(sessionId);
	browsers.get(sessionId)?.();
	browsers.delete(sessionId);
	// A side chat reads its session's live message list; without the session it has nothing
	// to read, so it goes at the same time.
	for (const chat of sideChats.get(sessionId)?.values() ?? []) chat.reset();
	sideChats.delete(sessionId);
	sessions.delete(sessionId);
	ready.delete(sessionId);
	retiring.delete(sessionId);
}

/**
 * The live session for an id, activating it from disk if it is not warm yet.
 *
 * The one entry point for "I need to actually run something on this conversation" — as opposed to
 * reading it, which must never come through here.
 */
export async function ensureLiveSession(sessionId: string): Promise<AgentSession | null> {
	if (retiring.has(sessionId) || deleting.has(sessionId)) return null;
	const pending = initializing.get(sessionId);
	if (pending) return pending;
	const existing = sessions.get(sessionId);
	if (existing && ready.has(sessionId)) {
		touchSession(sessionId);
		return existing;
	}
	const starting = startStoredSession(sessionId);
	initializing.set(sessionId, starting);
	try { return await starting; }
	finally { initializing.delete(sessionId); abortedWhileStarting.delete(sessionId); }
}

async function startStoredSession(sessionId: string): Promise<AgentSession | null> {
	const store = deps.store();
	let session = sessions.get(sessionId);
	if (!session) {
		const loaded = await store.load(sessionId);
		if (!loaded || retiring.has(sessionId)) return null;
		session = stageSession({ meta: loaded.meta, messages: loaded.messages, running: false, pendingApprovals: [] });
		session.restore(loaded.messages, loaded.compaction, loaded.compactions);
		session.log.commandRuns = loaded.commandRuns ?? [];
		session.log.hookRuns = loaded.hookRuns ?? [];
	}
	try {
		await ensureSessionWorkspace(session.cwd);
		if (session.meta.workspaceSetup === "worktree") {
			const prepared = await autoCreateSessionWorktree(session.cwd, deps.settings(), sessionId);
			session.cwd = prepared.cwd;
			// Execution may move; project identity and all metadata edits remain on the same log.
			await session.log.append({ type: "meta", meta: { ...session.meta, cwd: prepared.cwd, workspaceSetup: undefined } });
		}
		if (retiring.has(sessionId)) return null;
		await session.initialize();
		ready.add(sessionId);
		if (abortedWhileStarting.has(sessionId)) await session.cancelPendingPrompt();
		if (retiring.has(sessionId)) return null;
		await evictStaleSessions(sessionId);
		return session;
	} catch (cause) {
		await session.dispose();
		closeSessionBrowser(sessionId);
	browsers.get(sessionId)?.();
		ready.delete(sessionId);
		sessions.delete(sessionId); browsers.delete(sessionId);
		throw cause;
	}
}

export async function abortSession(sessionId: string): Promise<void> {
	submitted.delete(sessionId);
	if (initializing.has(sessionId)) abortedWhileStarting.add(sessionId);
	const session = sessions.get(sessionId);
	if (session) {
		session.abort();
		if (!session.meta.pendingPrompt) return;
		await session.cancelPendingPrompt();
	} else {
		const store = deps.store();
		const meta = (await store.listSessions()).find((meta) => meta.id === sessionId);
		if (!meta?.pendingPrompt) return;
		await store.append(meta, { type: "meta", meta: { ...meta, pendingPrompt: undefined } });
	}
	broadcast(sessionId, { type: "agent_end", reason: "aborted" });
}

/**
 * Something is still going to write to this session: a turn, an admitted operation, a session
 * still starting, a side chat answering, or background work.
 */
function sessionBusy(id: string): boolean {
	if (submitted.has(id) || initializing.has(id) || sessionOperationHolds.has(id)) return true;
	const session = sessions.get(id);
	if (!session) return false;
	if (session.running || session.meta.pendingPrompt) return true;
	if (Array.from(sideChats.get(id)?.values() ?? []).some((chat) => chat.running)) return true;
	if (backgroundJobs(session.can.state).list().some((job) => job.status === "running" || job.status === "stopping")) return true;
	/*
	 * 主会话已经收尾、子代理还在后台跑的，也是一场进行中的对话。
	 *
	 * 人在主会话等子代理时插了话，主会话回应完就收尾了（`running` 为假），子代理留在后台接着跑，
	 * 跑完结果会送回来（ADR-0029）。按「没在跑」把它回收掉，等于把那几个子代理连同它们要送回来
	 * 的结果一起扔了——而人只是去别的对话看了一眼。
	 */
	return session.subAgents.list().some((one) => one.status === "running" || one.status === "queued");
}

/**
 * Stop these sessions and delete them, with what they wrote outside the project: previews, scratch
 * files, change snapshots, side chats. Every way a session is deleted comes through here, so this
 * is the one place that cleanup is remembered.
 *
 * Marked before anything is awaited and unmarked only once the rows are gone: in between,
 * `ensureLiveSession` answers null, so a prompt sent meanwhile is refused
 * instead of starting on a conversation about to vanish.
 */
export async function deleteSessions(ids: string[]): Promise<void> {
	for (const id of ids) deleting.add(id);
	try {
		await Promise.all(ids.map((id) => disposeSession(id)));
		await deps.store().deleteMany(ids);
		// The rows are the conversation; what is left is litter, and failing to sweep it is no reason to report the delete as failed.
		await Promise.all(ids.flatMap((id) => [removeSessionArtifacts(plumeHome(), id), removeSideChats(id)].map((done) => done.catch(() => {}))));
	} finally {
		for (const id of ids) deleting.delete(id);
	}
}

/** As `deleteSessions`, for those of `ids` with nothing in flight; answers which. A clear by date must not stop work. */
export async function deleteIdleSessions(ids: string[]): Promise<string[]> {
	const idle = ids.filter((id) => !sessionBusy(id));
	await deleteSessions(idle);
	return idle;
}

/** Retire the least recently used sessions, never one mid-turn and never the current one. */
async function evictStaleSessions(keep: string): Promise<void> {
	// Snapshotted with `entries()`, not spread: this loop deletes from the map as it goes.
	for (const [id] of Array.from(sessions.entries())) {
		if (sessions.size <= MAX_LIVE_SESSIONS) break;
		// An open side chat is a conversation in progress, same as a running turn — evicting
		// its session would silently throw that conversation away.
		if (id === keep || sessionBusy(id) || sideChats.has(id)) continue;
		if (browserState().tabs.some((tab) => tab.sessionId === id)) continue;
		await disposeSession(id);
	}
}
