import { useEffect, useRef } from "react";
import { useJobFocus } from "../../store/job-focus.ts";

/**
 * The conversation asked to see a background job: open this screen's task panel, where its output
 * is. The row itself cannot — the transcript reaching into the dock is a dependency cycle — so it
 * leaves a request, the same way a dispatch card asks for the sub-agent panel (see `SubAgentBar`),
 * and `open` comes from the composer, which already holds the dock. Only this screen's
 * conversation; another screen's request is not ours to answer.
 */
export function useJobReveal(sessionId: string | null, open: () => void): void {
	const focus = useJobFocus((state) => state.focus);
	const handled = useRef(focus?.at ?? 0);
	useEffect(() => {
		if (!focus || focus.at === handled.current) return;
		handled.current = focus.at;
		if (focus.sessionId === sessionId) open();
	}, [focus, sessionId, open]);
}
