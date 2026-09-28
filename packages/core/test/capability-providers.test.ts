/**
 * The shipped providers against real directories.
 *
 * Every assertion here is about a layout on disk producing a particular list, so the layouts are
 * real. A fixture that hands back a prepared array would be testing the array.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createRegistry } from "../src/capability/index.ts";
import { pluginProvider } from "../src/capability/providers/plugins.ts";
import type { Plugin } from "../src/plugins/loader.ts";
import type { Skill } from "../src/skills/loader.ts";
import type { AgentDefinition } from "../src/tools/task.ts";

let root: string;
let project: string;
let home: string;
let userHome: string;

async function put(path: string, body: string): Promise<void> {
	const full = join(root, path);
	await mkdir(join(full, ".."), { recursive: true });
	await writeFile(full, body);
}

function registry() {
	return createRegistry({ home, userHome, repoRoot: () => project });
}

before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-cap-"));
	project = join(root, "project");
	home = join(root, "plume-home");
	userHome = join(root, "user-home");

	// Our own directories.
	await put("project/.plume/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: 我们的部署技能\n---\n正文");
	await put("project/.plume/commands/review.md", "---\ndescription: 我们的审查\n---\n审查改动");
	await put("project/.plume/agents/general.md", "---\nname: general\ndescription: 覆盖内置的 general\n---\n我是自定义的。");
	await put("project/.plume/agents/boss.md", "---\nname: boss\ndescription: 编排者\nspawns: \"*\"\nmax-turns: 25\n---\n派活。");
	await put(
		"project/.plume/agents/lead.md",
		"---\nname: lead\ndescription: 组长\nspawns: [scout, reviewer]\nschema-mode: strict\nmaxTurns: 0\noutput:\n  type: object\n  properties:\n    where:\n      type: string\n---\n带队。",
	);

	// Claude Code's, one of which collides with ours.
	await put("project/.claude/commands/review.md", "---\ndescription: Claude 的审查\n---\n别的内容");
	await put("project/.claude/commands/security.md", "---\ndescription: 安全审查\n---\n查注入");
	await put("project/.claude/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: 读 PDF\n---\n正文");
});

after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

test("a custom agent replaces the built-in of the same name", async () => {
	/*
	 * The bug this closes: agents were assembled `[...BUILTIN_AGENTS, ...custom]` and read with
	 * `.find()`, so a `general` written into `.plume/agents/` was found second and never used. The
	 * file loaded, appeared in listings, and did nothing.
	 */
	const result = await registry().load<AgentDefinition>("agent", { cwd: project });

	const general = result.items.filter((a) => a.name === "general");
	assert.equal(general.length, 1, "there is exactly one `general`");
	assert.equal(general[0].provenance.provider, "native", "and it is the one on disk");
	assert.equal(general[0].description, "覆盖内置的 general");

	const shadowed = result.all.find((a) => a.name === "general" && a.provenance.provider === "builtin");
	assert.ok(shadowed, "the built-in is still listed");
	assert.equal(shadowed.shadowedBy?.provider, "native", "and says who replaced it");
});

test("an agent file can say whom it dispatches and what it must return", async () => {
	/*
	 * `spawns`, `output` and `schemaMode` were declared on the type, enforced in `runSubAgent`
	 * and tested with definitions built in memory — and never read from a file. No definition
	 * anyone could write was able to delegate or to promise an object, so the lineage the pane
	 * draws and the schema-rendered reply could not occur outside a test.
	 */
	const result = await registry().load<AgentDefinition>("agent", { cwd: project });
	const boss = result.items.find((a) => a.name === "boss");
	const lead = result.items.find((a) => a.name === "lead");
	const general = result.items.find((a) => a.name === "general");
	assert.ok(boss && lead && general);
	assert.equal(boss.spawns, "*");
	assert.deepEqual(lead.spawns, ["scout", "reviewer"], "a list is a list, not a switch");
	assert.equal(lead.schemaMode, "strict", "`schema-mode` reaches the camelCase field");
	assert.equal(lead.output?.type, "object");
	assert.deepEqual(Object.keys((lead.output as { properties: Record<string, unknown> }).properties), ["where"]);
	assert.equal(general.spawns, undefined, "the default stays: nobody dispatches unless the file says so");
	assert.equal(general.output, undefined);
	// 检查点间隔：`max-turns` 读成 camelCase；写成 0 这种没法用的数就当没写，而不是让它每一轮都被叫停。
	assert.equal(boss.maxTurns, 25, "`max-turns` reaches the camelCase field");
	assert.equal(lead.maxTurns, undefined, "a checkpoint of zero rounds is a typo, not a setting");
	assert.equal(general.maxTurns, undefined, "unset means the default checkpoint");
});

test("schema-mode and max-turns may be camelCase too, and the hyphenated one wins when both are written", async () => {
	/*
	 * The rule skills and commands follow. Agents read only the camelCase alias, and `normalizeKeys`
	 * leaves an explicitly written camelCase key holding its own value, so an agent that wrote both
	 * got the camelCase one. Both key orders, because YAML order is the author's accident.
	 */
	await put("project/.plume/agents/camel-only.md", "---\nschemaMode: permissive\nmaxTurns: 7\n---\nBody.");
	await put(
		"project/.plume/agents/both-hyphen-first.md",
		"---\nschema-mode: strict\nschemaMode: permissive\nmax-turns: 12\nmaxTurns: 40\n---\nBody.",
	);
	await put(
		"project/.plume/agents/both-camel-first.md",
		"---\nschemaMode: permissive\nschema-mode: strict\nmaxTurns: 40\nmax-turns: 12\n---\nBody.",
	);

	const result = await registry().load<AgentDefinition>("agent", { cwd: project });
	const [camelOnly, hyphenFirst, camelFirst] = ["camel-only", "both-hyphen-first", "both-camel-first"].map((name) =>
		result.items.find((a) => a.name === name),
	);
	assert.ok(camelOnly && hyphenFirst && camelFirst);
	assert.equal(camelOnly.schemaMode, "permissive", "the camelCase spelling is read");
	assert.equal(camelOnly.maxTurns, 7);
	assert.equal(hyphenFirst.schemaMode, "strict", "the hyphenated spelling decides");
	assert.equal(hyphenFirst.maxTurns, 12);
	assert.equal(camelFirst.schemaMode, "strict", "wherever it sits in the file");
	assert.equal(camelFirst.maxTurns, 12);
});

test("the other built-in agents are untouched", async () => {
	const result = await registry().load<AgentDefinition>("agent", { cwd: project });
	assert.ok(result.items.length > 1, "replacing one does not drop the rest");
	assert.ok(result.items.some((a) => a.provenance.provider === "builtin"), "the ones nobody overrode are still ours");
});

test("our command wins a name collision with Claude Code's, and the loser names the winner", async () => {
	const result = await registry().load<{ name: string; description: string }>("command", { cwd: project });

	const review = result.items.filter((c) => c.name === "review");
	assert.equal(review.length, 1);
	assert.equal(review[0].description, "我们的审查");

	const loser = result.all.find((c) => c.name === "review" && c.provenance.provider === "claude");
	assert.ok(loser, "Claude Code's copy is listed");
	assert.equal(loser.shadowedBy?.provider, "native");

	assert.ok(
		result.items.some((c) => c.name === "security"),
		"and the one with no collision is simply available",
	);
});

test("skills come from both directories", async () => {
	const result = await registry().load<Skill>("skill", { cwd: project });
	const names = result.items.map((s) => s.name).sort();
	assert.deepEqual(names, ["deploy", "pdf"]);
	assert.equal(result.items.find((s) => s.name === "pdf")?.provenance.provider, "claude");
});

test("a plugin's skill is labelled with that plugin and where it is installed", async () => {
	const bundle = (id: string, source: Plugin["source"], displayName?: string) => ({
		id,
		source,
		manifest: { name: id, ...(displayName ? { interface: { displayName } } : {}) },
		skills: [{ name: `${id}-skill`, path: join(root, id, "SKILL.md") } as Skill],
	});
	const reg = registry();
	// The project copy of `pdf` in `.claude/skills` loses to a bundled one, and says to which.
	const pdf = bundle("pdf-tools", "workspace", "PDF 工具");
	pdf.skills.push({ name: "pdf", path: join(root, "pdf-tools", "pdf", "SKILL.md") } as Skill);
	reg.register(pluginProvider([pdf, bundle("notes", "user")], []));
	const result = await reg.load<Skill>("skill", { cwd: project });

	const meta = (name: string) => result.items.find((s) => s.name === name)?.provenance;
	assert.deepEqual([meta("pdf-tools-skill")?.providerLabel, meta("pdf-tools-skill")?.scope], ["插件「PDF 工具」", "project"]);
	assert.deepEqual([meta("notes-skill")?.providerLabel, meta("notes-skill")?.scope], ["插件「notes」", "user"]);
	const loser = result.all.find((s) => s.name === "pdf" && s.provenance.provider === "claude");
	assert.equal(loser?.shadowedBy?.providerLabel, "插件「PDF 工具」");
});

test("only: native reduces the result to our own directories", async () => {
	const result = await registry().load<{ name: string }>("command", { cwd: project, only: new Set(["native"]) });
	assert.ok(result.items.length > 0);
	assert.ok(
		result.items.every((r) => r.provenance.provider === "native"),
		"nothing else contributed",
	);
});

test("disabling a provider removes its contribution and promotes what it was hiding", async () => {
	const result = await registry().load<{ name: string }>("command", { cwd: project, disabledProviders: new Set(["native"]) });
	const review = result.items.find((r) => r.name === "review");
	assert.equal(review?.provenance.provider, "claude", "with ours switched off, Claude Code's version of that name serves");
});

test("no working directory still yields the user-level and built-in layers", async () => {
	const result = await registry().load<AgentDefinition>("agent", { cwd: null });
	assert.ok(
		result.items.every((r) => r.provenance.scope !== "project"),
		"nothing project-scoped, because there is no project",
	);
	assert.ok(result.items.some((r) => r.provenance.provider === "builtin"));
});

test("contributors and watched directories describe what actually happened", async () => {
	const result = await registry().load<{ name: string }>("command", { cwd: project });
	assert.ok(result.contributors.includes("native"));
	assert.ok(result.contributors.includes("claude"));
	assert.ok(
		result.watched.some((dir) => dir.includes(join(".plume", "commands"))),
		"the directories that produced items are the ones worth watching",
	);
});

test("a cold load of the mixed fixture stays under 150ms", async () => {
	const result = await registry().load<{ name: string }>("command", { cwd: project });
	assert.ok(result.elapsedMs < 150, `cold load took ${result.elapsedMs}ms; the slowest were ${JSON.stringify(result.timings)}`);
});
