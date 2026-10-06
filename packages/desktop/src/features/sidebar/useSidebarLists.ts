/**
 * What the sidebar is showing, and what its rows do.
 *
 * Separated from the pane for the usual reason this codebase separates things: these are rules you
 * want to be able to state. Which conversations are listed and which actions a row offers are two
 * questions with two answers, and neither of them is about layout. Archived conversations are
 * 设置 › 已归档的聊天's; the sidebar does not list them.
 */

import type { SessionMeta } from "@plume/core";
import { useMemo } from "react";
import { useApp } from "../../store/index.ts";
import { openInPane } from "../split/index.ts";
import { emptiedProjects, groupSessions, listableSessions, type Grouped } from "../../lib/sidebar-grouping.ts";
import type { SortKey } from "./ListMenu.tsx";
import { bandByRecency, type RecencyBand } from "./recency.ts";
import type { RowActions } from "./SessionRow.tsx";

export function useSidebarLists({
	query,
	sort,
	chatShown,
	onOpened,
}: {
	query: string;
	/** Which timestamp orders every list here. */
	sort: SortKey;
	/** How many rows the flat list is currently showing, which is what gets banded. */
	chatShown: number;
	/** Called after a conversation is opened, so a drawer can get out of its own way. */
	onOpened: () => void;
}): {
	groups: Grouped;
	/** Everything matching the search, before paging — the source of the count behind 展开显示. */
	matching: SessionMeta[];
	bands: RecencyBand[];
	actions: RowActions;
} {
	const sessions = useApp((s) => s.sessions);
	const settings = useApp((s) => s.settings);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const scratchRoots = useApp((s) => s.scratchRoots);
	const setSessionArchived = useApp((s) => s.setSessionArchived);

	const listable = useMemo(() => listableSessions(sessions, activeSessionId), [sessions, activeSessionId]);
	const archived = useMemo(() => sessions.filter((s) => s.archived), [sessions]);
	/*
	 * Sorted once, here, rather than by each list that shows it.
	 *
	 * Grouping keeps the order it is given, so this is what a project's rows are ordered by; the
	 * bands sort again by the same key because they also have to cut on it. Both come from one
	 * setting, so the two halves can never disagree about what "most recent" means.
	 */
	const poolSortField = sort === "createdAt" ? "createdAt" : "updatedAt";
	const pool = useMemo(
		() => [...listable].sort((a, b) => b[poolSortField] - a[poolSortField]),
		[listable, poolSortField],
	);

	const emptied = useMemo(() => emptiedProjects(listable, archived), [listable, archived]);

	const groups = useMemo(
		() =>
			groupSessions(
				pool,
				settings?.projects ?? [],
				query,
				scratchRoots,
				settings?.pinnedSessionIds ?? [],
				settings?.sessionOrder,
				sort,
				emptied,
				settings?.hideEmptiedProjects ?? false,
				true,
			),
		[pool, settings, query, scratchRoots, sort, emptied],
	);

	const matching = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return needle ? pool.filter((s) => s.title.toLowerCase().includes(needle)) : pool;
	}, [pool, query]);

	/*
	 * The clock is read here rather than held in state.
	 *
	 * Banding by date needs to know what "today" is, and a timer that re-banded the list at midnight
	 * would be a subscription running all day to catch one moment nobody is looking at. The session
	 * list changes often enough that this is recomputed constantly anyway; the case it gets wrong is
	 * a window left open overnight and untouched, where the first thing that happens in the morning
	 * also fixes it.
	 */
	const bands = useMemo(
		() => bandByRecency(matching.slice(0, chatShown), Date.now(), poolSortField),
		[matching, chatShown, poolSortField],
	);

	const open = (meta: SessionMeta) => {
		openInPane(meta);
		onOpened();
	};
	const actions: RowActions = {
		onOpen: open,
		onArchive: (meta) => void setSessionArchived(meta, true),
		/*
		 * Both directions, because one row can be filed: the conversation you have open, which
		 * `listableSessions` keeps in the list until you leave it. Offering it 归档 — the thing it
		 * already is — would be a button that does nothing. The row picks by what it is; see
		 * `SessionRow`.
		 */
		onRestore: (meta) => void setSessionArchived(meta, false),
	};

	return { groups, matching, bands, actions };
}
