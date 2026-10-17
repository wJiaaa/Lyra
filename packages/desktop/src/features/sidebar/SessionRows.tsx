/**
 * A list's conversation rows, each followed by the conversations started from its suggestions.
 *
 * The nesting itself is decided in `lib/sidebar-grouping.ts` (`nestSpawned`); this only draws it, the
 * same way in every section, so a project, 「置顶」 and 「聊天」 cannot each grow their own version.
 */

import { Fragment } from "react";
import type { SessionMeta } from "@plume/core";
import { SessionRow, type RowActions } from "./SessionRow.tsx";
import { useApp } from "../../store/index.ts";
import { projectLabel } from "../../lib/project-identity.ts";

const NO_PROJECTS: never[] = [];

export function SessionRows({ sessions, spawned, actions, project }: {
	sessions: SessionMeta[];
	spawned: Record<string, SessionMeta[]>;
	actions: RowActions;
	/** Name each top-level row's project on hover — 「置顶」, where no folder row says it. */
	project?: boolean;
}) {
	const projects = useApp((s) => s.settings?.projects ?? NO_PROJECTS);
	return (
		<>
			{sessions.map((session) => (
				<Fragment key={session.id}>
					<SessionRow session={session} project={project ? projectLabel(projects, session) : undefined} actions={actions} />
					<Spawned parentId={session.id} spawned={spawned} actions={actions} />
				</Fragment>
			))}
		</>
	);
}

/** One indent however deep it goes: a suggestion's suggestion is still a follow-up of the same work. */
function Spawned({ parentId, spawned, actions }: { parentId: string; spawned: Record<string, SessionMeta[]>; actions: RowActions }) {
	return (
		<>
			{(spawned[parentId] ?? []).map((child) => (
				<Fragment key={child.id}>
					<SessionRow session={child} nested actions={actions} />
					<Spawned parentId={child.id} spawned={spawned} actions={actions} />
				</Fragment>
			))}
		</>
	);
}
