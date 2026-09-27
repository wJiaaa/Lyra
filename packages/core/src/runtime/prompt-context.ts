import { DEFAULT_MAX_DEPTH } from "./dispatch-guard.ts";
import { RENAMED_AGENTS, resolveAgentName } from "../agents-builtin.ts";
import { delegationConcurrency, delegationTier, mentionedAgents, normalizeDelegationPolicy, type DelegationDecision } from "./delegation.ts";
import { access } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
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

/** Execution and pre-request previews resolve exactly the same sources and budgets. */
export async function loadPromptContext(input: Pick<SystemPromptInput, "cwd" | "tools" | "skills" | "agents" | "modelName" | "rules" | "resources" | "thinking" | "delegation" | "dispatchLimits" | "scratchDir"> & {
	settings: Settings;
	recordInjection?: boolean;
}) {
	const { cwd, settings } = input;
	const [memory, projectInstructions, identityOverride, guidelinesOverride, isolatedWorktree, isGitRepo] = await Promise.all([
		gatherMemory(cwd, settings.personalization?.enableMemory !== false, Date.now(), projectMemoryEnabled(settings), input.recordInjection !== false),
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
	const tools = input.tools.filter(tool =>
		(tool.name !== "learn" || projectMemoryEnabled(input.settings)) &&
		(tool.name !== "task" || delegation.tier !== "off" || delegation.mentioned.length > 0));
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
 * 工夫。这也让「关掉」成为唯一一个会因为用户措辞而改变工具表的档位，那正是它的定义。
 *
 * 看的是「上一条助手消息之后的所有用户消息」，而不是最后一条。用户常常分两次说完一件事——先
 * 「@explore 看看这个」，再补一句「先别改代码」——只读最后一条会把点名读丢，而那一条恰恰是他
 * 唯一一次明确表示要派活。
 *
 * 已知的边界：中途插话（steering）到达时这一轮的工具表已经定了，所以插话里的点名要等下一轮才
 * 算数。改成每次请求前重算是可以的，但那意味着一轮之内工具表会变，模型看到的世界在自己说话的
 * 过程中被换掉——那个代价比等一轮大。
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
