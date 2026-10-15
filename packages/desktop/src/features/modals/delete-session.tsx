/**
 * The question asked before a conversation is deleted — the same from the sidebar's menu, the archive's
 * row and a split screen's title bar.
 *
 * A conversation with a worktree of its own also says what happens to that: deleting the conversation
 * takes the folder and, once its commits are all in the base, the branch (`sessions:remove`). What would
 * outlive it is named, because it is the one part of the work not deleted with it: uncommitted files left
 * where they are, unmerged commits left on their branch.
 *
 * Conversations started from its suggestions (nested under it in the sidebar) are not deleted with it:
 * they stay, each a conversation of its own. That is said, and deleting them all at once is the second answer.
 */

import type { SessionMeta } from "@plume/core";
import type { WorktreeState } from "../../../electron/ipc-types.ts";
import { translate } from "../../i18n/translate.ts";
import { tildeHome } from "../../lib/paths.ts";
import { sessionTitle } from "../../lib/session-title.ts";
import { nestSpawned, withSpawned } from "../../lib/sidebar-grouping.ts";
import { bridge } from "../../services/index.ts";
import { useApp } from "../../store/index.ts";
import type { ConfirmOptions } from "../../ui/overlay/Confirm.tsx";

/** How long the dialog waits on git before it asks without the worktree's line. */
const STATE_WAIT_MS = 600;
/** How old an answer read when the menu opened may be and still stand in for a fresh one. */
const PREFETCH_FRESH_MS = 10_000;

const prefetched = new Map<string, { at: number; state: Promise<WorktreeState | null> }>();

/**
 * Ask git as the menu that offers 删除 opens, so the dialog does not wait on it after the press: the
 * gap between the menu closing and the dialog opening was a few hundred milliseconds of nothing.
 */
export function prefetchDeleteQuestion(meta: SessionMeta): void {
	if (!meta.worktree) return;
	prefetched.set(meta.id, { at: Date.now(), state: bridge.worktree.state(meta.id).catch(() => null) });
}

function worktreeStateOf(meta: SessionMeta): Promise<WorktreeState | null> {
	const early = prefetched.get(meta.id);
	prefetched.delete(meta.id);
	return early && Date.now() - early.at < PREFETCH_FRESH_MS ? early.state : bridge.worktree.state(meta.id).catch(() => null);
}

export async function deleteSessionQuestion(meta: SessionMeta, onConfirm: () => void): Promise<ConfirmOptions> {
	const title = sessionTitle(meta.title);
	const detail = translate("sidebarList.deleteDetail", { title, n: meta.messageCount });
	const nested = nestedUnder(meta);
	const worktree = meta.worktree ? await worktreeNote(meta) : null;
	const note = "mt-1.5 block [overflow-wrap:anywhere]";
	return {
		title: translate("sidebarList.deleteConfirm"),
		detail: nested.length || worktree ? (
			<>
				{detail}
				{nested.length > 0 && (
					<span data-ly-delete-nested="" className={note}>
						{translate("sidebarList.deleteNested", { n: nested.length })}
					</span>
				)}
				{worktree && (
					<span data-ly-delete-worktree="" className={note}>
						{worktree}
					</span>
				)}
			</>
		) : (
			detail
		),
		confirmLabel: nested.length ? translate("sidebarList.deleteOnlyThis") : translate("common.delete"),
		alternate: nested.length
			? {
					label: translate("sidebarList.deleteWithNested", { n: nested.length + 1 }),
					// Nested ones first: deleting the parent first lifts them to the top level for the moment before they go.
					onConfirm: () => void Promise.all(nested.map((child) => useApp.getState().deleteSession(child))).then(onConfirm),
				}
			: undefined,
		onConfirm,
	};
}

/**
 * Every conversation started from this one's suggestions, and from theirs, archived or not.
 *
 * Not only what the sidebar is drawing under it right now: only an archived conversation can be deleted,
 * and an archived parent is not in the list, so its children are already standing on their own there.
 * What deleting it changes is that they can never go back under it. Who counts as whose child is
 * `nestSpawned`'s rule, applied to one flat list.
 */
function nestedUnder(meta: SessionMeta): SessionMeta[] {
	const { spawned } = nestSpawned({ pinnedSessions: [], projects: [], loose: useApp.getState().sessions });
	return withSpawned([meta], spawned).slice(1);
}

async function worktreeNote(meta: SessionMeta): Promise<string | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), STATE_WAIT_MS)));
	const state = await Promise.race([worktreeStateOf(meta), timeout]).finally(() => clearTimeout(timer));
	if (!state) return null;
	const lines: string[] = [];
	if (state.present && state.uncommitted > 0) lines.push(translate("sidebarList.deleteWorktreeUncommitted", { n: state.uncommitted, path: tildeHome(meta.cwd) }));
	if (state.ahead > 0) lines.push(translate("sidebarList.deleteWorktreeUnmerged", { n: state.ahead, branch: state.branch }));
	if (!lines.length && state.present) lines.push(translate("sidebarList.deleteWorktree"));
	return lines.length ? lines.join(" ") : null;
}
