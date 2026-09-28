/**
 * Skills that arrived in an installed bundle, or were registered by code.
 *
 * Unlike every other provider this one does not read a directory — the plugins are already loaded
 * by the time capabilities are collected, and re-walking their bundles would be both slower and a
 * second answer to a question that already has one. It is a factory rather than a constant for the
 * same reason: what it supplies is session state, and a module-level singleton holding session
 * state is how two windows end up sharing one project's plugins.
 *
 * Priority 90 puts it under `native`, which is the rule everywhere else too: a loose skill dropped
 * into `.plume/skills` is how you override a bundled one, and it only works if the loose copy wins.
 */

import type { Plugin } from "../../plugins/loader.ts";
import type { Skill } from "../../skills/loader.ts";
import type { CapabilityId, CapabilityProvider, DiscoveryContext, ProviderResult, Sourced } from "../types.ts";

const ID = "plugins";
const LABEL = "已安装插件";

export function pluginProvider(bundles: Pick<Plugin, "id" | "manifest" | "source" | "skills">[], registered: Skill[]): CapabilityProvider<Skill> {
	return {
		id: ID,
		label: LABEL,
		describe: "插件包与代码里注册的技能",
		priority: 90,
		supplies: ["skill"],

		async load(kind: CapabilityId, _ctx: DiscoveryContext): Promise<ProviderResult<Skill>> {
			if (kind !== "skill") return { items: [] };
			/*
			 * 带出具体是哪个插件、装在项目还是用户目录：同名技能被覆盖时，设置页照这个标签说「被谁
			 * 覆盖」，只写「已安装插件」的话，装了几个插件就分不清是哪一个。名字取法与设置页插件列表一致。
			 *
			 * Bundled before registered: a plugin that ships a skill file is stating something more
			 * specific than a default registered in code, and the two collide by name often enough
			 * that the order has to be deliberate rather than incidental.
			 */
			const bundled = bundles.flatMap((plugin) => {
				const label = `插件「${plugin.manifest.interface?.displayName ?? plugin.manifest.name}」`;
				const scope = plugin.source === "workspace" ? ("project" as const) : ("user" as const);
				return plugin.skills.map(
					(skill) => ({ ...skill, provenance: { provider: ID, providerLabel: label, path: skill.path, scope } }) as Sourced<Skill>,
				);
			});
			const loose = registered.map(
				(skill) => ({ ...skill, provenance: { provider: ID, providerLabel: LABEL, path: skill.path, scope: "user" as const } }) as Sourced<Skill>,
			);
			return { items: [...bundled, ...loose] };
		},
	};
}
