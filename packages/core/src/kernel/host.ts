/**
 * What every host does before its first session: build the kernel and point the runtime at it.
 *
 * The window and the terminal both run this, so a capability plugin someone installed behaves the
 * same in either. Written once because the list of seams is the kind of thing that drifts — a seam
 * added here and forgotten in a second copy shows up as a feature that works in one host only.
 */

import { join } from "node:path";
import { useLlmRegistry } from "../ai/index.ts";
import { useAgentLoop, type AgentLoop } from "../agent/runner.ts";
import type { Settings } from "../config/settings.ts";
import { loadCapabilityPlugins } from "../plugins/capability.ts";
import { loadPlugins } from "../plugins/loader.ts";
import { useApprovalPolicy } from "../runtime/approval-policy.ts";
import { useCompaction } from "../runtime/compaction.ts";
import { useScheduler } from "../runtime/scheduling.ts";
import { useTurnPipeline } from "../runtime/turn.ts";
import { useSandbox } from "../sandbox/index.ts";
import { duckDuckGoProvider } from "../search/duckduckgo.ts";
import { registerSearchProvider } from "../search/index.ts";
import { instantAnswerProvider } from "../search/instant.ts";
import { BRAVE_PROVIDER_ID, EXA_PROVIDER_ID, keyedSearchProvider, TAVILY_PROVIDER_ID } from "../search/keyed.ts";
import type { SessionStorage } from "../session/storage.ts";
import { lyraHome } from "../session/store.ts";
import { useSkillRegistry } from "../skills/registry.ts";
import { useToolRegistry } from "../tools/index.ts";
import type { Context } from "./context.ts";
import { createContext, DEFAULT_PLUGINS } from "./index.ts";
import {
	APPROVAL,
	COMPACTION,
	LLM,
	LOOP,
	SANDBOX,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	TOOLS,
	type ApprovalPolicy,
	type CompactionStrategy,
	type LlmRegistry,
	type Sandbox,
	type SkillRegistry,
	type TaskScheduler,
	type ToolRegistry,
	type TurnPipeline,
} from "./services.ts";

export interface HostKernel {
	context: Context;
	/** The session store a plugin may have replaced. Hosts build their sessions on this one. */
	storage: SessionStorage;
	skills: SkillRegistry;
	/** Unwinds every seam, then the plugins, in the reverse of the order they arrived. */
	dispose(): Promise<void>;
}

export async function bootHostKernel(settings: Settings, warn: (message: string) => void = console.warn): Promise<HostKernel> {
	/*
	 * The kernel is built from the default set plus whatever the user has installed.
	 *
	 * A plugin that replaces the model registry or the sandbox has to be in place before the first
	 * session is built, not bolted on afterwards. A bundle that fails to load is recorded and
	 * skipped — someone else's broken plugin must not be why the host will not start.
	 */
	const bundles = await loadPlugins(
		[{ dir: join(lyraHome(), "plugins"), source: "user" as const }],
		settings.disabledPlugins,
	);
	const extra = await loadCapabilityPlugins(bundles.plugins);
	for (const diagnostic of extra.diagnostics) warn(`[plugin] ${diagnostic.path}: ${diagnostic.message}`);
	/*
	 * A capability that loads and then throws while being applied is as broken as one that does not
	 * load, and was not covered: the throw came out of `createContext`, before the window existed,
	 * and the app did not open. Started again without the installed ones — the built-in set is what
	 * an ordinary Lyra is, and a context that failed halfway is not something to keep building on.
	 */
	const context = await createContext([...DEFAULT_PLUGINS, ...extra.plugins]).catch((error: unknown) => {
		if (extra.plugins.length === 0) throw error;
		warn(`[plugin] 已装的能力插件（${extra.plugins.map((plugin) => plugin.name).join("、")}）启动失败，这次不带它们启动：${error instanceof Error ? error.message : String(error)}`);
		return createContext(DEFAULT_PLUGINS);
	});
	const skills = context.require<SkillRegistry>(SKILLS);
	useLlmRegistry(context.require<LlmRegistry>(LLM));
	useToolRegistry(context.require<ToolRegistry>(TOOLS));
	useSandbox(context.require<Sandbox>(SANDBOX));
	useCompaction(context.require<CompactionStrategy>(COMPACTION));
	useApprovalPolicy(context.require<ApprovalPolicy>(APPROVAL));
	useSkillRegistry(skills);
	useScheduler(context.require<TaskScheduler>(SCHEDULER));
	useAgentLoop(context.require<AgentLoop>(LOOP));
	useTurnPipeline(context.require<TurnPipeline>(SESSION).all());
	return {
		context,
		storage: context.require<SessionStorage>(STORAGE),
		skills,
		async dispose() {
			useLlmRegistry(null);
			useToolRegistry(null);
			useSandbox(null);
			useCompaction(null);
			useApprovalPolicy(null);
			useSkillRegistry(null);
			useScheduler(null);
			useAgentLoop(null);
			useTurnPipeline(null);
			await context.dispose();
		},
	};
}

/**
 * Search, working out of the box.
 *
 * The keyless provider is registered unconditionally so a fresh install can search at all; the
 * keyed ones read their key at call time, so they become available the moment one is pasted in
 * and stay out of the way until then. Which of them runs is `selectSearchProvider`'s call: the
 * user's pick, or — with none made — a pasted key over the keyless default.
 */
export function registerDefaultSearchProviders(keys: () => Settings["searchApiKeys"]): void {
	registerSearchProvider(duckDuckGoProvider());
	registerSearchProvider(instantAnswerProvider());
	registerSearchProvider(keyedSearchProvider(TAVILY_PROVIDER_ID, () => keys()?.tavily));
	registerSearchProvider(keyedSearchProvider(EXA_PROVIDER_ID, () => keys()?.exa));
	registerSearchProvider(keyedSearchProvider(BRAVE_PROVIDER_ID, () => keys()?.brave));
}
