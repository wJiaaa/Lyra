import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { DEFAULT_SETTINGS } from "@lyra/core";
import { definitionTrashTarget } from "../electron/definition-trash.ts";

let root: string;
let project: string;
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LYRA_HOME: process.env.LYRA_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
before(async () => {
	root = await mkdtemp(join(tmpdir(), "lyra-definition-trash-"));
	project = join(root, "project");
	process.env.HOME = root; process.env.USERPROFILE = root;
	process.env.LYRA_HOME = join(root, "profile"); process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
	await mkdir(project);
});
after(async () => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});
async function file(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); return path; }

test("commands resolve the exact loaded file, including namespace and same-name precedence", async () => {
	const local = await file(join(project, ".lyra", "commands", "git", "review.md"), "project review");
	const personal = await file(join(root, "profile", "commands", "git", "review.md"), "personal review");
	assert.equal(await definitionTrashTarget("command", project, local, DEFAULT_SETTINGS), local);
	await assert.rejects(definitionTrashTarget("command", project, personal, DEFAULT_SETTINGS), /不存在/);
	await rm(local);
	assert.equal(await definitionTrashTarget("command", project, personal, DEFAULT_SETTINGS), personal);
	assert.equal(await readFile(personal, "utf8"), "personal review");
	await assert.rejects(definitionTrashTarget("command", project, local, DEFAULT_SETTINGS), /不存在/);
});

test("loose skills include their resources, and symlinks resolve to the link rather than its target", async () => {
	const dir = join(project, ".lyra", "skills", "loose");
	const skill = await file(join(dir, "SKILL.md"), "---\nname: loose\ndescription: A sufficiently detailed reusable workflow for testing local skill removal.\n---\nSteps");
	await file(join(dir, "scripts", "check.py"), "print('ok')");
	assert.equal(await definitionTrashTarget("skill", project, skill, DEFAULT_SETTINGS), dir);
	const shared = join(root, "shared-skill");
	await file(join(shared, "SKILL.md"), "---\nname: shared\ndescription: A shared skill used to verify that a directory link never deletes its original.\n---\nSteps");
	const link = join(project, ".lyra", "skills", "linked");
	await symlink(shared, link, process.platform === "win32" ? "junction" : "dir");
	assert.equal(await definitionTrashTarget("skill", project, join(link, "SKILL.md"), DEFAULT_SETTINGS), link);
	await rm(link);
	assert.match(await readFile(join(shared, "SKILL.md"), "utf8"), /shared/);
});

test("plugin files, unknown kinds and unrelated paths are rejected", async () => {
	const outside = await file(join(root, "important.md"), "keep");
	const plugin = await file(join(project, ".lyra", "plugins", "bundle", "skills", "test", "SKILL.md"), "---\nname: test\ndescription: Plugin skill that is managed as part of its own bundle, never independently.\n---\nKeep");
	for (const kind of ["command", "skill"]) await assert.rejects(definitionTrashTarget(kind, project, outside, DEFAULT_SETTINGS));
	await assert.rejects(definitionTrashTarget("skill", project, plugin, DEFAULT_SETTINGS));
	await assert.rejects(definitionTrashTarget("other", project, outside, DEFAULT_SETTINGS));
	await assert.rejects(definitionTrashTarget("command", null, outside, DEFAULT_SETTINGS));
	assert.equal(await readFile(outside, "utf8"), "keep");
});
