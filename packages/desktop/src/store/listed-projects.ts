/**
 * 侧边栏「项目」下面列着的那几个项目，同样的顺序。
 *
 * 项目选择器用它，而不是自己读 `settings.projects`：哪些项目占行、按什么顺序，是侧边栏的规则
 * 说了算的，自己读那份列表两处就会对不上。这里和侧边栏走同一个 `groupSessions`，按的是
 * 常规视图（不在归档里、没有搜索）——那是选择器旁边始终可见的那一份。
 *
 * 放在 store 而不是侧边栏里：侧边栏经由 conversation 引到了输入框和 modals，选择器再回头引
 * 侧边栏就成了环。
 */

import { useMemo } from "react";

import { emptiedProjects, groupSessions, listableSessions, type Group } from "../lib/sidebar-grouping.ts";
import { useApp } from "./index.ts";

export function useListedProjects(): Group[] {
	const sessions = useApp((s) => s.sessions);
	const settings = useApp((s) => s.settings);
	const activeSessionId = useApp((s) => s.activeSessionId);
	const scratchRoots = useApp((s) => s.scratchRoots);

	return useMemo(() => {
		const listable = listableSessions(sessions, activeSessionId);
		const archived = sessions.filter((s) => s.archived);
		return groupSessions(
			listable,
			settings?.projects ?? [],
			"",
			scratchRoots,
			settings?.pinnedSessionIds ?? [],
			undefined,
			undefined,
			emptiedProjects(listable, archived),
			settings?.hideEmptiedProjects ?? false,
			true,
		).projects;
	}, [sessions, settings, activeSessionId, scratchRoots]);
}
