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

import { AgentSession, backgroundJobs, plumeHome, removeSessionArtifacts, type AgentEvent, type SessionEndReason, type SessionMeta, type SessionStorage, type Settings } from "@plume/core";
import type { BrowserWindow } from "electron";
import { browserState, closeSessionBrowser } from "./browser-workspace.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { autoCreateSessionWorktree, cleanOldWorktrees } from "./git-worktrees.ts";
import type { SessionChange } from "./ipc-shapes.ts";
import type { SessionSnapshot, PlumeApi } from "./ipc-types.ts";
import { createStoredSession, type InitialPrompt } from "./create-session.ts";
import { initialPrompt, promptContent, promptOptions } from "./prompt-input.ts";
import { ensureSessionWorkspace, ownWorkspace } from "./scratch.ts";
import { removeSummary, summarize, summarizeAfterTurn, type SummaryUpdate } from "./session-summary.ts";
import { nativeText } from "./i18n.ts";
import { notifyAgentEvent } from "./notify.ts";
import { slimSnapshot } from "./display-transcript.ts";
import { noteTranscriptFiles } from "./attachment-reads.ts";
import { eachAppWindow } from "./window.ts";
import { createPeerRouter } from "./session-peers.ts";
import { createPeerTools } from "./peer-tools.ts";
import { archiveAfterTurn, createSessionOpsTools } from "./session-ops.ts";
import { bringBackWorktree, reclaimWorktree } from "./worktree-lifecycle.ts";

export interface HubDeps {
	store(): SessionStorage;
	settings(): Settings;
	window(): BrowserWindow | null;
	remoteEvent?(event: import("@plume/client-runtime").RemoteEvent): void;
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

/**
 * 会话之间的消息。只认已经起来、没在退场的：还在初始化的那个没有工具也没有项目层，正在删的
 * 那个收了消息也没人读。
 */
const peers = createPeerRouter({
	// 侧边聊天不是能单独来往的对话：它是父会话的一部分，`list_sessions` 里不该出现。
	live: () => Array.from(sessions.entries())
		.filter(([id, session]) => !session.parent && ready.has(id) && !retiring.has(id) && !deleting.has(id))
		.map(([, session]) => session),
	settings: () => deps.settings(),
});
/** 每个会话都有的那三件工具；状态全在 `peers` 里，所以一份就够。 */
const peerTools = createPeerTools(peers);

/** 要求归档自己的会话，在那一轮结束后归档——见 `session-ops.ts`。 */
const archives = archiveAfterTurn({
	archive: async (id) => {
		const meta = await deps.store().setArchived(id, true);
		if (meta) await worktreeFollowsArchive(meta);
	},
	busy: (id) => sessions.get(id)?.running ?? false,
	archived: async (id) => (await deps.store().listSessions()).some((one) => one.id === id && one.archived === true),
	dispose: (id) => disposeSession(id, "archived"),
});
/** 环境卡片里那段摘要：一轮结束、静下来一分钟后在后台生成，推给开着的窗口。 */
const summaries = summarizeAfterTurn({
	busy: (id) => sessions.get(id)?.running ?? false,
	run: async (id) => {
		const publish = (update: SummaryUpdate) => eachAppWindow((win) => win.webContents.send("sessions:summaryChanged", update));
		publish({ sessionId: id, pending: true });
		try {
			publish({ sessionId: id, pending: false, ...(await summarize(id, { store: deps.store(), settings: deps.settings(), liveMessages: sessions.get(id)?.messages })) });
		} catch (error) {
			publish({ sessionId: id, pending: false, error: String(error) });
			throw error;
		}
	},
});
/** 和 `peerTools` 一样每个会话共用一份：工具本身不带状态，是谁调的看 `ctx.sessionId`。 */
const sessionOps = createSessionOpsTools({ archiveAfterTurn: (id) => archives.request(id) });

export async function createSession(cwd: string, modelId: string, initial?: InitialPrompt): Promise<SessionSnapshot> {
	// 「不在项目中工作」 arrives as the shared `general`; each conversation runs in a directory of its own.
	const saved = await createStoredSession(deps.store(), deps.settings(), await ownWorkspace(cwd), modelId, initialPrompt(initial));
	stageSession(saved);
	if (initial) submitted.add(saved.meta.id);
	return saved;
}

function stageSession(saved: SessionSnapshot, parent?: AgentSession): AgentSession {
	/*
	 * 侧边聊天不带浏览器和会话间通信：网页是父会话那一屏的，来往的信也该写给父会话。它要的那三件
	 * 由 core 按 `parent` 加上。
	 */
	if (parent) {
		const side = new AgentSession({ cwd: saved.meta.cwd, settings: deps.settings(), store: deps.store(), meta: saved.meta, parent, emit: (event) => broadcast(saved.meta.id, event) });
		side.restore(saved.messages);
		sessions.set(saved.meta.id, side);
		return side;
	}
	const browser = createBrowserTools();
	const session = new AgentSession({ cwd: saved.meta.cwd, settings: deps.settings(), store: deps.store(), meta: saved.meta,
		extraTools: [...browser.tools, ...peerTools, ...sessionOps], emit: (event) => broadcast(saved.meta.id, event), compactWhenIdle: true, suggestNextPrompt: true });
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
		peers.personSpoke(id);
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

/** 父会话旁边的侧边聊天，按存储里的记录：没起来的也算。 */
export async function sideSessionsOf(parentIds: string[]): Promise<SessionMeta[]> {
	const parents = new Set(parentIds);
	return (await deps.store().listSessions({ children: true })).filter((meta) => meta.parentId !== undefined && parents.has(meta.parentId));
}

/** 起着的那些。回收、处置父会话时要先管它们。 */
function liveSides(parentId: string): AgentSession[] {
	return Array.from(sessions.values()).filter((session) => session.parent?.meta.id === parentId);
}

const opening = new Map<string, Promise<SessionMeta>>();

/**
 * 面板上那一格对应的会话，没有就建一个。
 *
 * 面板按「父会话 + 自己的 id」认它，和会话 id 无关；会话到第一次提问时才建，所以开着不问的那一格
 * 不留空会话。同一格同时开两次（连点、两个窗口）拿到的是同一个。
 */
export function openSideSession(parentId: string, sideId: string): Promise<SessionMeta> {
	const key = `${parentId}/${sideId}`;
	const pending = opening.get(key);
	if (pending) return pending;
	const operation = (async () => {
		// 建的这一下父会话算在忙：「按时间清理」不能恰好在这时把人正在开口的那条对话删掉。
		const release = holdSessionOperation(parentId);
		try {
			const existing = (await sideSessionsOf([parentId])).find((meta) => meta.sideId === sideId);
			if (existing) return existing;
			const parent = await deps.store().get(parentId);
			if (!parent || parent.parentId || deleting.has(parentId)) throw new Error(nativeText("sessions.sideParentGone"));
			const settings = deps.settings();
			// 模型留空就是跟着父会话；设置里给了侧边聊天默认模型才用它。见 `AgentSession.modelIdInEffect`。
			const meta = await deps.store().create(sessions.get(parentId)?.cwd ?? parent.cwd, settings.sideChatModelId || "", "", { parentId, sideId });
			// 建的过程中父会话被点名删了：删除时它还不在，没被一起带走，这里补上，不留一个挂在空处的会话。
			if (deleting.has(parentId) || !(await deps.store().get(parentId))) {
				await deps.store().deleteMany([meta.id]);
				throw new Error(nativeText("sessions.sideParentGone"));
			}
			return meta;
		} finally {
			release();
		}
	})();
	opening.set(key, operation);
	void operation.finally(() => opening.delete(key)).catch(() => {});
	return operation;
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
		// 整个撤空的话，旁边那几场对话就没有了依附的对象，跟着一起收掉。面板留着，下一问是新的一段。
		if (session.messages.length > 0) return;
		await deleteSessions((await sideSessionsOf([sessionId])).map((meta) => meta.id));
	} finally {
		release();
	}
}

export function broadcastSessionChange(change: SessionChange): void {
	// 手机上没有侧边聊天面板，侧边聊天会话推过去只会出现在它的会话列表里。
	if (!change.meta?.parentId) deps.remoteEvent?.({ type: "session_changed", change });
	eachAppWindow((win) => win.webContents.send("sessions:changed", change));
}

export function broadcast(sessionId: string, event: AgentEvent): void {
	peers.observe(sessionId, event);
	// 侧边聊天是开着面板、人正看着问的，不发系统通知；手机端也不认识这种会话。
	const side = Boolean(sessions.get(sessionId)?.parent);
	if (!side) deps.remoteEvent?.({ type: "agent_event", sessionId, event });
	// 侧边聊天没有环境卡片，也就没有摘要。
	if (!side) summaries.observe(sessionId, event);
	// 活会话的回复不经过快照：这一轮刚交付、链着验证截图的那条，正是人马上要点的。
	if (event.type === "message_end") noteTranscriptFiles([event.message]);
	eachAppWindow((win) => win.webContents.send("agent:event", { sessionId, event }));
	const meta = sessions.get(sessionId)?.meta;
	if (!side) notifyAgentEvent(sessionId, event, meta?.title);
	// After the windows have the event: they hear the turn end before they hear it was archived.
	archives.observe(sessionId, event);
}

export async function getOrCreateSession(cwd: string, _modelId: string): Promise<AgentSession> {
	// A project-less conversation runs in a directory under the app's home, and that directory can
	// be gone — swept by a version of this app that used to, or removed by hand. Put it back before
	// a session is built around a working directory that is not there.
	await ensureSessionWorkspace(cwd).catch(() => false);

	const appSettings = deps.settings();
	// Generate a temporary session id prefix for potential worktree naming
	const tempId = Math.random().toString(36).slice(2, 10);
	/*
	 * A scheduled run has no composer to choose in, so the setting decides. Asked here rather than in
	 * `autoCreateSessionWorktree`, which only makes what it is asked for: a conversation's own choice
	 * reaches it through `workspaceSetup`, and must not be overruled by the setting on the way.
	 */
	const worktreeResult: { cwd: string; worktreeCreated: boolean; branch?: string; base?: string } = appSettings.worktrees?.autoCreateOnNewSession
		? await autoCreateSessionWorktree(cwd, appSettings, tempId).catch(() => ({ cwd, worktreeCreated: false }))
		: { cwd, worktreeCreated: false };
	const sessionCwd = worktreeResult.cwd;

	const browser = createBrowserTools();
	// `emit` closes over `session`, which is only ever invoked after `initialize()` has
	// assigned `meta`, so the self-reference is safe — but it needs an explicit type.
	const session: AgentSession = new AgentSession({
		cwd: sessionCwd,
		settings: appSettings,
		store: deps.store(),
		extraTools: [...browser.tools, ...peerTools, ...sessionOps],
		emit: (event: AgentEvent) => broadcast(session.meta.id, event),
		// 一轮收尾、缓存还热时先压掉越线的历史；侧边聊天和命令行不开，见 `AgentSessionOptions.compactWhenIdle`。
		compactWhenIdle: true,
		suggestNextPrompt: true,
	});
	await session.initialize();
	// Filed under the project it ran for, not under a folder of its own (`SessionMeta.worktree`).
	if (worktreeResult.worktreeCreated && worktreeResult.branch) {
		await session.log.append({ type: "meta", meta: { ...session.meta, worktree: { project: cwd, branch: worktreeResult.branch, ...(worktreeResult.base ? { base: worktreeResult.base } : {}) } } });
	}
	sessions.set(session.meta.id, session);
	ready.add(session.meta.id);
	browsers.set(session.meta.id, browser.dispose);

	// Trigger async cleanup if enabled in settings
	if (appSettings.worktrees?.autoCleanOld) {
		// Every conversation that may come back to its worktree, not only the ones running now.
		void deps.store().listSessions().then((all) => {
			const inUse = new Set([...Array.from(sessions.values()).map((s) => s.cwd), ...all.filter((meta) => !meta.archived).map((meta) => meta.cwd)]);
			return cleanOldWorktrees(cwd, appSettings, inUse);
		}).catch(() => {});
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

/** Tear down a live session's agent, MCP servers and browser. Safe to call for unknown ids. `reason` is what SessionEnd hooks see. */
export async function disposeSession(sessionId: string, reason: SessionEndReason): Promise<void> {
	// 侧边聊天的工具拿着父会话本身（让它停、给它排活），父会话走了它们就没有可拿的了：先走。
	await Promise.all(liveSides(sessionId).map((side) => disposeSession(side.meta.id, reason)));
	// 先于处置：处置会让等它的人醒来，那时它的链和「在等谁」都该已经清掉。
	peers.forget(sessionId);
	retiring.add(sessionId);
	submitted.delete(sessionId);
	try { await initializing.get(sessionId); } catch { /* Failed initialization still owns resources to release. */ }
	await sessions.get(sessionId)?.dispose(reason);
	closeSessionBrowser(sessionId);
	browsers.get(sessionId)?.();
	browsers.delete(sessionId);
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
		// 侧边聊天要父会话先起来：它每一问都读父会话，工具也直接拿着父会话。
		const parent = loaded.meta.parentId ? await ensureLiveSession(loaded.meta.parentId) : undefined;
		if (parent === null || retiring.has(sessionId)) return null;
		session = stageSession({ meta: loaded.meta, messages: loaded.messages, running: false, pendingApprovals: [] }, parent);
		session.restore(loaded.messages, loaded.compaction, loaded.compactions);
		session.log.commandRuns = loaded.commandRuns ?? [];
		session.log.hookRuns = loaded.hookRuns ?? [];
	}
	try {
		await ensureSessionWorkspace(session.cwd);
		if (session.meta.workspaceSetup === "worktree") {
			const project = session.cwd;
			const prepared = await autoCreateSessionWorktree(project, deps.settings(), sessionId);
			session.cwd = prepared.cwd;
			/*
			 * Execution may move; project identity and all metadata edits remain on the same log.
			 *
			 * Not made, the reason is kept on the conversation, because it asked for a copy and is about to
			 * change the original. This used to fall back without a word — the person who chose a separate
			 * worktree found out from `git status` in their own checkout — and then with a toast, which is
			 * the wrong place for anything that matters later (`worktreeError`).
			 */
			await session.log.append({ type: "meta", meta: {
				...session.meta,
				cwd: prepared.cwd,
				workspaceSetup: undefined,
				...(prepared.worktreeCreated && prepared.branch
					? { worktree: { project, branch: prepared.branch, ...(prepared.base ? { base: prepared.base } : {}) }, worktreeError: undefined }
					: { worktreeError: prepared.error || "git worktree add" }),
			} });
		} else {
			/*
			 * Its worktree was taken back — archived, or cleaned up — and it is in use again
			 * (`bringBackWorktree`).
			 */
			const fallback = await bringBackWorktree(session.meta);
			if (fallback) {
				session.cwd = fallback.cwd;
				await session.log.append({ type: "meta", meta: { ...session.meta, ...fallback } });
			}
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
		const meta = await store.get(sessionId);
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
	if (liveSides(id).some((side) => sessionBusy(side.meta.id))) return true;
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
export async function deleteSessions(requested: string[]): Promise<void> {
	for (const id of requested) deleting.add(id);
	// 侧边聊天跟着父会话删（存储那头也会连带删掉行），这里补上它们在库外留下的东西。
	const ids = [...requested, ...(await sideSessionsOf(requested)).map((meta) => meta.id)];
	for (const id of ids) deleting.add(id);
	try {
		// Read before the rows go: the meta is the only record of where each worktree is.
		const owned = (await Promise.all(requested.map((id) => deps.store().get(id)))).filter((meta) => meta?.worktree);
		await Promise.all(ids.map((id) => disposeSession(id, "deleted")));
		await deps.store().deleteMany(ids);
		// The rows are the conversation; what is left is litter, and failing to sweep it is no reason to report the delete as failed.
		await Promise.all(ids.flatMap((id) => [removeSessionArtifacts(plumeHome(), id), removeSummary(id)].map((done) => done.catch(() => {}))));
		/*
		 * Its worktree goes with it, and its branch too once everything on it is in the base. One holding
		 * uncommitted changes stays where it is: deleting a conversation is not a decision about work it
		 * never committed, and the delete dialog says where that work is kept (ADR-0050).
		 */
		for (const meta of owned) if (meta) void reclaimWorktree(meta, { dropMergedBranch: true }).catch(() => {});
	} finally {
		for (const id of ids) deleting.delete(id);
	}
}

/**
 * What archiving or bringing back a conversation does to its worktree, after the store has recorded it.
 * Every way of archiving comes through here — the window, the phone, a conversation archiving itself.
 *
 * Archived: the folder goes when everything in it is committed, and the branch with it once everything
 * on it is in the base; one with uncommitted changes is kept as it is. Brought back: checked out again
 * where it was — or, when it cannot be, the conversation goes on in the project and says why (ADR-0050).
 */
export async function worktreeFollowsArchive(meta: SessionMeta): Promise<void> {
	if (!meta.worktree) return;
	if (meta.archived) {
		void reclaimWorktree(meta, { dropMergedBranch: true }).catch(() => {});
		return;
	}
	const fallback = await bringBackWorktree(meta).catch(() => null);
	if (fallback) await deps.store().append(meta, { type: "meta", meta: { ...meta, ...fallback } });
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
	/*
	 * 侧边聊天不占名额、也不单独回收：它跟着父会话起落。旁边开着侧边聊天的会话不回收——那是一段
	 * 正在进行的对话，和正在跑的一轮一样。
	 */
	const counted = () => Array.from(sessions.values()).filter((session) => !session.parent).length;
	for (const [id, session] of Array.from(sessions.entries())) {
		if (counted() <= MAX_LIVE_SESSIONS) break;
		if (session.parent || id === keep || sessionBusy(id) || liveSides(id).length > 0) continue;
		if (browserState().tabs.some((tab) => tab.sessionId === id)) continue;
		await disposeSession(id, "evicted");
	}
}
