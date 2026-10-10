/**
 * What the reader set in an interface block, kept across reloads.
 *
 * A block is drawn again every time its conversation is opened, and a form that comes back empty
 * after a restart is a form whose answers were thrown away — the first of the problems the
 * reverse-engineered ChatGPT renderer has. Kept by the block's own text within its session: the same
 * reply is the same block, and a block edited into something else starts over, as it should.
 *
 * One entry in `localStorage` for all of them, the most recently used first, and only so many: these
 * are a convenience, and a convenience must not grow without end.
 */

const KEY = "ly-interface-state";
const KEEP = 200;

/** The last thing a `send` button said from the block, and what was set when it did. */
interface Sent {
	words: string;
	values: Record<string, unknown>;
}

export interface BlockState {
	values: Record<string, unknown>;
	sent?: Sent;
	/**
	 * The open tab of each `Tabs` without a `name`, by its titles. Not in `values`: those go to the
	 * model with every `send`, and which tab the reader was looking at is not something they said.
	 */
	tabs?: Record<string, string>;
}

/** Entries written before `sent` existed have no third member, and read as never sent; `sent` is null when only `tabs` follows it. */
type Saved = [key: string, values: Record<string, unknown>, sent?: Sent | null, tabs?: Record<string, string>][];

/** FNV-1a: short, stable, and enough to tell blocks apart within one session. */
function hash(text: string): string {
	let value = 0x811c9dc5;
	for (let at = 0; at < text.length; at++) {
		value ^= text.charCodeAt(at);
		value = Math.imul(value, 0x01000193);
	}
	return (value >>> 0).toString(36);
}

export function stateKey(sessionId: string | null, source: string): string {
	return `${sessionId ?? ""}:${hash(source)}`;
}

function read(): Saved {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
		return Array.isArray(saved) ? (saved as Saved) : [];
	} catch {
		return [];
	}
}

export function recall(key: string): BlockState {
	const found = read().find(([at]) => at === key);
	return found ? { values: found[1] ?? {}, ...(found[2] ? { sent: found[2] } : {}), ...(found[3] ? { tabs: found[3] } : {}) } : { values: {} };
}

export function remember(key: string, state: BlockState): void {
	const rest = read().filter(([at]) => at !== key);
	const entry: Saved[number] = state.tabs ? [key, state.values, state.sent ?? null, state.tabs] : state.sent ? [key, state.values, state.sent] : [key, state.values];
	try {
		localStorage.setItem(KEY, JSON.stringify([entry, ...rest].slice(0, KEEP)));
	} catch {
		// Storage full or unavailable: the block still works, it just will not remember.
	}
}
