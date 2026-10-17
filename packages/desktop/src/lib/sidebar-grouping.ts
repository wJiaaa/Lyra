/**
 * Turning a flat list of sessions into the sidebar's three lists.
 *
 * Pure, and separate from the pane that renders it, because the rules are the sort you want to be
 * able to state and check: a project keeps its configured order, a project that never had a session
 * takes a row only where asked to, and searching filters sessions without dissolving the projects
 * they belong to.
 */

import type { SessionMeta } from "@plume/core";
import { sessionProject } from "./project-identity.ts";
import { orderedSessions, type SessionSortKey } from "./sidebar-order.ts";
import { isDescendantPath } from "./paths.ts";

export interface Group {
	/** The project's id. Fold state, drag, manual order and the menu key on this; two projects can share `path`. */
	id: string;
	/** The folder a new conversation from this row opens in. */
	path: string;
	name: string;
	sessions: SessionMeta[];
}

export interface ProjectRef {
	id: string;
	path: string;
	name: string;
	lastOpenedAt: number;
	/** Extra source folders, if this project was configured with more than one; see `projectFolders`. */
	folders?: string[];
}

export interface Grouped {
	/** Pinned individual sessions (shown at the top of the sidebar under 置顶). Only sessions pin; projects do not. */
	pinnedSessions: SessionMeta[];
	/** The registered projects, in configured order. */
	projects: Group[];
	/**
	 * Conversations that belong to no project, flat and newest first.
	 *
	 * Not a group. They used to be collected under a folder row called 「无项目」, which put a
	 * project-shaped thing in the list for the one case that is defined by not being a project —
	 * a folder you cannot open, named after the absence of the thing folders are named after.
	 * They are simply the conversations that are not filed anywhere, and they sit under 「最近」
	 * at the bottom, which is what they are and where they belong.
	 */
	loose: SessionMeta[];
}

export function groupSessions(
	sessions: SessionMeta[],
	projects: ProjectRef[],
	query: string,
	/**
	 * Directories that hold project-less conversations rather than projects.
	 *
	 * Sessions there are real and worth returning to — a review you asked about yesterday should be
	 * one click away — but they are not projects, and grouping them by directory the usual way
	 * produces a row called `owner-repo-6381` sitting among someone's actual work.
	 *
	 * More than one root because the directory has been renamed twice and stored sessions still
	 * record the path they were created under.
	 */
	scratchRoots: string[] = [],
	pinnedSessionIds: string[] = [],
	sessionOrder?: Record<string, string[]>,
	sortKey: SessionSortKey = "updatedAt",
	/**
	 * Projects that had conversations and have none left, because every one was archived.
	 *
	 * Passed in rather than derived here: this only ever sees the conversations it is asked to
	 * group, and the archived ones are by definition not among them — so from in here "never had
	 * any" and "has none left" look identical, while calling for opposite answers.
	 */
	emptied: ReadonlySet<string> = new Set(),
	/** Whether an emptied project should fold away with its conversations; see `hideEmptiedProjects`. */
	hideEmptied = false,
	/**
	 * Whether a registered project that never had a conversation takes a row.
	 *
	 * Off by default because the archive groups the same way, and there a project with nothing filed
	 * is not something to show. The ordinary list turns it on: a project just created has no
	 * conversation yet, and hiding it left nowhere to click to start the first one.
	 */
	showUnused = false,
): Grouped {
	const needle = query.trim().toLowerCase();
	const filtered = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;
	const pinnedIdSet = new Set(pinnedSessionIds);

	const pinnedSessions: SessionMeta[] = [];
	const unpinnedSessions: SessionMeta[] = [];

	for (const s of filtered) {
		if (pinnedIdSet.has(s.id)) {
			pinnedSessions.push(s);
		} else {
			unpinnedSessions.push(s);
		}
	}

	const byId = new Map<string, Group>();
	for (const project of projects) byId.set(project.id, { id: project.id, path: project.path, name: project.name, sessions: [] });
	const loose: SessionMeta[] = [];
	for (const session of unpinnedSessions) {
		/*
		 * The project it records, while that exists; otherwise none.
		 *
		 * Not the folder's. Conversations from a folder no project listed used to build a project row
		 * of their own, named after the folder — so opening a folder made a "project", which is the
		 * thing that should only ever be made on purpose. A scratch conversation records none either.
		 */
		const group = isScratch(session.cwd, scratchRoots) ? undefined : byId.get(sessionProject(projects, session)?.id ?? "");
		if (group) group.sessions.push(session);
		else loose.push(session);
	}
	for (const group of byId.values()) {
		group.sessions = orderedSessions(group.sessions, sortKey, sessionOrder?.[group.id]);
	}

	const order = new Map(projects.map((p, i) => [p.id, i]));
	const all = [...byId.values()]
		.filter((group) => {
			if (group.sessions.length > 0) return true;
			/*
			 * 空着的项目分两种，它们的答案正好相反。
			 *
			 * 一种是「会话都归档了」——这个项目告一段落了。想让它跟着一起收起来的人去设置里打开
			 * `hideEmptiedProjects`；默认不打开，因为一个登记过的项目突然从侧边栏消失，比多留
			 * 一行更让人找不着北。
			 *
			 * 另一种是「一条会话都没有过」，多半是刚建好的项目，由 `showUnused` 决定。搜索时不占行：
			 * 它没有会话可以匹配，列出来只是一排和搜索词无关的空项目。
			 */
			if (emptied.has(group.id)) return !hideEmptied;
			return showUnused && !needle;
		})
		.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

	return {
		pinnedSessions: pinnedSessions.sort((a, b) => b.updatedAt - a.updatedAt),
		projects: all,
		loose: loose.sort((a, b) => b.updatedAt - a.updatedAt),
	};
}

/** The sidebar's lists, with conversations started from a suggestion drawn under the one that suggested them. */
export interface Nested extends Grouped {
	/** Parent id → the conversations started from its suggestions, oldest first. Not in any list's own rows. */
	spawned: Record<string, SessionMeta[]>;
}

/**
 * Put each conversation started from a suggestion (`spawnedFrom`) under the conversation that made it,
 * and each fork (`forkedFrom`) under the conversation it was forked from.
 *
 * A follow-up handed off as a card is part of the work it came out of, not a peer of it: listed on
 * its own it reads as unrelated, and the link back is lost. A fork is the same work taken another way. Only within one list, though — the parent
 * pinned and the child not, or the parent archived, and the child stays a row of its own where it is
 * rather than vanishing under something that is not there. Kept out of `groupSessions` because the
 * archive and `listed-projects` group the same way and have no rows to hang children on.
 */
export function nestSpawned(grouped: Grouped): Nested {
	const spawned: Record<string, SessionMeta[]> = {};
	const nest = (list: SessionMeta[]) => {
		const here = new Map(list.map((session) => [session.id, session]));
		return list.filter((session) => {
			const parent = here.get(session.spawnedFrom?.sessionId ?? session.forkedFrom?.sessionId ?? "");
			// A parent is always older; asking so also means two records naming each other cannot both disappear.
			if (!parent || parent.createdAt >= session.createdAt) return true;
			(spawned[parent.id] ??= []).push(session);
			return false;
		});
	};
	const out: Nested = {
		pinnedSessions: nest(grouped.pinnedSessions),
		projects: grouped.projects.map((group) => ({ ...group, sessions: nest(group.sessions) })),
		loose: nest(grouped.loose),
		spawned,
	};
	for (const children of Object.values(spawned)) children.sort((a, b) => a.createdAt - b.createdAt);
	return out;
}

/** A list's rows and everything nested under them, depth first — what a folded section is summing up. */
export function withSpawned(list: SessionMeta[], spawned: Record<string, SessionMeta[]>): SessionMeta[] {
	const out: SessionMeta[] = [];
	const visit = (session: SessionMeta) => {
		out.push(session);
		for (const child of spawned[session.id] ?? []) visit(child);
	};
	for (const session of list) visit(session);
	return out;
}

/**
 * Projects whose conversations are all in the archive, by id.
 *
 * Takes both halves because the question — "did this project have conversations before they were
 * archived?" — cannot be answered from either alone: `listable` is what the list shows and
 * `archived` is what it does not.
 */
export function emptiedProjects(listable: SessionMeta[], archived: SessionMeta[]): Set<string> {
	const live = new Set(listable.map((session) => session.project));
	const out = new Set<string>();
	for (const session of archived) if (session.project && !live.has(session.project)) out.add(session.project);
	return out;
}

/**
 * Whether a conversation lives in a scratch directory rather than in a project.
 *
 * Exported because the flat 「聊天」 list needs the same answer for a different reason. There a row
 * is captioned with the project it belongs to — the titles are no longer under a folder that says
 * so — and a scratch session's `projectName` is a generated directory name like `owner-repo-6381`,
 * which as a caption is worse than none.
 */
export function isScratch(cwd: string, scratchRoots: string[]): boolean {
	// The roots are the main process's `path.join`, so backslashed on Windows, where appending "/"
	// matched nothing and every scratch session grew a project row of its own.
	return scratchRoots.filter(Boolean).some((root) => isDescendantPath(root, cwd));
}

/**
 * Which sessions belong in the list at all.
 *
 * Archived ones live in the archive — that is the whole point of archiving them. Empty ones are not
 * conversations yet: no title, nothing to return to, so a row for one cannot be usefully clicked.
 * The active session is exempt, because the conversation you are in the middle of starting has to
 * stay visible and selected while its first message is still in flight.
 */
export function listableSessions(sessions: SessionMeta[], activeSessionId: string | null): SessionMeta[] {
	return sessions.filter((s) => !s.archived && (s.messageCount > 0 || s.id === activeSessionId));
}
