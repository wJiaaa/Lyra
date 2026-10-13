import { normalizeMaxConcurrentSubAgents } from "./sub-agent/dispatch-guard.ts";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join } from "node:path";
import type { Settings } from "../config/settings.ts";
import { imageModelRows } from "../config/image-models.ts";
import { projectRootsFor } from "../config/project-roots.ts";
import { commandShell } from "../platform.ts";
import { sandboxModeFor } from "../sandbox/mode-for.ts";
import { buildPromptContext, loadProjectInstructions } from "../prompt/system.ts";
import { readPromptOverride } from "../prompt/overrides.ts";
import type { SystemPromptInput } from "../prompt/system.ts";
import { gatherMemory } from "./memory/memory-inject.ts";
import { projectMemoryEnabled } from "./memory/project-memory.ts";

/**
 * 不是主力的会话怎么组提示词：侧边聊天。
 *
 * 身份和准则是它自己的，工具是一小组；项目指令、记忆、技能目录、项目的提示词覆盖都不带——那些是
 * 给接一整件任务的 agent 的，侧边聊天多数时候只是问一句话，要改文件时它被要求先去读项目指令。
 */
export interface PromptProfile {
	identity: string;
	guidelines: string[];
	tools: ReadonlySet<string>;
	interfaceBlocks: boolean;
}

/**
 * Execution and pre-request previews resolve exactly the same sources and budgets.
 *
 * 每轮按磁盘现状生成一份；会话里真正发出去的是冻结的那份，两者在段落上的差别作为增量接在历史
 * 末尾（`session-turn.ts` 的 `settlePrompt`）。所以这里照旧每轮重读项目指令和技能：改动
 * 要被发现，只是不再改写开头。
 */
export async function loadPromptContext(input: Pick<SystemPromptInput, "cwd" | "tools" | "skills" | "agents" | "modelName" | "resources" | "dispatchLimits" | "scratchDir" | "planMode"> & {
	settings: Settings;
	recordInjection?: boolean;
	profile?: PromptProfile;
}) {
	const { cwd, settings, profile, ...rest } = input;
	const [memory, projectInstructions, identityOverride, guidelinesOverride, isGitRepo] = await Promise.all([
		/*
		 * 按会话冻结记忆（见 `memory-inject.ts`）。暂存目录的最后一段就是会话 id（`scratchDir`），
		 * 是两处调用方（组装一轮、上下文面板预估）都已经传进来的会话标识；没有它的调用方每次重读。
		 */
		profile ? NO_MEMORY : gatherMemory(cwd, settings.personalization?.enableMemory !== false, Date.now(), projectMemoryEnabled(settings), input.recordInjection !== false, input.scratchDir ? basename(input.scratchDir) : undefined),
		profile ? [] : loadProjectInstructions(cwd),
		profile ? undefined : readPromptOverride(cwd, "identity"),
		profile ? undefined : readPromptOverride(cwd, "guidelines"),
		access(join(cwd, ".git")).then(() => true, () => false),
	]);
	return buildPromptContext({
		...rest,
		cwd,
		...(profile ? { skills: [], identity: profile.identity, guidelines: profile.guidelines, interfaceBlocks: profile.interfaceBlocks } : {}),
		projectRoots: projectRootsFor(settings.projects, cwd),
		projectInstructions,
		identityOverride,
		guidelinesOverride,
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

const NO_MEMORY = { memorySnippet: "", projectMemory: "", projectMemoryFiles: [] };

interface PromptCapabilitiesInput {
	settings: Settings;
	tools: SystemPromptInput["tools"];
}

export function promptCapabilities(input: PromptCapabilitiesInput) {
	/*
	 * `image_generate` only once there is something to draw with: a tool that can only answer "no image
	 * model" costs a turn to find that out, and every call is billed to a provider the user configured.
	 */
	const drawing = imageModelRows(input.settings.providers).length > 0;
	const tools = input.tools.filter(tool => (tool.name !== "learn" || projectMemoryEnabled(input.settings)) && (tool.name !== "image_generate" || drawing));
	return {
		tools,
		dispatchLimits: {
			maxConcurrent: normalizeMaxConcurrentSubAgents(input.settings.maxConcurrentSubAgents),
		},
	};
}
