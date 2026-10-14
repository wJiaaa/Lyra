/**
 * How far the checked-out branch is from its upstream: the `↑18 ↓2` on the branch chip under the composer.
 *
 * Read when it can have moved on its own — the project or branch changed, a turn ended (the model
 * commits), the window came back to the front (a commit or push in a terminal). The Git panel already
 * has the answer after each of its own reads, commit, push, pull and fetch included, and hands it over
 * (`noteUpstream`), so a push there shows on the chip at once without asking git again. Not on a timer:
 * nothing moves this between those moments.
 *
 * Against the remote-tracking ref as of the last fetch; this never fetches. The Git panel does, quietly,
 * when it opens.
 */

import { useCallback, useEffect, useReducer } from "react";
import { bridge } from "../../services/index.ts";

export interface UpstreamDistance {
	upstream: string;
	ahead: number;
	behind: number;
}

/** Per checkout and branch, so another conversation's chip — or a branch just switched to — is not shown this one's numbers. */
const known = new Map<string, UpstreamDistance | null>();
const listeners = new Set<(key: string) => void>();
const keyOf = (cwd: string, branch: string) => `${cwd}\0${branch}`;

/** The panel's word for it; only a change wakes the chips. */
export function noteUpstream(cwd: string, branch: string | null, distance: UpstreamDistance | null): void {
	if (!branch) return;
	const key = keyOf(cwd, branch);
	if (known.has(key) && JSON.stringify(known.get(key)) === JSON.stringify(distance)) return;
	known.set(key, distance);
	for (const listener of listeners) listener(key);
}

export function useUpstreamDistance(cwd: string | null, branch: string | null, running: boolean): UpstreamDistance | null {
	const [, changed] = useReducer((n: number) => n + 1, 0);
	const key = cwd && branch ? keyOf(cwd, branch) : null;

	const read = useCallback(async () => {
		if (!cwd || !branch) return;
		try {
			noteUpstream(cwd, branch, await bridge.git.upstream(cwd));
		} catch {
			// A read that failed says nothing about the distance; the chip keeps what it last knew.
		}
	}, [cwd, branch]);

	useEffect(() => {
		if (!key) return;
		const listener = (at: string) => {
			if (at === key) changed();
		};
		listeners.add(listener);
		return () => void listeners.delete(listener);
	}, [key]);

	// Opened, switched to, and every time a turn ends.
	useEffect(() => {
		if (!running) void read();
	}, [read, running]);

	useEffect(() => {
		if (!key) return;
		const onFocus = () => void read();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [key, read]);

	return key ? (known.get(key) ?? null) : null;
}
