/**
 * 子代理开跑时看到的东西：一份独立的系统提示词，和它的开场历史（新派的从开场那句起，续跑的接在
 * 上一次看到的历史后面）。
 */

import { access } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { stripStaleHandles } from "../agent/model-switch.ts";
import { projectRootsFor } from "../config/project-roots.ts";
import { commandShell } from "../platform.ts";
import { today, withEnvironment } from "../prompt/environment.ts";
import { readPromptOverride } from "../prompt/overrides.ts";
import { buildPromptContext, loadProjectInstructions } from "../prompt/system.ts";
import { sandboxModeFor } from "../sandbox/mode-for.ts";
import type { Message } from "../types.ts";
import type { SubAgentOptions } from "./sub-agent-options.ts";
import type { Dispatched } from "./sub-agent-dispatch.ts";
import { isIsolatedWorktree } from "./workspace.ts";
import { yieldInstruction } from "./yield-tool.ts";

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Build a complete, standalone system prompt for sub-agents. */
export async function subAgentPrompt(options: SubAgentOptions, dispatched: Dispatched, checkpoint: number) {
	const { definition, allowed, resources, scratch } = dispatched;
	return buildPromptContext({
		cwd: options.cwd,
		projectRoots: projectRootsFor(options.settings.projects, options.cwd),
		tools: allowed,
		skills: options.skills,
		agents: options.agents,
		projectInstructions: await loadProjectInstructions(options.cwd),
		/*
		 * 行为准则跟着走，身份不跟。
		 *
		 * 「注释一律中文」「匹配周围代码风格」对子代理写的代码同样成立——这些约定管的是产出，
		 * 而子代理的产出最后进的是同一个仓库。身份则由它自己的定义写着（「你是一个只读的代码审查者」），
		 * 放在最前面；项目的身份段和 Plume 的默认身份都不用，否则等于把派它出去的理由抹掉。
		 */
		identity: definition.systemPrompt,
		guidelinesOverride: await readPromptOverride(options.cwd, "guidelines"),
		platform: platform(),
		// Its own mode decides its shell, exactly as `sandboxMode` is decided for its tools (`run-policy.ts`).
		shell: commandShell(sandboxModeFor(options.settings.permissionMode)),
		modelName: dispatched.chosen.model.name,
		resources: resources.schemes(),
		scratchDir: scratch,
		isGitRepo: await pathExists(join(options.cwd, ".git")),
		isolatedWorktree: await isIsolatedWorktree(options.cwd),
		appendSystemPrompt: [workingNote(checkpoint), definition.output ? yieldInstruction(definition.output).trim() : ""]
			.filter(Boolean)
			.join("\n"),
	});
}

/** 它这一段从哪段历史开始，以及那段历史里的日期块是哪天的。 */
export function openingHistory(dispatched: Dispatched): { history: Message[]; envDate: string } {
	const { earlier, opening } = dispatched;
	// 子代理也要知道今天几号，接在开场那条消息后面——理由见 `prompt/environment.ts`。
	let envDate = earlier?.conversation.envDate ?? today();
	/*
	 * 续跑时换了模型（父会话中途换过、或者设置里给它改了模型），留下的历史全出自旧模型：供应商
	 * 句柄交给新模型只会被整条拒掉，跟父会话换模型时 `adopted()` 之前那一步是同一件事（见
	 * `model-switch.ts`）。整段都剥：切换点就是续跑这一刻。没换的原样不动，缓存前缀要逐字相同。
	 */
	const earlierView = earlier
		? earlier.conversation.model === dispatched.chosen.model.id
			? earlier.conversation.view
			: stripStaleHandles(earlier.conversation.view, earlier.conversation.view.length)
		: [];
	let history: Message[];
	if (!earlier) history = withEnvironment([opening]);
	else if (today() === envDate) {
		/*
		 * 原样接在它上一次看到的历史后面，一个字节都不动。
		 *
		 * 不从转录重建：转录里没有压缩边界、没有那条日期块，重建出来的前缀从第二条起就跟上一次
		 * 请求对不上，缓存整段作废——续跑省下的那部分又花回去了。
		 */
		history = [...earlierView, opening];
	} else {
		// 隔了天再续：旧的日期块留在原位（前缀不动），新的一条跟在这次的开场消息后面，模型读到的「今天」是对的。
		envDate = today();
		history = [...earlierView, ...withEnvironment([opening])];
	}
	return { history, envDate };
}

/**
 * 子代理怎么干活才不浪费，跟在每个定义自己的提示词后面。
 *
 * 2026-09-26 的真实会话：四个 review 子代理跑在 gemini-3.8-flash 上，61 轮就是 61 次工具调用，
 * 一次并行都没有，于是个个撞上六十轮的检查点。系统提示词里「独立的调用放在同一条回复里」那条
 * 它是看得见的，但那条夹在十几条准则中间，说的也只是道理。放在它自己那一段的末尾，并且说清楚
 * 这对它意味着什么——每一轮都要把整段上下文再发一遍，检查点按轮算——才压得住。
 *
 * 最后一句是写给派它来的那一方的：它交回的东西是材料，不是给人看的成品。
 */
function workingNote(checkpoint: number): string {
	return [
		`你是被派出来做一件事的子代理，按轮计：每一轮都要把整段上下文再发一遍，每跑 ${checkpoint} 轮会停下来检查一次进度。`,
		"所以每一轮都把能同时做的事一起做——要读的几个文件、要跑的几条 grep / glob，放在同一条回复里一起发出去；只有后一步确实要用前一步的结果时才分开。一轮只调一个工具，会让你在做完之前就耗光这一段的轮数。",
		"活有三步以上，就用 `todo_write` 记下步骤、做完一项勾一项：到检查点时，清单在往前推就会让你接着跑。",
		"你交回的东西是给派你来的 Agent 读的材料：结论先行、关键事实带 `path:line`，不要复述过程。",
	].join("\n");
}
