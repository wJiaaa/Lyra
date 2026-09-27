import { DEFAULT_MAX_DEPTH, normalizeMaxConcurrentSubAgents } from "./dispatch-guard.ts";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join } from "node:path";
import type { Settings } from "../config/settings.ts";
import { projectRootsFor } from "../config/project-roots.ts";
import { commandShell } from "../platform.ts";
import { sandboxModeFor } from "../sandbox/mode-for.ts";
import { buildPromptContext, loadProjectInstructions } from "../prompt/system.ts";
import { readPromptOverride } from "../prompt/overrides.ts";
import type { SystemPromptInput } from "../prompt/system.ts";
import { gatherMemory } from "./memory-inject.ts";
import { projectMemoryEnabled } from "./project-memory.ts";
import { isIsolatedWorktree } from "./workspace.ts";

/**
 * Execution and pre-request previews resolve exactly the same sources and budgets.
 *
 * 每轮按磁盘现状生成一份；会话里真正发出去的是冻结的那份，两者在段落上的差别作为增量接在历史
 * 末尾（`session-turn.ts` 的 `settlePrompt`）。所以这里照旧每轮重读项目指令、规则和技能：改动
 * 要被发现，只是不再改写开头。
 */
export async function loadPromptContext(input: Pick<SystemPromptInput, "cwd" | "tools" | "skills" | "agents" | "modelName" | "rules" | "resources" | "dispatchLimits" | "scratchDir"> & {
	settings: Settings;
	recordInjection?: boolean;
}) {
	const { cwd, settings } = input;
	const [memory, projectInstructions, identityOverride, guidelinesOverride, isolatedWorktree, isGitRepo] = await Promise.all([
		/*
		 * 按会话冻结记忆（见 `memory-inject.ts`）。暂存目录的最后一段就是会话 id（`scratchDir`），
		 * 是两处调用方（组装一轮、上下文面板预估）都已经传进来的会话标识；没有它的调用方每次重读。
		 */
		gatherMemory(cwd, settings.personalization?.enableMemory !== false, Date.now(), projectMemoryEnabled(settings), input.recordInjection !== false, input.scratchDir ? basename(input.scratchDir) : undefined),
		loadProjectInstructions(cwd),
		readPromptOverride(cwd, "identity"),
		readPromptOverride(cwd, "guidelines"),
		isIsolatedWorktree(cwd),
		access(join(cwd, ".git")).then(() => true, () => false),
	]);
	return buildPromptContext({
		...input,
		projectRoots: projectRootsFor(settings.projects, cwd),
		projectInstructions,
		identityOverride,
		guidelinesOverride,
		isolatedWorktree,
		isGitRepo,
		customInstructions: settings.personalization?.customInstructions,
		tone: settings.personalization?.tone,
		memorySnippet: memory.memorySnippet,
		projectMemory: memory.projectMemory,
		projectMemoryFiles: memory.projectMemoryFiles,
		platform: platform(),
		shell: commandShell(sandboxModeFor(settings.permissionMode)),
	});
}

interface PromptCapabilitiesInput {
	settings: Settings;
	tools: SystemPromptInput["tools"];
}

export function promptCapabilities(input: PromptCapabilitiesInput) {
	const tools = input.tools.filter(tool => tool.name !== "learn" || projectMemoryEnabled(input.settings));
	return {
		tools,
		dispatchLimits: {
			maxConcurrent: normalizeMaxConcurrentSubAgents(input.settings.maxConcurrentSubAgents),
			maxDepth: DEFAULT_MAX_DEPTH,
		},
	};
}
