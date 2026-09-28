import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, symlink, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grantArtifactRead, readableArtifact } from "../electron/readable-artifacts.ts";
test("file access grants only the exact contextual artifact, never its directory or an arbitrary file", async () => {
	const root=await mkdtemp(join(tmpdir(),"plume-artifact-access-"));
	try {
		const memory=join(root,"MEMORY.md"),secret=join(root,"settings.json");await writeFile(memory,"lesson");await writeFile(secret,"private");
		assert.equal(readableArtifact(memory),null);grantArtifactRead(memory);
		const granted=readableArtifact(memory);assert.ok(granted);
		assert.equal(await realpath(granted),await realpath(memory));assert.equal(readableArtifact(root),null);assert.equal(readableArtifact(secret),null);
		if(process.platform!=="win32") { await unlink(memory);await symlink(secret,memory);assert.equal(readableArtifact(memory),null); }
	} finally {await rm(root,{recursive:true,force:true});}
});
