import assert from "node:assert/strict";
import { test } from "node:test";
import { blankDraftKey } from "../src/lib/draft-key.ts";

test("two projects on one folder keep their unsent messages apart", () => {
	const a = blankDraftKey({ path: "/work/app", projectId: "a" }, null);
	const b = blankDraftKey({ path: "/work/app", projectId: "b" }, null);
	assert.notEqual(a, b);
});

test("a folder opened on its own keeps its draft under the folder, not under a project there", () => {
	assert.equal(blankDraftKey({ path: "/work/app" }, null), "new:folder:/work/app");
	// An older project's id is its path.
	assert.notEqual(blankDraftKey({ path: "/work/app" }, null), blankDraftKey({ path: "/work/app", projectId: "/work/app" }, null));
});

test("with no folder, the draft goes with the scratch directory", () => {
	assert.equal(blankDraftKey(null, "/tmp/chat"), "new:scratch:/tmp/chat");
	assert.equal(blankDraftKey(null, null), "new:scratch:general");
});
