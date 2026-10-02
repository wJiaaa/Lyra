/**
 * 「用什么打开」, before it reaches the operating system.
 *
 * What is checked here is the part that has to survive a settings file written on a different
 * machine: an id this one does not know, a platform that has none of the applications the other
 * one had.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATES, resolveTargetId, revealLabel } from "../electron/open-target-ids.ts";

test("nothing stored is revealing, which every platform can do", () => {
	assert.equal(resolveTargetId(undefined), "reveal");
	assert.equal(resolveTargetId(""), "reveal");
	assert.equal(resolveTargetId("   "), "reveal");
});

test("an id from a newer version is passed through rather than rewritten", () => {
	// `openWith` hands anything it does not recognise to the system's default handler.
	assert.equal(resolveTargetId("helix"), "helix");
});

test("the file manager is named in this platform's own words", () => {
	assert.equal(revealLabel("darwin"), "访达");
	assert.equal(revealLabel("win32"), "资源管理器");
	assert.equal(revealLabel("linux"), "文件管理器");
	// A platform nobody has heard of still gets a sentence that makes sense.
	assert.equal(revealLabel("aix"), "文件管理器");
});

test("every platform can open a file with something, and a terminal is never the only offer", () => {
	for (const [platform, candidates] of Object.entries(CANDIDATES)) {
		assert.ok(candidates.some((entry) => entry.kind === "app"), `${platform} offers no application`);
	}
});

test("each candidate says how it can be found on its own platform", () => {
	for (const entry of CANDIDATES.darwin) assert.ok(entry.appName, `${entry.id} has no bundle name`);
	for (const entry of CANDIDATES.win32) {
		assert.ok(entry.windows?.length || entry.command, `${entry.id} has neither a path nor a command`);
	}
	for (const entry of CANDIDATES.linux) assert.ok(entry.command, `${entry.id} has no command`);
});

test("ids are unique within a platform, since settings store exactly one of them", () => {
	for (const [platform, candidates] of Object.entries(CANDIDATES)) {
		const ids = candidates.map((entry) => entry.id);
		assert.equal(new Set(ids).size, ids.length, `${platform} repeats an id`);
	}
});
