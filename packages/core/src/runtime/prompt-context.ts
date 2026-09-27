import { DEFAULT_MAX_DEPTH } from "./dispatch-guard.ts";
import { RENAMED_AGENTS, resolveAgentName } from "../agents-builtin.ts";
import { delegationConcurrency, delegationTier, mentionedAgents, normalizeDelegationPolicy, type DelegationDecision } from "./delegation.ts";
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
export async function loadPromptContext(input: Pick<SystemPromptInput, "cwd" | "tools" | "skills" | "agents" | "modelName" | "rules" | "resources" | "thinking" | "delegation" | "dispatchLimits" | "scratchDir"> & {
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
	thinking?: SystemPromptInput["thinking"];
	messages: import("../types.ts").Message[];
	agents: NonNullable<SystemPromptInput["agents"]>;
	tools: SystemPromptInput["tools"];
}

export function promptCapabilities(input: PromptCapabilitiesInput) {
	const delegation = delegationDecision(input);
	// `task` 不按点名增减：工具表在缓存前缀最前面，派活关掉时由 `task` 执行时按 `DELEGATION_KEY` 放行。
	const tools = input.tools.filter(tool => tool.name !== "learn" || projectMemoryEnabled(input.settings));
	return {
		tools, delegation,
		dispatchLimits: {
			maxConcurrent: delegationConcurrency(input.settings.maxConcurrentSubAgents, input.thinking ?? input.settings.thinking, normalizeDelegationPolicy(input.settings.subAgentDelegation)),
			maxDepth: DEFAULT_MAX_DEPTH,
		},
	};
}

/**
 * 这一轮到底派不派、派谁。
 *
 * 只在 `off` 档下才去读用户写了什么——其余四档的答案跟消息内容无关，而扫一遍历史找 `@` 是白花的
 * 工夫。结果只进会话状态给 `task` 执行时检查，不改工具表也不改提示词，缓存前缀不跟着点名变。
 *
 * 看的是「上一条助手消息之后的所有用户消息」，而不是最后一条。用户常常分两次说完一件事——先
 * 「@explore 看看这个」，再补一句「先别改代码」——只读最后一条会把点名读丢，而那一条恰恰是他
 * 唯一一次明确表示要派活。
 *
 * 已知的边界：中途插话（steering）到达时这一轮的决定已经定了，所以插话里的点名要等下一轮才
 * 算数。
 */
function delegationDecision(input: PromptCapabilitiesInput): DelegationDecision {
	const policy = normalizeDelegationPolicy(input.settings.subAgentDelegation);
	const tier = delegationTier(input.thinking ?? input.settings.thinking, policy);
	if (tier !== "off") return { tier, mentioned: [] };

	const messages = input.messages;
	const lastReply = messages.findLastIndex((message) => message.role === "assistant");
	// 旧名也认：三天前的会话里那句 `@fast` 指的人还在，见 `RENAMED_AGENTS`。
	const known = [...input.agents.map((agent) => agent.name), ...Object.keys(RENAMED_AGENTS)];
	const mentioned = new Set<string>();
	for (const message of messages.slice(lastReply + 1)) {
		// 运行时自己注入的那些（环境说明、规则纠正）不算点名——它们不是用户说的话。
		if (message.role !== "user" || message.synthetic) continue;
		const text = message.content
			.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		for (const name of mentionedAgents(text, known)) {
			const resolved = resolveAgentName(name, input.agents);
			// 旧名指向一个已经不存在的定义时不放行：留着它只会让 `task` 拿一个查无此人的名字去派。
			if (input.agents.some((agent) => agent.name === resolved)) mentioned.add(resolved);
		}
	}
	return { tier, mentioned: [...mentioned] };
}
