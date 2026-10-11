/**
 * Delegating a piece of work to another agent. Only the main conversation does this; a sub-agent
 * never gets the `task` tool (`sub-agent-dispatch.ts`).
 *
 * The point is context isolation: a search that reads forty files returns one paragraph to the
 * parent instead of forty file dumps. Which means the sub-agent gets its own message list and its
 * own state map — its file reads and its todo list must not leak upwards.
 *
 * What it did is not lost, though. The steps it took are collected and handed back so the caller
 * can write them to the session log; a delegated turn should be as readable afterwards as one done
 * in the open.
 */

import { ARTIFACTS_KEY, MCP_KEY, PLUGINS_KEY, SESSIONS_KEY } from "../resources/more-handlers.ts";
import type { ModelConfig, ProviderConfig } from "../types.ts";
import { dispatchSubAgent } from "./sub-agent-dispatch.ts";
import { finishSubAgent } from "./sub-agent-finish.ts";
import type { SubAgentAnswer, SubAgentOptions, SubAgentRequest } from "./sub-agent-options.ts";
import { openingHistory, subAgentPrompt } from "./sub-agent-prompt.ts";
import { runDispatched } from "./sub-agent-run.ts";

export { HANDOFF_SCHEMA } from "./sub-agent-dispatch.ts";

/**
 * 子代理每跑多少轮停下来看一眼——检查点，不是上限。
 *
 * 这个数从前是硬上限：到了就停，上下文整个扔掉，交回停下前最后说的那句话，派它来的模型只能
 * 从零再派一个，把读过的文件再读一遍。反馈里「重开三个子代理、个个跑满 60 步、最后主会话自己
 * 做了」就是这么来的。60 这个数也不是量出来的：它是 8 月引入子代理时写下的，后来补的理由是
 * 「可能同时有十来个在跑」——而并发现在由派发闸门管着（默认 4 个、最多 8 个），不该再压在
 * 每个子代理的轮数上。
 *
 * 现在到了检查点：
 *   - 它的清单在往前推，就接着跑——判据和主会话的续跑链是同一个（`continuation.ts`），在
 *     真实事故上校准过，不是另起的「它是不是在瞎忙」的启发式；
 *   - 否则讨一份交接（做了什么、还剩什么、下一步），然后**停下但留着上下文**：派它来的那一方
 *     用 `task` 的 `resume` 让它从停下的地方接着来，只付新增的那几轮。
 *
 * 按定义可以改（agent 文件里的 `maxTurns`）。改的是「多久汇报一次」，不是「最多干多少活」。
 */
export const SUB_AGENT_CHECKPOINT_TURNS = 60;

/**
 * The state keys a delegated run's addresses read, copied from the parent and nothing else.
 *
 * `skill://` is not among them: it reads `SKILLS_KEY`, which a sub-agent fills with its own skills.
 */
const SHARED_LOOKUPS = [ARTIFACTS_KEY, PLUGINS_KEY, MCP_KEY, SESSIONS_KEY];

/** The parent's lookups for `addresses.lookups`; see `SHARED_LOOKUPS`. */
export function addressLookups(state: ReadonlyMap<string, unknown>): Map<string, unknown> {
	return new Map(SHARED_LOOKUPS.flatMap((key) => (state.has(key) ? [[key, state.get(key)] as const] : [])));
}

/**
 * 派一个子代理去做一件事，等它交回答案。
 *
 * 三段，各在自己的文件里：派发准备（`sub-agent-dispatch.ts`：挑工具、选模型、上名单、排队）、
 * 运行（`sub-agent-run.ts`：配置、事件转发、检查点续跑、讨交接）、收尾（`sub-agent-finish.ts`：
 * 拼答案、记结局、留上下文）。开跑前看到的提示词和历史在 `sub-agent-prompt.ts`。
 */
export async function runSubAgent(
	options: SubAgentOptions,
	input: SubAgentRequest,
	provider: ProviderConfig,
	model: ModelConfig,
): Promise<SubAgentAnswer> {
	/*
	 * 续跑：还是那个子代理，带着它读过、做过的一切。
	 *
	 * 这是从零重派的反面。重派的那个什么都不知道，把上一个读过的文件再读一遍、把走过的弯路
	 * 再走一遍；续跑的这个只往它自己的历史后面接一句话，前缀跟它上一次请求逐字相同，供应商的
	 * 缓存还热着的话，那几十轮历史几乎不花钱。
	 *
	 * 只能续跑自己派出去的：主会话续跑它派的，子代理续跑它派的。别人的子代理不是你能指挥的。
	 */
	/*
	 * 派出去之前会话就已经停了：一步都不做，也不上名单。
	 *
	 * 挂在父信号上的 `stopWithParent` 只听得到「将来」的 abort——已经 aborted 的信号不会再发一次
	 * 事件，于是从前这样的一次派发会带着一根早就断了的绳子跑完全程。
	 */
	if (options.signal?.aborted) return { text: "（派发时会话已经停下，这个子代理没有开始。）" };
	const dispatched = await dispatchSubAgent(options, input, provider, model);
	if ("stopped" in dispatched) return dispatched.stopped;
	const checkpoint = dispatched.definition.maxTurns ?? SUB_AGENT_CHECKPOINT_TURNS;
	const prompt = await subAgentPrompt(options, dispatched, checkpoint);
	const { history, envDate } = openingHistory(dispatched);
	const ran = await runDispatched(options, dispatched, { prompt, history, checkpoint });
	return finishSubAgent(options, dispatched, ran, { checkpoint, envDate });
}
