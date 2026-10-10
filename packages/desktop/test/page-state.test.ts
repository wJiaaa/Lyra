/**
 * What a page an agent made keeps, and what of it the model is told (`store/page-state.ts`).
 *
 * The rule under test is the one that keeps this quiet: only what the reader changed is told, once,
 * with the next thing they say — a page saving its own defaults as it loads is not news to the model.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
	localStorage: {
		get length() { return store.size; },
		key: (index: number) => [...store.keys()][index] ?? null,
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, String(value)),
		removeItem: (key: string) => void store.delete(key),
	},
});

const { markPageStatePending, readPageState, savePageState, takePageStates } = await import("../src/store/page-state.ts");
const { MAX_PAGE_STATE } = await import("../shared/preview.ts");

beforeEach(() => store.clear());

test("a page gets back what it saved, per conversation and page", () => {
	assert.equal(readPageState("s1", "p1"), null);
	assert.equal(savePageState("s1", "p1", "播放器", '{"volume":40}', false), "changed");
	assert.deepEqual(readPageState("s1", "p1"), { volume: 40 });
	assert.equal(readPageState("s1", "p2"), null);
	assert.equal(readPageState("s2", "p1"), null);
});

test("what the page saves on its own is kept but not told", () => {
	savePageState("s1", "p1", "播放器", '{"volume":40}', false);
	assert.equal(takePageStates("s1"), "");
});

test("what the reader changed is told once, with the page's title", () => {
	savePageState("s1", "p1", "播放器", '{"volume":40}', false);
	savePageState("s1", "p1", "播放器", '{"volume":72}', true);
	assert.equal(takePageStates("s1"), '<page-state page="播放器">{"volume":72}</page-state>');
	assert.equal(takePageStates("s1"), "", "told already");
	// Setting it back to the same value is not a change.
	assert.equal(savePageState("s1", "p1", "播放器", '{"volume":72}', true), "same");
	assert.equal(takePageStates("s1"), "");
});

test("a later save by the page does not take back a change the reader made", () => {
	savePageState("s1", "p1", "播放器", '{"volume":72}', true);
	savePageState("s1", "p1", "播放器", '{"volume":72,"seen":1}', false);
	assert.equal(takePageStates("s1"), '<page-state page="播放器">{"volume":72,"seen":1}</page-state>');
});

test("a change saved before the reader was known to be behind it is theirs once marked", () => {
	assert.equal(savePageState("s1", "p1", "播放器", '{"volume":72}', false), "changed");
	markPageStatePending("s1", "p1");
	assert.match(takePageStates("s1"), /"volume":72/);
});

test("only this conversation's pages are told", () => {
	savePageState("s1", "p1", "a", "1", true);
	savePageState("s2", "p1", "b", "2", true);
	assert.equal(takePageStates("s1"), '<page-state page="a">1</page-state>');
	assert.equal(takePageStates("s2"), '<page-state page="b">2</page-state>');
});

test("too much, or not JSON, is not kept", () => {
	assert.equal(savePageState("s1", "p1", "a", JSON.stringify("x".repeat(MAX_PAGE_STATE)), true), false);
	assert.equal(savePageState("s1", "p1", "a", "{not json", true), false);
	assert.equal(readPageState("s1", "p1"), null);
});

test("the oldest pages are let go past the cap", () => {
	for (let i = 0; i < 205; i++) store.set(`ly-preview-state:old/p${i}`, JSON.stringify({ title: "", value: i, at: i, pending: false }));
	savePageState("s1", "new", "a", "1", false);
	assert.equal(store.size, 200);
	assert.equal(readPageState("old", "p0"), null);
	assert.deepEqual(readPageState("s1", "new"), 1);
});
