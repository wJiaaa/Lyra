/**
 * What ships in the binary: the built-in sub-agents.
 *
 * Priority 1, below everything, and that number is the fix for a real bug rather than a
 * convention. Agent definitions used to be assembled as `[...BUILTIN_AGENTS, ...custom]` and read
 * with `.find()`, so a `general` written into `.plume/agents/` was found second and never used.
 * Nothing reported it; the file was loaded, listed, and ignored.
 *
 * Everything a user puts on disk is a more specific statement than anything we shipped, so the
 * shipped copy goes last and is shadowed by name like any other loser.
 */

import { BUILTIN_AGENTS, type AgentDefinition } from "../../tools/task.ts";
import type { CapabilityId, CapabilityProvider, DiscoveryContext, ProviderResult, SourceMeta, Sourced } from "../types.ts";

const ID = "builtin";
const LABEL = "内置";

function meta(path: string): SourceMeta {
	return { provider: ID, providerLabel: LABEL, path, scope: "builtin" };
}

export const builtinProvider: CapabilityProvider = {
	id: ID,
	label: LABEL,
	describe: "Plume 自带的子代理",
	priority: 1,
	supplies: ["agent"],

	async load(kind: CapabilityId, _ctx: DiscoveryContext): Promise<ProviderResult> {
		if (kind === "agent") {
			return {
				items: BUILTIN_AGENTS.map((agent) => ({ ...agent, provenance: meta(`builtin:${agent.name}`) }) as Sourced<AgentDefinition>),
			};
		}
		return { items: [] };
	},
};
