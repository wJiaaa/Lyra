/**
 * 「改用那个」：一条偏好让输家赢。
 *
 * 注册表按优先级去重，同名的低优先级那份被盖掉——这是对的默认，但不是每次都对：项目里一份
 * 三个月没人动的 `pdf`，盖住了你昨天刚改好的那份。以前的出路是改名或者删文件；现在是设置页
 * 上一个按钮，写一条 `kind:name → path` 的偏好。
 *
 * 要验的是关系：被指名的那份成为赢家，原来的赢家变成输家并指着它，其它输家也改指它——设置页
 * 上的「被 X 覆盖」读的是这个字段。最后一条接线：偏好从 settings.json 出发，经 `collectSkills`
 * 到达注册表，把这段传参摘掉它必须变红。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CapabilityRegistry } from "../src/capability/registry.ts";
import type { CapabilityId, CapabilityProvider, DiscoveryContext, Sourced } from "../src/capability/types.ts";
import { collectSkills } from "../src/runtime/session-setup.ts";
import type { Settings } from "../src/types.ts";

interface Named {
	name: string;
}

function registry(): CapabilityRegistry {
	return new CapabilityRegistry({ home: "/home/.lyra", userHome: "/home", repoRoot: () => null });
}

function fake(id: string, priority: number, names: string[]): CapabilityProvider<Named> {
	return {
		id,
		label: id,
		describe: id,
		priority,
		supplies: ["skill"],
		async load(_kind: CapabilityId, _ctx: DiscoveryContext) {
			return {
				items: names.map((name) => ({ name, provenance: { provider: id, providerLabel: id, path: `/${id}/${name}.md`, scope: "project" } }) as Sourced<Named>),
			};
		},
	};
}

test("a preferred path wins the name, and everyone else points at it", async () => {
	const reg = registry();
	reg.register(fake("low", 10, ["deploy"]));
	reg.register(fake("mid", 50, ["deploy"]));
	reg.register(fake("high", 100, ["deploy"]));

	const result = await reg.load<Named>("skill", { cwd: "/p", preferred: new Map([["skill:deploy", "/low/deploy.md"]]) });

	assert.equal(result.items.length, 1, "still one winner");
	assert.equal(result.items[0].provenance.provider, "low", "the one the user named");
	const high = result.all.find((item) => item.provenance.provider === "high");
	const mid = result.all.find((item) => item.provenance.provider === "mid");
	assert.equal(high?.shadowedBy?.path, "/low/deploy.md", "the former winner is now beaten, by path");
	assert.equal(mid?.shadowedBy?.path, "/low/deploy.md", "and the other loser is repointed — it used to name `high`");
	assert.equal(result.all.filter((item) => item.name === "deploy").length, 3, "nobody dropped off the list");
	assert.equal(result.all.filter((item) => item.name === "deploy" && !item.shadowedBy).length, 1, "and exactly one is unshadowed");
});

test("a preference for a path that is not there does nothing", async () => {
	const reg = registry();
	reg.register(fake("low", 10, ["deploy"]));
	reg.register(fake("high", 100, ["deploy"]));

	const result = await reg.load<Named>("skill", { cwd: "/p", preferred: new Map([["skill:deploy", "/elsewhere/deploy.md"]]) });
	assert.equal(result.items[0].provenance.provider, "high", "default order holds");
});

test("a preference is scoped by kind: preferring a command does not touch a skill of the same name", async () => {
	const reg = registry();
	reg.register(fake("low", 10, ["deploy"]));
	reg.register(fake("high", 100, ["deploy"]));

	const result = await reg.load<Named>("skill", { cwd: "/p", preferred: new Map([["command:deploy", "/low/deploy.md"]]) });
	assert.equal(result.items[0].provenance.provider, "high");
});

test("接线：settings.json 里的偏好经 collectSkills 到达注册表，被盖掉的那份能赢回名字", async () => {
	/*
	 * 真实的形状：项目里 `.lyra/skills/` 和 `.claude/skills/` 各有一份 `deploy`，前者优先级高、
	 * 默认赢。偏好指向 `.claude` 那份，它就该成为赢家——用正文来认，那是两份唯一不同的地方。
	 */
	const root = await mkdtemp(join(tmpdir(), "lyra-prefer-"));
	const skill = async (dir: string, body: string) => {
		await mkdir(join(root, dir, "deploy"), { recursive: true });
		await writeFile(join(root, dir, "deploy", "SKILL.md"), `---\nname: deploy\ndescription: 部署\n---\n${body}\n`, "utf8");
	};
	await skill(join(".lyra", "skills"), "LYRA-COPY");
	await skill(join(".claude", "skills"), "CLAUDE-COPY");

	const base = { capabilityPreferences: {} } as unknown as Settings;
	const before = await collectSkills(root, [], base);
	assert.match(before.skills.find((item) => item.name === "deploy")?.content ?? "", /LYRA-COPY/, "by default ours wins");

	const claudePath = join(root, ".claude", "skills", "deploy", "SKILL.md");
	const after = await collectSkills(root, [], { capabilityPreferences: { "skill:deploy": claudePath } } as unknown as Settings);
	const won = after.skills.find((item) => item.name === "deploy");
	assert.ok(won, "the name is still there");
	assert.match(won.content, /CLAUDE-COPY/, "and it is the preferred one now");
});
