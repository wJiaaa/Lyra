import { create } from "zustand";

/**
 * A background job someone asked to see — from the line in the conversation that says it ended.
 *
 * The panel may not be mounted yet when this is set (opening it is the asker's job), so this is a
 * request with a timestamp the panel acts on once, not a selection it mirrors.
 */
export const useJobFocus = create<{ focus: { sessionId: string; jobId: string; at: number } | null }>(() => ({ focus: null }));

export function focusJob(sessionId: string, jobId: string): void {
	useJobFocus.setState({ focus: { sessionId, jobId, at: Date.now() } });
}
