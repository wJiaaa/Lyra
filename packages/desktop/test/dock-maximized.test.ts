/**
 * What full screen survives, and what ends it.
 *
 * Full screen is the tab column filling the screen, not one tab: whatever is in front of the column
 * is what fills it. So the question each of these asks is the same: after this, is the user still
 * looking at the column they chose to look at? Driven through the real store, because what matters
 * is how its actions compose — `close` calling `commit` — rather than any one of them alone.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

// The store persists through `localStorage` on every commit. Nothing here is about persistence;
// this is the smallest thing that lets the actions run outside a browser.
const store: Record<string, string> = {};
(globalThis as { window?: unknown }).window = {
	localStorage: {
		getItem: (key: string) => store[key] ?? null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
	},
	// Writes are debounced through `window.setTimeout` and flushed on `pagehide`. Neither matters
	// here — the timer runs the same write these tests are not looking at.
	setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	clearTimeout: (id: number) => clearTimeout(id),
	addEventListener: () => {},
	removeEventListener: () => {},
};

const { usePaneDock } = await import("../src/features/dock/pane-store.ts");

/** One screen's dock. Full screen is per screen — another conversation on the window is never touched. */
const S = "conversation-a";
const dock = () => usePaneDock.getState();
const full = () => dock().maximized[S] ?? false;

beforeEach(() => {
	usePaneDock.setState({ trees: {}, sizes: {}, maximized: {}, focused: {}, tab: {}, host: null });
});

test("full screen in one screen leaves another screen's dock alone", () => {
	dock().open("conversation-b", "terminal");
	dock().toggleMaximized("conversation-b");
	dock().open(S, "files");

	assert.equal(full(), false, "this screen was never maximised");
	assert.equal(dock().maximized["conversation-b"], true);
});

test("the same control enters and leaves it", () => {
	dock().open(S, "terminal");
	dock().toggleMaximized(S);
	assert.equal(full(), true);
	dock().toggleMaximized(S);
	assert.equal(full(), false);
});

test("switching tabs or opening another one stays full screen: it is the column, not a tab", () => {
	dock().open(S, "files");
	dock().open(S, "terminal");
	dock().toggleMaximized(S);

	dock().focus(S, "files");
	assert.equal(full(), true, "switching tabs");
	dock().open(S, "browser");
	assert.equal(full(), true, "the new tab is in front of the column that is filling the screen");
});

test("closing one tab leaves the column full screen; closing the last one ends it", () => {
	dock().open(S, "files");
	dock().open(S, "terminal");
	dock().toggleMaximized(S);

	dock().close(S, "terminal");
	assert.equal(full(), true, "files is still there to fill it");
	dock().close(S, "files");
	assert.equal(full(), false, "nothing left to fill the screen with");
});

test("with no panel open there is nothing to make full screen", () => {
	dock().toggleMaximized(S);
	assert.equal(full(), false);
});

test("putting a layout back ends full screen", () => {
	dock().open(S, "terminal");
	dock().toggleMaximized(S);
	dock().restoreLayout(S, dock().tree(S));
	assert.equal(full(), false);
});
