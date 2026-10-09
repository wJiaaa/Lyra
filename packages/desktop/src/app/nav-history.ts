/**
 * Back and forward for the workspace window: recording where it has been, and going there again.
 *
 * Recorded by watching the store rather than by every caller announcing a move. A conversation is
 * opened from the sidebar, a notification, a search result, a split screen and a dozen places more,
 * and a history that depended on each of them remembering to say so would be a history with holes in
 * it. The rules — what is the same place, what a step passes over — are `lib/nav-history.ts`.
 */

import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { EMPTY_HISTORY, record, sameEntry, step, type NavEntry, type NavHistory, type NavSnapshot } from "../lib/nav-history.ts";
import { useApp } from "../store/index.ts";

const useNavHistory = create<NavHistory>(() => EMPTY_HISTORY);

function here(): NavEntry {
	const { view, activeSessionId } = useApp.getState();
	return { view, sessionId: activeSessionId };
}

function snapshot(): NavSnapshot {
	const { activeSessionId, sessions, sessionCache } = useApp.getState();
	return { activeSessionId, exists: (id) => sessions.some((session) => session.id === id) || Boolean(sessionCache[id]) };
}

/**
 * Set while a press of back or forward is landing.
 *
 * The store changes that arrive meanwhile are that move, not a new visit — recording them would cut
 * off everything ahead, and forward would never have anywhere to go.
 */
let arriving = false;

async function go(direction: -1 | 1): Promise<boolean> {
	const next = step(useNavHistory.getState(), direction, snapshot());
	if (!next) return false;
	useNavHistory.setState(next.history);
	arriving = true;
	try {
		const app = useApp.getState();
		if (next.entry.view === "chat" && next.entry.sessionId && next.entry.sessionId !== app.activeSessionId) {
			await app.openSessionById(next.entry.sessionId);
		}
		useApp.getState().setView(next.entry.view);
	} finally {
		arriving = false;
		// Wherever the window settled is where the history now stands, even if the open failed.
		useNavHistory.setState((history) => {
			const at = history.entries[history.index];
			const landed = here();
			return at && sameEntry(at, landed) ? history : record(history, landed);
		});
	}
	return true;
}

export const goBack = () => go(-1);
export const goForward = () => go(1);

/** Starts recording and returns the unsubscribe. Mounted once, by the workspace window's shell. */
export function watchNavHistory(): () => void {
	useNavHistory.setState(record(EMPTY_HISTORY, here()));
	return useApp.subscribe((state, previous) => {
		if (arriving || (state.view === previous.view && state.activeSessionId === previous.activeSessionId)) return;
		useNavHistory.setState((history) => record(history, here()));
	});
}

/** Whether back (`-1`) or forward (`1`) has anywhere to go — what the buttons' enabled state reads. */
export function useCanStep(direction: -1 | 1): boolean {
	const history = useNavHistory();
	const activeSessionId = useApp((state) => state.activeSessionId);
	const sessions = useApp((state) => state.sessions);
	const sessionCache = useApp((state) => state.sessionCache);
	return useMemo(
		() => step(history, direction, { activeSessionId, exists: (id) => sessions.some((session) => session.id === id) || Boolean(sessionCache[id]) }) !== null,
		[history, direction, activeSessionId, sessions, sessionCache],
	);
}

const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/**
 * ⌘[ and ⌘] on macOS, Alt+← and Alt+→ elsewhere, and the mouse's own back and forward buttons.
 *
 * Not while typing: in a text field those keys belong to the field, and leaving the conversation
 * because a word was being selected would lose the place being typed into.
 *
 * Mounted once, by the window's `Shell`, not by each view: the workspace stays mounted under
 * settings, so a listener per view would take every press twice and go back two places.
 */
export function useNavShortcuts() {
	useEffect(() => {
		const typing = (target: EventTarget | null) =>
			target instanceof HTMLElement && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA");
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || typing(event.target)) return;
			const back = mac ? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketLeft" : event.altKey && !event.ctrlKey && event.key === "ArrowLeft";
			const forward = mac ? event.metaKey && !event.altKey && !event.shiftKey && event.code === "BracketRight" : event.altKey && !event.ctrlKey && event.key === "ArrowRight";
			if (!back && !forward) return;
			event.preventDefault();
			void (back ? goBack() : goForward());
		};
		// Buttons 3 and 4 are the side buttons on a mouse; `mouseup`, so the press itself is not taken.
		const onMouse = (event: MouseEvent) => {
			if (event.button !== 3 && event.button !== 4) return;
			event.preventDefault();
			void (event.button === 3 ? goBack() : goForward());
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("mouseup", onMouse);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mouseup", onMouse);
		};
	}, []);
}
