/**
 * Everything a session has to load before it can do anything.
 *
 * Plugins, skills, sub-agent definitions, MCP servers and the tools they contribute. Separate from
 * the session because it is a pure "read the world and report what is there" step — which is what
 * makes it possible to re-run after settings change without touching anything else.
 *
 * Precedence used to be the theme here, and now it is not. Which directories are read and who wins
 * a name collision belong to `capability/`, where the rule is written once instead of once per
 * loader — five copies of "most specific wins" had drifted apart in exactly the ways you would
 * expect, and one of them had the comparison backwards. What is left in this file is assembly.
 */

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRegistry, type CapabilityRegistry } from "../capability/index.ts";
import { pluginProvider } from "../capability/providers/plugins.ts";
import type { Settings } from "../config/settings.ts";
import { McpManager, type McpServerStatus } from "../mcp/client.ts";
import { loadPlugins, type Plugin, type PluginDiagnostic } from "../plugins/loader.ts";
import { type Skill, type SkillDiagnostic } from "../skills/loader.ts";
import { registeredSkills } from "../skills/registry.ts";
import { plumeHome } from "../session/store.ts";
import { builtinTools } from "../tools/index.ts";
import type { AgentDefinition } from "../tools/task.ts";
import type { Tool } from "../types.ts";

export interface LoadedCapabilities {
	plugins: Plugin[];
	pluginDiagnostics: PluginDiagnostic[];
	skills: Skill[];
	skillDiagnostics: SkillDiagnostic[];
	agents: AgentDefinition[];
	mcpStatuses: McpServerStatus[];
	tools: Tool[];
	/** 这次加载实际读过的目录，用来建立监听。 */
	watched: string[];
}

/**
 * Every skill this project can use, in precedence order, with the diagnostics from reading them.
 *
 * Its own function because two things need the same answer and must not compute it twice: the
 * session, which hands the list to the model, and the composer's slash menu, which offers the same
 * skills to the user. A menu built from a second, slightly different walk of the same directories
 * is a menu that offers something the agent does not have.
 *
 * Precedence, most specific first: a loose skill in the project beats a bundled one of the same
 * name — dropping a directory next to a plugin is how you override it — and both beat one provided
 * by code, because what the user put on disk is the most specific statement of intent in the room.
 */
export async function collectSkills(
	cwd: string,
	plugins: Plugin[],
	settings?: Pick<Settings, "capabilityPreferences">,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[]; shadowed: ShadowedSkill[] }> {
	const result = await sessionRegistry(plugins).load<Skill>("skill", { cwd, preferred: preferredSources(settings) });
	/*
	 * The losers, for the settings page.
	 *
	 * "Why is the skill I wrote not running" is the question that page exists to answer, and it
	 * cannot be answered from the winners alone — a shadowed skill is absent from the list, which
	 * looks exactly like one that failed to load or was never found.
	 */
	const shadowed = result.all
		.filter((item): item is typeof item & { shadowedBy: NonNullable<typeof item.shadowedBy> } => item.shadowedBy !== undefined)
		.map((item) => ({
			name: item.name,
			path: item.provenance.path,
			by: item.shadowedBy.path,
			byLabel: item.shadowedBy.providerLabel,
		}));
	/*
	 * `severity` 要带过去。设置页按它把「没加载」和「加载了但描述太短」分成两段——剥掉它，
	 * 一条 warning 就混进「N 个技能未能加载」那句话里，而那句话数的正是没加载的。
	 */
	return {
		skills: result.items,
		diagnostics: result.diagnostics.map((d) => ({ path: d.path, message: d.message, ...(d.severity === "warning" ? { severity: "warning" as const } : {}) })),
		shadowed,
	};
}

/**
 * 这份技能是被 `disabledSkills` 里哪一条关掉的，没关就是 `undefined`。
 *
 * 路径和真实路径都比：`~/.claude/skills/x` 常常是链到 `~/.agents/skills/x` 的符号链接，
 * 设置里记的是哪一种形态，另一种都得认——同一个 SKILL.md 不能因为换了个路径就绕过开关。
 * 返回命中的那一条，好让设置页打开时删掉的正是它。
 */
export async function disabledSkillMatcher(disabledSkills: readonly string[]): Promise<(path: string) => Promise<string | undefined>> {
	const real = (path: string) => realpath(path).catch(() => path);
	const entries = new Map<string, string>();
	for (const entry of disabledSkills) {
		entries.set(entry, entry);
		entries.set(await real(entry), entry);
	}
	return async (path) => (entries.size === 0 ? undefined : (entries.get(path) ?? entries.get(await real(path))));
}

/**
 * 去掉设置里关掉的技能。会话和 `/` 菜单都经过这里；设置页和删除用的是 `collectSkills` 的全量，
 * 关掉的也得列出来，人才能再打开它。
 *
 * 在分胜负之后过滤：关掉的是这个名字当前生效的那一份，被它盖住的同名副本不会顶上来——
 * 否则设置页上显示的那份和会话实际用的那份就对不上了。
 */
export async function withoutDisabledSkills<T extends { path: string }>(skills: T[], settings: Pick<Settings, "disabledSkills">): Promise<T[]> {
	if (settings.disabledSkills.length === 0) return skills;
	const match = await disabledSkillMatcher(settings.disabledSkills);
	const off = await Promise.all(skills.map((skill) => match(skill.path)));
	return skills.filter((_, index) => off[index] === undefined);
}

/** Menu candidates use the runtime registry, including project overrides and configured precedence. */
export async function collectAgents(cwd: string, settings?: Pick<Settings, "capabilityPreferences">): Promise<AgentDefinition[]> {
	const result = await sessionRegistry([]).load<AgentDefinition>("agent", { cwd, preferred: preferredSources(settings) });
	return result.items;
}

/**
 * 「改用那个」写下的偏好：`kind:name` → 该赢的那个文件。
 *
 * 每个读能力的入口都要传——少传一处，那处就安静地按默认优先级来，而设置页上明明写着「已改用」。
 */
function preferredSources(settings: Pick<Settings, "capabilityPreferences"> | undefined): ReadonlyMap<string, string> {
	return new Map(Object.entries(settings?.capabilityPreferences ?? {}));
}

/** A skill that was found and lost, with what beat it. */
export interface ShadowedSkill {
	name: string;
	/** Where the losing copy is. */
	path: string;
	/** Where the winning copy is. */
	by: string;
	/** Which source the winner came from, in words. */
	byLabel: string;
}

/**
 * A registry for this session, with the plugin provider bound to what this session loaded.
 *
 * Built per call rather than held in a module because what it supplies is session state: two
 * windows on two projects have different plugins enabled, and a shared registry would give one
 * window the other's.
 */
function sessionRegistry(plugins: Plugin[]): CapabilityRegistry {
	const registry = createRegistry({ home: plumeHome(), userHome: homedir() });
	registry.register(
		pluginProvider(
			plugins.filter((plugin) => plugin.enabled),
			registeredSkills(),
		),
	);
	return registry;
}

/** Load skills, agents and MCP tools. Safe to call again after settings change. */
export async function loadCapabilities(
	cwd: string,
	settings: Settings,
	mcp: McpManager,
	extraTools: Tool[],
): Promise<LoadedCapabilities> {
	const loadedPlugins = await loadPlugins(
		[
			{ dir: join(cwd, ".plume", "plugins"), source: "workspace" as const },
			{ dir: join(plumeHome(), "plugins"), source: "user" as const },
			/*
			 * Where MCP bundles live once installed. Read here as well because a bundle is sorted
			 * by its contents rather than its location — one that predates the split, or was put
			 * in by hand, is found either way, and only its `origin` cares which directory it is in.
			 */
			{ dir: join(plumeHome(), "mcp"), source: "user" as const },
		],
		settings.disabledPlugins,
	);
	const plugins = loadedPlugins.plugins;
	const pluginDiagnostics = loadedPlugins.diagnostics;

	const registry = sessionRegistry(plugins);

	const skillResult = await registry.load<Skill>("skill", { cwd, preferred: preferredSources(settings) });
	const skills = await withoutDisabledSkills(skillResult.items, settings);
	const skillDiagnostics = skillResult.diagnostics.map((d) => ({ path: d.path, message: d.message }));

	/*
	 * Agents through the registry, which is where the precedence defect gets fixed.
	 *
	 * The old line was `[...BUILTIN_AGENTS, ...custom]` consumed with `.find()`, so a definition
	 * written to replace a built-in of the same name was found second and never used — the file
	 * loaded, appeared in listings, and did nothing. Built-ins now arrive from a provider with a
	 * priority of 1 and lose by name like anything else.
	 */
	const agentResult = await registry.load<AgentDefinition>("agent", { cwd, preferred: preferredSources(settings) });
	const agents = agentResult.items;

	/*
	 * Settings is the only place a session reads MCP servers from.
	 *
	 * Plugins used to contribute their own, which is how the same server ended up configured in
	 * two places at once — the MCP settings page could not see the plugin's copy, and the plugin
	 * could not see the user's. Installing an MCP bundle now writes into settings, so this is one
	 * list, and what is on the page is what the session connects to.
	 */
	const mcpStatuses = await mcp.connectAll(settings.mcpServers);
	const tools = [...builtinTools(), ...extraTools, ...mcp.allTools()];

	/*
	 * 实际读过的目录，交给监听器。
	 *
	 * 这份名单一直被收集着——每个 provider 都老老实实地报了 `watched`，注册表也把它们合起来了
	 * ——而 `LoadedCapabilities` 从来没带上它，所以谁也拿不到。收集原料收集了很久，工厂一直
	 * 没建。
	 *
	 * 只监听**贡献过条目的目录**，不是所有可能的位置：后者是几十个 watcher，而其中绝大多数
	 * 指向的目录在这台机器上根本不存在。
	 */
	const watched = [...new Set([...skillResult.watched, ...agentResult.watched])];

	return { plugins, pluginDiagnostics, skills, skillDiagnostics, agents, mcpStatuses, tools, watched };
}
