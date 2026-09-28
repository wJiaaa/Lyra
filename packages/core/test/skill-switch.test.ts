/**
 * 技能开关：`disabledSkills` 里记着的 SKILL.md，会话里没有，`/` 菜单里也没有。
 *
 * 两处接线各验一次——会话走 `loadCapabilities`，菜单走 `listCommands`，摘掉任何一处的过滤都得变红。
 * 符号链接那条也在这里：`.claude/skills/x` 链到 `.agents/skills/x` 是常见布局，设置里记的是真实
 * 路径，生效的却是链接那份，照样要关掉；而且被它盖住的 `.agents` 那份不能顶上来。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { listCommands } from "../src/commands/catalogue.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import type { SessionMeta } from "../src/session/store.ts";
import type { SessionStorage } from "../src/session/storage.ts";

let home: string;
let root: string;

const META = { id: "s1", projectId: "p", cwd: "", modelId: "m", title: "", createdAt: 0, updatedAt: 0 } as unknown as SessionMeta;
const STORE = { append: async (meta: SessionMeta) => meta, create: async () => META } as unknown as SessionStorage;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "ly-skill-switch-home-"));
	root = await mkdtemp(join(tmpdir(), "ly-skill-switch-"));
	process.env.LYRA_HOME = home;
});

after(async () => {
	delete process.env.LYRA_HOME;
	await rm(home, { recursive: true, force: true });
	await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, name: string): Promise<void> {
	await mkdir(join(dir, name), { recursive: true });
	await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: 一个用来看开关有没有生效的技能，描述写够四十个字免得触发提醒\n---\n正文\n`, "utf8");
}

test("关掉的技能进不了会话和 / 菜单，符号链接的另一个路径同样算数", async () => {
	const cwd = join(root, "project");
	await skill(join(cwd, ".lyra", "skills"), "keep");
	await skill(join(cwd, ".lyra", "skills"), "off");
	await skill(join(cwd, ".agents", "skills"), "linked");
	await mkdir(join(cwd, ".claude", "skills"), { recursive: true });
	await symlink(join(cwd, ".agents", "skills", "linked"), join(cwd, ".claude", "skills", "linked"));

	const settings: Settings = {
		...DEFAULT_SETTINGS,
		disabledSkills: [join(cwd, ".lyra", "skills", "off", "SKILL.md"), join(cwd, ".agents", "skills", "linked", "SKILL.md")],
	};
	const session = new AgentSession({ cwd, settings, store: STORE, meta: { ...META, cwd }, emit: async () => {} });
	await session.initialize();
	const inSession = new Set(session.can.skills.map((s) => s.name));
	assert.ok(inSession.has("keep"), "开着的照常在");
	assert.ok(!inSession.has("off"), "关掉的不进会话");
	assert.ok(!inSession.has("linked"), "按真实路径关掉，链接那份也不在；被盖住的 .agents 那份也没顶上来");

	const menu = new Set((await listCommands(cwd, settings, [])).skills.map((s) => s.name));
	assert.ok(menu.has("keep"));
	assert.ok(!menu.has("off") && !menu.has("linked"), "菜单和会话一致");

	const all = new Set((await listCommands(cwd, { ...settings, disabledSkills: [] }, [])).skills.map((s) => s.name));
	assert.ok(all.has("off") && all.has("linked"), "对照：不关的时候它们都在");
});
