/**
 * Which conversation a mounted pane is drawing.
 *
 * The app store still has one live transcript slot. A split window mounts more than one
 * conversation, so each pane names the session it is responsible for. The focused pane reads
 * the live fields; the others read the cache that `openSession` parks on the way out.
 *
 * `undefined` means "not inside a pane" — Composer on the empty state, the skeleton — and
 * falls back to the store's active id. `null` is the blank conversation that has not been sent.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Message, SessionMeta, SubAgentSummary } from "@lyra/core";
import type { WorkspaceInfo } from "../../electron/ipc-types.ts";
import { bridge } from "../services/index.ts";
import { useApp, type AppState } from "../store/index.ts";
import { isProjectLess } from "../store/session-slice.ts";
import { baseName } from "../lib/paths.ts";
import { useSubAgents } from "../store/subAgents.ts";
import type { Cache } from "../store/derive.ts";
import type { ToolRun } from "../store/tool-run.ts";

export const SessionScope = createContext<string | null | undefined>(undefined);

/**
 * Which screen's dock a pane is drawn in: that screen's key — its session id, or `@draft`.
 *
 * Null outside any screen, which is a panel window: it holds one panel and is that panel. Kept here
 * beside `SessionScope` rather than in the dock so a panel can ask without importing the dock.
 */
export const DockScope = createContext<string | null>(null);

export function useDockScope(): string | null {
	return useContext(DockScope);
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_TODOS: AppState["todos"] = [];
const EMPTY_APPROVALS: AppState["approvals"] = [];
const EMPTY_RUNS: AppState["commandRuns"] = [];
const EMPTY_HICCUPS: AppState["hiccups"] = [];
const EMPTY_TOOLS: Record<string, ToolRun> = {};
const EMPTY_AGENTS: SubAgentSummary[] = [];

/**
 * A screen's parked copy — none for a blank screen away from the live slot, which has said nothing yet.
 *
 * A pane reads the live fields only when its conversation is the one in the live slot, the blank one
 * included. A blank screen beside a live conversation used to read them too, and drew that
 * conversation's running turn and stop button as its own.
 */
function parked(s: AppState, id: string | null): Cache[string] | undefined {
	return id === null ? undefined : s.sessionCache[id];
}

export function useScopedSessionId(): string | null {
	const scoped = useContext(SessionScope);
	const active = useApp((s) => s.activeSessionId);
	return scoped === undefined ? active : scoped;
}

export function useScopedMessages(): Message[] {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.messages;
		return parked(s, id)?.messages ?? EMPTY_MESSAGES;
	});
}

export function useScopedRunning(): boolean {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.running;
		return parked(s, id)?.state?.running ?? (id !== null && s.activity[id] === "running");
	});
}

export function useScopedStopped() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.stopped;
		return parked(s, id)?.state?.stopped ?? null;
	});
}

export function useScopedTodos() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.todos;
		return parked(s, id)?.state?.todos ?? EMPTY_TODOS;
	});
}

export function useScopedApprovals(): AppState["approvals"] {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.approvals;
		return parked(s, id)?.state?.approvals ?? EMPTY_APPROVALS;
	});
}

export function useScopedCompactions() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.compactions;
		return parked(s, id)?.state?.compactions ?? EMPTY_RUNS;
	});
}

export function useScopedCommandRuns() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.commandRuns;
		return parked(s, id)?.state?.commandRuns ?? EMPTY_RUNS;
	});
}

const EMPTY_HOOK_RUNS: AppState["hookRuns"] = [];

export function useScopedHookRuns() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.hookRuns;
		return parked(s, id)?.state?.hookRuns ?? EMPTY_HOOK_RUNS;
	});
}

export function useScopedHiccups() {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.hiccups;
		return parked(s, id)?.state?.hiccups ?? EMPTY_HICCUPS;
	});
}

export function useScopedToolRuns(): Record<string, ToolRun> {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.toolRuns;
		return parked(s, id)?.toolRuns ?? EMPTY_TOOLS;
	});
}

/**
 * One set of tool records by this screen's conversation, for selectors that pick out a single card
 * rather than subscribing to all of them.
 */
export function scopedToolRuns(s: AppState, id: string | null): Record<string, ToolRun> {
	return id === s.activeSessionId ? s.toolRuns : (parked(s, id)?.toolRuns ?? EMPTY_TOOLS);
}

export function useScopedMeta(): SessionMeta | null {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === s.activeSessionId) return s.meta;
		return parked(s, id)?.meta ?? (id === null ? null : (s.sessions.find((session) => session.id === id) ?? null));
	});
}

export function useScopedLoading(): boolean {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (!id) return false;
		if (s.activeSessionId === id) return s.loadingSession;
		const cached = s.sessionCache[id] as Cache[string] | undefined;
		return !cached;
	});
}

/**
 * This conversation's sub-agents: the live roster when it is the live conversation, and the last one
 * it broadcast otherwise — a second screen shows its own delegated work, not the focused one's.
 */
export function useScopedSubAgents(): SubAgentSummary[] {
	const id = useScopedSessionId();
	const active = useApp((s) => s.activeSessionId);
	const live = useSubAgents((s) => s.agents);
	const retained = useSubAgents((s) => (id ? s.rosters[id] : undefined));
	if (id === active) return live;
	return retained ?? EMPTY_AGENTS;
}

const NO_WORKSPACE: { workspace: WorkspaceInfo | null; scratchCwd: string | null } = { workspace: null, scratchCwd: null };
/** What each project was when a screen last read it, so reopening one does not start from a bare path. */
const described = new Map<string, WorkspaceInfo>();
const rereads = new Set<(path: string) => void>();
/** One read per project at a time: a screen has half a dozen things asking about the same one. */
const reading = new Map<string, Promise<WorkspaceInfo | null>>();

function describe(path: string): Promise<WorkspaceInfo | null> {
	let pending = reading.get(path);
	if (!pending) {
		pending = bridge.workspace.info(path).finally(() => reading.delete(path));
		reading.set(path, pending);
	}
	return pending;
}

/**
 * A project changed under a screen that is not live — a branch switched from its menu.
 *
 * `refreshWorkspace` re-reads the live slot's project only; the screens showing this one read it again.
 */
export function rereadWorkspace(path: string): void {
	described.delete(path);
	for (const listener of rereads) listener(path);
}

/**
 * Where this screen's conversation runs: its own project, not the one that has focus.
 *
 * `workspace` and `scratchCwd` describe the live slot, and in a split that is another screen's
 * conversation as often as not. Read from them, a screen's branch menu listed — and switched — the
 * other project's branches, and its file links resolved against the other project. Even a press is not
 * enough on its own: it swaps the transcript at once, but the project is read behind it, and that read
 * can take a second on a large repository.
 *
 * A blank screen away from the live slot has said nothing yet and has no directory of its own, so it
 * reads the live one, as it did before.
 */
export function useScopedWorkspace(): { workspace: WorkspaceInfo | null; scratchCwd: string | null } {
	const id = useScopedSessionId();
	const live = useApp((s) => id === null || id === s.activeSessionId);
	const workspace = useApp((s) => s.workspace);
	const scratchCwd = useApp((s) => s.scratchCwd);
	const cwd = useApp((s) => (live || id === null ? null : ((parked(s, id)?.meta ?? s.sessions.find((one) => one.id === id))?.cwd ?? null)));
	const projectLess = useApp((s) => cwd !== null && isProjectLess(cwd, s.scratchRoots));
	const named = useApp((s) => (cwd === null ? undefined : s.settings?.projects.find((project) => project.path === cwd)?.name));
	const sameAsLive = cwd !== null && workspace?.path === cwd;
	const [info, setInfo] = useState<WorkspaceInfo | null>(() => (cwd ? (described.get(cwd) ?? null) : null));
	const [reread, setReread] = useState(0);
	useEffect(() => {
		const listener = (path: string) => {
			if (path === cwd) setReread((n) => n + 1);
		};
		rereads.add(listener);
		return () => {
			rereads.delete(listener);
		};
	}, [cwd]);
	useEffect(() => {
		if (!cwd || projectLess || sameAsLive) return;
		let current = true;
		void describe(cwd).then(
			(next) => {
				if (next) described.set(cwd, next);
				if (current) setInfo(next);
			},
			() => {},
		);
		return () => {
			current = false;
		};
	}, [cwd, projectLess, sameAsLive, reread]);
	// One object per answer, since callers hand it to effects as a dependency.
	return useMemo(() => {
		if (live) return { workspace, scratchCwd };
		if (cwd === null) return NO_WORKSPACE;
		if (projectLess) return { workspace: null, scratchCwd: cwd };
		if (sameAsLive) return { workspace, scratchCwd: null };
		// Named at once from the conversation; the branch arrives with the read.
		const known = info?.path === cwd ? info : described.get(cwd);
		return { workspace: known ?? { path: cwd, name: named ?? (baseName(cwd) || cwd), isGitRepo: false, branch: null }, scratchCwd: null };
	}, [live, workspace, scratchCwd, cwd, projectLess, sameAsLive, info, named]);
}

/**
 * The project directory of this screen's conversation, without reading the project — for what only
 * needs the path, like resolving a relative link. Null where `useScopedWorkspace` has no project.
 */
export function useScopedProjectPath(): string | null {
	const id = useScopedSessionId();
	return useApp((s) => {
		if (id === null || id === s.activeSessionId) return s.workspace?.path ?? null;
		const cwd = (parked(s, id)?.meta ?? s.sessions.find((one) => one.id === id))?.cwd ?? null;
		return cwd !== null && !isProjectLess(cwd, s.scratchRoots) ? cwd : null;
	});
}
