/**
 * Switching a plugin on and off, which is not the set operation it looks like.
 *
 * The wildcard makes it awkward, and getting it wrong produces a switch that reports a change and
 * produces none, with the plugin still off after a reload. `disabledPlugins: ["*"]` means "none of
 * them", and turning one back on has to name what the wildcard stood for rather than just deleting
 * an id that was never in the list.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plugin, Settings } from "@plume/core";

import { settingsAfterToggle } from "../src/features/plugins/toggle.ts";

function plugin(id: string): Plugin {
	return {
		id,
		dir: `/home/me/.plume/plugins/${id}`,
		manifest: { name: id },
		source: "user",
		skills: [],
		enabled: true,
	};
}

function settings(disabledPlugins: string[]): Settings {
	return { disabledPlugins } as Settings;
}

const WAZA = plugin("waza");
const OTHER = plugin("context7");

test("switching off adds the directory name", () => {
	const next = settingsAfterToggle(settings([]), WAZA, false, [WAZA, OTHER]);
	assert.deepEqual(next.disabledPlugins, ["waza"]);
});

test("switching on removes it", () => {
	const next = settingsAfterToggle(settings(["waza", "context7"]), WAZA, true, [WAZA, OTHER]);
	assert.deepEqual(next.disabledPlugins, ["context7"]);
});

test("switching one on under a wildcard names everything the wildcard stood for", () => {
	/*
	 * The case the whole function exists for. Deleting `waza` from a list that does not contain it
	 * and leaving `*` in place is a no-op that looks like a change.
	 */
	const next = settingsAfterToggle(settings(["*"]), WAZA, true, [WAZA, OTHER]);
	assert.equal(next.disabledPlugins.includes("*"), false);
	assert.equal(next.disabledPlugins.includes("waza"), false);
	assert.equal(next.disabledPlugins.includes("context7"), true);
});

test("switching one off under a wildcard leaves the wildcard alone", () => {
	// It is already off. Expanding the wildcard here would be rewriting the user's setting to say
	// the same thing at greater length, and would stop meaning "whatever is installed".
	const next = settingsAfterToggle(settings(["*"]), WAZA, false, [WAZA, OTHER]);
	assert.equal(next.disabledPlugins.includes("*"), true);
});

test("the rest of the settings are carried through untouched", () => {
	const before = { disabledPlugins: [], theme: "dark" } as unknown as Settings;
	const next = settingsAfterToggle(before, WAZA, false, [WAZA]);
	assert.equal((next as unknown as { theme: string }).theme, "dark");
	// And the original is not mutated: the store compares by identity to decide what to re-render.
	assert.deepEqual(before.disabledPlugins, []);
});
