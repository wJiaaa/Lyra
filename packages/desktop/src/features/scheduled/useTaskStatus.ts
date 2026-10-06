import type { ScheduledTask } from "@plume/core";

import { useApp } from "../../store/index.ts";
import { useScheduledNotices } from "./notices.ts";

/**
 * Whether a run of `task` is going, for its card and its row in the sidebar alike.
 *
 * The session's own activity once it has any, and before that the start the scheduler announced,
 * which also says which session to watch — `lastSessionId` still names the previous run until the
 * attempt is saved. Waiting is said as waiting, because a task held on an approval gets no further
 * alone.
 */
export function useTaskStatus(task: ScheduledTask): "running" | "waiting" | null {
	const started = useScheduledNotices((s) => s.runs[task.id]);
	const watched = started ?? task.lastSessionId;
	const activity = useApp((s) => (watched ? s.activity[watched] : undefined));
	return activity === "running" || activity === "waiting" ? activity : started && !activity ? "running" : null;
}
