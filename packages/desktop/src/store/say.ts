/**
 * A button in the conversation speaking for the reader: `plume.send` in a preview's page, a `send`
 * button in an interface block.
 *
 * It goes the way a message typed into the composer goes (see the submit in `Composer`): queued while
 * the turn is still running or others are waiting, so it is said in order and not slipped into the
 * turn halfway; sent straight away otherwise. The page already has its answer on screen — this is
 * the reader choosing what to ask next, and the queue is where they can still take it back.
 */

import { translate } from "../i18n/translate.ts";
import { useApp } from "./index.ts";
import { takePageStates } from "./page-state.ts";

/**
 * `text` is what the reader sees in their bubble; `spoken` what the model gets, when it is more —
 * an interface block's button sends the values the reader set along with its words.
 */
export function sayFor(sessionId: string, text: string, spoken = text): void {
	// What the reader set in the conversation's pages goes with it, as with a message typed in the composer.
	const states = takePageStates(sessionId);
	const content = states ? `${spoken}\n\n${states}` : spoken;
	const state = useApp.getState();
	const blocks = [{ type: "text" as const, text: content }];
	const display = content === text ? {} : { displayText: text };
	const running = sessionId === state.activeSessionId ? state.running : state.activity[sessionId] === "running";
	if (running || (state.queued[sessionId]?.length ?? 0) > 0) {
		state.enqueue(sessionId, { content: blocks, ...display, draft: { text, attachments: [], sessionRefs: [] }, preview: text });
		// Idle with a queue: the last turn was stopped, so this is what moves it on — as in `Composer`.
		if (!running) void state.flushQueue(sessionId);
		return;
	}
	void state.send(blocks, { sessionId, ...display }).then((accepted) => {
		if (!accepted) useApp.getState().notify(translate("preview.sendFailed"), "error", sessionId);
	});
}
