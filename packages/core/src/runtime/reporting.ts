/**
 * Describing a session, rather than running one.
 *
 * Two questions the UI asks and the agent never does: what is loaded, and where is the context
 * window going. Both need the session's inputs and neither is part of taking a turn, so they read
 * the session rather than living inside it.
 *
 * `SessionFacts` is the read-only face of a session — the fields these answers are made of, and
 * nothing that could change one.
 */

import type { Settings } from "../config/settings.ts";
import { resolveModel } from "../config/settings.ts";
import type { McpManager, McpServerStatus } from "../mcp/client.ts";
import type { Plugin, PluginDiagnostic } from "../plugins/loader.ts";
import type { Skill, SkillDiagnostic } from "../skills/loader.ts";
import type { SessionMeta } from "../session/store.ts";
import type { AgentDefinition } from "../tools/task.ts";
import type { Message, Tool } from "../types.ts";
import { buildContextBreakdown, type ContextBreakdown } from "./context.ts";
import { loadPromptContext, promptCapabilities } from "./prompt-context.ts";
import { reconcilePrompt } from "../prompt/context.ts";
import type { SystemPromptInput } from "../prompt/system.ts";
import type { RecordedContext, RequestContext } from "./session-log.ts";

export interface SessionStatus {
	meta: SessionMeta;
	running: boolean;
	skills: Skill[];
	skillDiagnostics: SkillDiagnostic[];
	plugins: Plugin[];
	pluginDiagnostics: PluginDiagnostic[];
	mcp: McpServerStatus[];
	agents: AgentDefinition[];
	toolNames: string[];
}

/** Everything the two answers below are made of. Read-only by construction. */
export interface SessionFacts {
	readonly meta: SessionMeta;
	readonly running: boolean;
	readonly cwd: string;
	readonly messages: Message[];
	readonly settings: Settings;
	readonly tools: Tool[];
	readonly skills: Skill[];
	readonly skillDiagnostics: SkillDiagnostic[];
	readonly plugins: Plugin[];
	readonly pluginDiagnostics: PluginDiagnostic[];
	readonly mcpStatuses: McpServerStatus[];
	readonly agents: AgentDefinition[];
	readonly mcp: McpManager;
	readonly rules: SystemPromptInput["rules"];
	readonly resources: SystemPromptInput["resources"];
	readonly requestContext: RequestContext | null;
	readContext(): Promise<RecordedContext | null>;
	scratchDir(): string;
}

export async function describeSession(session: SessionFacts): Promise<SessionStatus> {
	return {
		meta: session.meta,
		running: session.running,
		skills: session.skills,
		skillDiagnostics: session.skillDiagnostics,
		plugins: session.plugins,
		pluginDiagnostics: session.pluginDiagnostics,
		mcp: session.mcpStatuses,
		agents: session.agents,
		toolNames: session.tools.map((t) => t.name),
	};
}

/** Report the captured request; only sessions without a recorded prompt need a source preview. */
export async function describeContext(session: SessionFacts): Promise<ContextBreakdown | null> {
	const resolved = resolveModel(session.settings, session.meta.modelId || session.settings.defaultModelId);
	if (!resolved) return null;
	const recorded = await session.readContext();
	const request = session.requestContext;
	let prompt;
	let schemas;
	let mcpNames;
	if (recorded) {
		prompt = recorded.sections
			? { systemPrompt: recorded.systemPrompt, sections: recorded.sections }
			: reconcilePrompt({ systemPrompt: "", sections: [] }, recorded.systemPrompt);
		schemas = recorded.schemas ?? [];
		mcpNames = new Set(recorded.mcpTools ?? schemas.filter(tool => tool.name.startsWith("mcp__")).map(tool => tool.name));
	} else {
		const capabilities = promptCapabilities({ settings: session.settings, thinking: session.meta.thinking, messages: session.messages, agents: session.agents, tools: session.tools });
		prompt = await loadPromptContext({
			cwd: session.cwd, settings: session.settings, ...capabilities,
			skills: session.skills, agents: session.agents, rules: session.rules, resources: session.resources,
			modelName: resolved.model.name, thinking: session.meta.thinking ?? session.settings.thinking,
			scratchDir: session.scratchDir(), recordInjection: false,
		});
		schemas = capabilities.tools;
		mcpNames = new Set(session.mcp.allTools().map(tool => tool.name));
	}
	if (request) {
		prompt = reconcilePrompt(prompt, request.context.systemPrompt);
		schemas = request.context.tools;
	}
	return buildContextBreakdown({
		model: request?.model ?? resolved.model,
		messages: request?.context.messages ?? session.messages,
		systemPrompt: prompt.systemPrompt, sections: prompt.sections,
		builtinTools: schemas.filter(tool => !mcpNames.has(tool.name)),
		mcpTools: schemas.filter(tool => mcpNames.has(tool.name)),
		skillCatalogue: "", projectInstructions: [],
	});
}
