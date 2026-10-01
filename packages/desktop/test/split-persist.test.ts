/**
 * Conversation tiling belongs to the window, not the project under the focused chat.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { flushSplit, loadSplit, saveSplit, storageKey } from "../src/features/split/persist.ts";
import { defaultTree, firstSession, leafCount, leafOf, splitLeaf } from "../src/features/split/tree.ts";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	configurable: true,
	value: {
		getItem: (key: string) => memory.get(key) ?? null,
		setItem: (key: string, value: string) => {
			memory.set(key, value);
		},
		removeItem: (key: string) => {
			memory.delete(key);
		},
		key: (index: number) => [...memory.keys()][index] ?? null,
		get length() {
			return memory.size;
		},
	},
});
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		localStorage: globalThis.localStorage,
		addEventListener: () => {},
	},
});

const { useSplit } = await import("../src/features/split/store.ts");

function mixed() {
	let tree = splitLeaf(leafOf("proj-a"), "proj-a", "proj-b", "right")!;
	tree = splitLeaf(tree, "proj-a", "proj-c", "bottom")!;
	return tree;
}

beforeEach(() => {
	flushSplit();
	memory.clear();
	useSplit.setState({ tree: defaultTree(), focused: null, windowId: "" });
});

test("a saved tiling is keyed by the window, not the project", () => {
	const tree = mixed();
	saveSplit("primary", tree, "proj-b");
	flushSplit();
	assert.ok(memory.get(storageKey("primary")));
	assert.equal([...memory.keys()].some((key) => key.includes("/repo")), false);
	const loaded = loadSplit("primary");
	assert.equal(leafCount(loaded.tree), 3);
	assert.equal(loaded.focused, "proj-b");
});

test("hydrate keeps a live mix when the focused project changes", () => {
	const tree = mixed();
	useSplit.setState({ tree, focused: "proj-b", windowId: "primary" });
	useSplit.getState().hydrate("primary", new Set(["proj-a", "proj-b", "proj-c", "other"]));
	assert.equal(useSplit.getState().tree, tree);
	assert.equal(useSplit.getState().focused, "proj-b");
	assert.equal(firstSession(useSplit.getState().tree), "proj-a");
});

test("an empty list is the real list: every tile on a gone conversation goes", () => {
	// The split only mounts behind `ready`, so an empty list means none are left, not none arrived.
	useSplit.setState({ tree: mixed(), focused: "proj-b", windowId: "primary" });
	useSplit.getState().forgetMissing(new Set());
	assert.equal(firstSession(useSplit.getState().tree), null);
	assert.equal(useSplit.getState().focused, null);
});

test("a saved tiling of conversations that are all gone opens on a blank screen", () => {
	// Otherwise each launch said 「会话已不存在」 and the composer sent into the gone conversation.
	saveSplit("primary", leafOf("gone"), "gone");
	flushSplit();
	useSplit.getState().hydrate("primary", new Set());
	assert.equal(firstSession(useSplit.getState().tree), null);
	assert.equal(useSplit.getState().focused, null);
});

test("forgetMissing drops a conversation that is genuinely gone", () => {
	const tree = mixed();
	useSplit.setState({ tree, focused: "proj-b", windowId: "primary" });
	useSplit.getState().forgetMissing(new Set(["proj-a", "proj-c"]));
	assert.equal(leafCount(useSplit.getState().tree), 2);
	assert.equal(useSplit.getState().focused, null);
});
