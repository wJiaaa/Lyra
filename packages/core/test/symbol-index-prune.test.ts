import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadIndex, pruneIndexes, saveIndex } from "../src/index/symbols.ts";

test("an index whose directory is gone is removed; one still in use stays", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "ly-index-prune-"));
	const previous = process.env.PLUME_HOME;
	process.env.PLUME_HOME = join(root, "home");
	t.after(async () => {
		if (previous === undefined) delete process.env.PLUME_HOME;
		else process.env.PLUME_HOME = previous;
		await rm(root, { recursive: true, force: true });
	});
	// A quote in the path: the directory is read back out of the JSON, not matched as raw text.
	const kept = join(root, 'project "a"');
	const gone = join(root, "worktree-b");
	await mkdir(kept);
	await saveIndex({ cwd: kept, builtAt: 1, fileCount: 0, symbols: [], skipped: 0 });
	await saveIndex({ cwd: gone, builtAt: 1, fileCount: 0, symbols: [], skipped: 0 });

	assert.equal(await pruneIndexes(), 1);
	assert.equal((await readdir(join(root, "home", "index"))).length, 1);
	assert.ok(await loadIndex(kept));
});
