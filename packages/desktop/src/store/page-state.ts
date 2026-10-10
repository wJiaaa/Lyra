/**
 * What a page an agent made has saved (`plume.setState` in the page), and what of it the model has
 * not been told yet.
 *
 * Two jobs. The page gets it back when it is opened again — a slider left at 12 is at 12 the next
 * time the conversation is visited, not back at the page's default. And the model gets it with the
 * reader's next message, whichever way that message is sent (the composer, or a button in a page or
 * a block, `say.ts`): a reader who sets a page up and then types "why does it peak here?" is asking
 * about the page as they left it, and the model only has the page as it wrote it.
 *
 * Only what the reader changed is told, and only once: a page saving its defaults as it loads is
 * the page the model already knows, and a state told once is in the transcript from then on.
 *
 * Kept in this window's storage, like an interface block's values (`interface-state.ts`), and capped
 * the same way.
 */

import { MAX_PAGE_STATE } from "../../shared/preview.ts";

const KEY = "ly-preview-state:";
const MAX_PAGES = 200;

interface Saved {
	title: string;
	value: unknown;
	at: number;
	/** Set by the reader and not yet told to the model. */
	pending: boolean;
}

const keyOf = (sessionId: string, pageId: string) => `${KEY}${sessionId}/${pageId}`;

function read(key: string): Saved | null {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return null;
		const saved = JSON.parse(raw) as Partial<Saved>;
		return typeof saved === "object" && saved !== null && "value" in saved ? { title: String(saved.title ?? ""), value: saved.value, at: Number(saved.at) || 0, pending: saved.pending === true } : null;
	} catch {
		return null;
	}
}

function keys(prefix: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(prefix)) found.push(key);
	}
	return found;
}

export function readPageState(sessionId: string, pageId: string): unknown {
	return read(keyOf(sessionId, pageId))?.value ?? null;
}

/**
 * `json` as the page sent it. `byReader`: the reader was using the page when it was saved — only then
 * is it something to tell the model. A save the page makes on its own keeps whatever was pending.
 * Whether it was kept, and whether it differs from what was kept before.
 */
export function savePageState(sessionId: string, pageId: string, title: string, json: string, byReader: boolean): "changed" | "same" | false {
	if (json.length > MAX_PAGE_STATE) return false;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return false;
	}
	const key = keyOf(sessionId, pageId);
	const before = read(key);
	const changed = JSON.stringify(before?.value ?? null) !== JSON.stringify(value);
	try {
		localStorage.setItem(key, JSON.stringify({ title, value, at: Date.now(), pending: (before?.pending ?? false) || (byReader && changed) } satisfies Saved));
		const all = keys(KEY);
		if (all.length > MAX_PAGES) {
			const oldest = all.map((name) => ({ name, at: read(name)?.at ?? 0 })).sort((a, b) => a.at - b.at);
			for (const { name } of oldest.slice(0, all.length - MAX_PAGES)) localStorage.removeItem(name);
		}
		return changed ? "changed" : "same";
	} catch {
		// A full or disabled store loses the state, as it would lose a block's values.
		return false;
	}
}

/** A change saved before the card knew the reader was behind it (see `PreviewCard`): theirs after all. */
export function markPageStatePending(sessionId: string, pageId: string): void {
	const key = keyOf(sessionId, pageId);
	const saved = read(key);
	if (!saved || saved.pending) return;
	try {
		localStorage.setItem(key, JSON.stringify({ ...saved, pending: true }));
	} catch {
		// Not told, as if the page had saved it on its own.
	}
}

/**
 * The states of this conversation's pages the reader changed since the model last heard, as text to
 * go after their next message — and from now on, told.
 */
export function takePageStates(sessionId: string): string {
	const told: string[] = [];
	for (const key of keys(`${KEY}${sessionId}/`)) {
		const saved = read(key);
		if (!saved?.pending) continue;
		told.push(`<page-state page=${JSON.stringify(saved.title)}>${JSON.stringify(saved.value)}</page-state>`);
		try {
			localStorage.setItem(key, JSON.stringify({ ...saved, pending: false }));
		} catch {
			// Told again next time, which is the lesser fault.
		}
	}
	return told.join("\n");
}
