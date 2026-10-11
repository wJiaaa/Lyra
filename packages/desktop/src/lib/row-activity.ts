/**
 * What a sidebar row should show, given the main turn and the side chat.
 *
 * The list only used to watch the main agent. A side chat can run while that turn is idle, and
 * the row then looked finished — the thing the user asked to see as a running mark.
 *
 * The side chat only contributes "still going". Its own finish is not an unread result on this
 * row: the transcript it wrote is in another pane.
 */

import { visibleActivity, type SessionActivity } from "@plume/core/activity";

export interface SideRunningSource {
	/** 每个会话旁边那几格背后的会话，见 `dock/sideStore.ts`。 */
	sides: Readonly<Record<string, Readonly<Record<string, { id: string }>>>>;
}

/** 这几个会话旁边的侧边聊天会话，`父\t子` 一行一个——拼成串，selector 才能按值比较、没变就不重画。 */
export function sideSessionIds(state: SideRunningSource, parents: readonly string[]): string {
	return parents.flatMap((parent) => Object.values(state.sides[parent] ?? {}).map((side) => `${parent}\t${side.id}`)).join("\n");
}

/** 这个会话旁边随便哪一个还在答（或者停在审批上），这一行就还在动。 */
export function sideChatRunning(sides: string, activity: Readonly<Record<string, SessionActivity>>, sessionId: string): boolean {
	return sides.split("\n").some((line) => {
		const [parent, child] = line.split("\t");
		return parent === sessionId && child !== undefined && (activity[child] === "running" || activity[child] === "waiting");
	});
}

export function rowActivity(
	activity: SessionActivity | null,
	sideRunning: boolean,
	isActive: boolean,
): SessionActivity | null {
	const visible = visibleActivity(activity, isActive);
	if (visible === "running" || visible === "waiting") return visible;
	if (sideRunning) return "running";
	return visible;
}
