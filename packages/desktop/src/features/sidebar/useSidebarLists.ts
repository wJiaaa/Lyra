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
import type { RowActions } from "./SessionRow.tsx";

export function useSidebarLists({
	sort,
	onOpened,
}: {
	/** Which timestamp orders every list here. */
	sort: SortKey;
	/** Called after a conversation is opened, so a drawer can get out of its own way. */
	onOpened: () => void;
}): {
	groups: Grouped;
	actions: RowActions;
} {
	const sessions = useApp((s) => s.sessions);
	const settings = useApp((s) => s.settings);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const scratchRoots = useApp((s) => s.scratchRoots);
	const setSessionArchived = useApp((s) => s.setSessionArchived);

	const listable = useMemo(() => listableSessions(sessions, activeSessionId), [sessions, activeSessionId]);
	const archived = useMemo(() => sessions.filter((s) => s.archived), [sessions]);
	// Grouping keeps the order it is given, so this is what a project's rows are ordered by.
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
				"",
				scratchRoots,
				settings?.pinnedSessionIds ?? [],
				settings?.sessionOrder,
				sort,
				emptied,
				settings?.hideEmptiedProjects ?? false,
				true,
			),
		[pool, settings, scratchRoots, sort, emptied],
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

	return { groups, actions };
}
