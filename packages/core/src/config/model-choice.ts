/**
 * Which model runs a sub-agent or a background job, decided by what this machine chose in settings.
 *
 * Each job has its own row in settings (an agent by name, `compact`, the title, recap and memory
 * models), and an unset row follows the session's model.
 */

import type { ModelConfig, ProviderConfig, ThinkingLevel } from "../types.ts";
import { resolveModelThinkingOptions, resolveThinkingOption } from "../ai/thinking-options.ts";
import type { Settings } from "./settings.ts";
/*
 * 从 `models.ts` 而不是 `settings.ts`。
 *
 * 这个文件是设置页的模型选择要用的，而那段代码跑在渲染器里。`settings.ts` 顶上就是
 * `node:fs`——从它那里导入一个值，会把整条依赖链拉进浏览器包，窗口一片空白。
 * 这也是 `@plume/core/model-choice` 这个子入口存在的原因：它自己就是浏览器安全的。
 */
import { resolveModel } from "./models.ts";
import { normalizeSubAgentProfiles, type SubAgentProfile } from "./sub-agent-profiles.ts";

export { availableModels } from "./models.ts";
export { normalizeSubAgentProfiles, type SubAgentProfile } from "./sub-agent-profiles.ts";

/** What this machine chose for one agent, or for `compact`. */
export function agentProfile(settings: Settings, name: string): SubAgentProfile {
	return normalizeSubAgentProfiles(settings.subAgentProfiles)[name] ?? {};
}

export function withAgentProfile(settings: Settings, name: string, profile: SubAgentProfile): Settings {
	const subAgentProfiles = { ...settings.subAgentProfiles };
	if (profile.modelId || profile.thinking) subAgentProfiles[name] = profile;
	else delete subAgentProfiles[name];
	return { ...settings, subAgentProfiles };
}

/** A model id, optionally with a `:high` thinking suffix. */
export interface ParsedModelRef {
	id: string;
	/** A `:high` suffix asking for a thinking level. */
	thinking?: string;
}

export function parseModelRef(ref: string): ParsedModelRef {
	const trimmed = ref.trim();
	/*
	 * A plain id may also carry `:high`, but a model id can legitimately contain a colon
	 * (`kimi-k3:256k` is one this machine has), so only a known thinking level is taken as a
	 * suffix. Guessing wrong here turns a valid model into one that cannot be found.
	 */
	const match = /^(.*):(off|minimal|low|medium|high|xhigh|max|ultra)$/.exec(trimmed);
	return match ? { id: match[1], thinking: match[2] } : { id: trimmed };
}

export interface ModelResolution {
	provider: ProviderConfig;
	model: ModelConfig;
	thinking?: string;
	/** Which entry in the list answered, for diagnostics. */
	via: string;
}

/**
 * Resolve a model id — or a priority list of them — to something that exists here.
 *
 * Falling through to the session's own model at the end means a definition naming three models,
 * none of which this machine has, still runs rather than failing on a preference.
 */
export function resolveModelRef(
	settings: Settings,
	ref: string | string[] | null | undefined,
	fallback: { provider: ProviderConfig; model: ModelConfig },
): ModelResolution {
	const refs = !ref ? [] : Array.isArray(ref) ? ref : [ref];

	for (const candidate of refs) {
		const parsed = parseModelRef(candidate);
		const found = resolveModel(settings, parsed.id);
		if (found) return { ...found, thinking: parsed.thinking, via: candidate };
	}

	return { ...fallback, via: "会话当前的模型" };
}

/** The model that writes compaction summaries: the `compact` row in settings, else the caller's. */
export function compactionModel(settings: Settings, fallback: { provider: ProviderConfig; model: ModelConfig }): ModelResolution {
	return resolveModelRef(settings, agentProfile(settings, "compact").modelId, fallback);
}

/** Explicit local choices outrank portable definitions, including in recursively spawned runs. */
export function resolveSubAgentModel(
	settings: Settings,
	definition: { name: string; model?: string | string[] },
	fallback: { provider: ProviderConfig; model: ModelConfig },
): ModelResolution & { thinking: ThinkingLevel } {
	const profile = agentProfile(settings, definition.name);
	const explicit = profile?.modelId ? resolveModel(settings, profile.modelId) : null;
	if (profile?.modelId && !explicit) throw new Error(`子智能体 ${definition.name} 指定的模型 ${profile.modelId} 不可用，请在设置 → 子智能体中重新选择。`);
	const chosen = explicit ? { ...explicit, via: profile?.modelId ?? "", thinking: undefined } : resolveModelRef(settings, definition.model, fallback);
	const levels = resolveModelThinkingOptions(chosen.model);
	const requested = profile?.thinking ?? chosen.thinking ?? settings.thinking;
	const supported = levels.find((level) => level.id === requested);
	if (profile?.thinking && levels.length > 0 && !supported) throw new Error(`子智能体 ${definition.name} 的模型不支持思考等级 ${profile.thinking}，请重新选择。`);
	const thinking = resolveThinkingOption(requested, chosen.model)?.id ?? "off";
	return { ...chosen, thinking };
}
