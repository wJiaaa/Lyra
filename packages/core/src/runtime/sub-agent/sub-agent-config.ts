/**
 * 子代理一段运行交给循环的那份 `AgentRunConfig`。
 *
 * 跟主会话必须一致的部分（工具策略、钩子、工具环境的公共部分）从 `run-policy.ts` 拿，和
 * `turn-config.ts` 同一个来源；这里只写它真正不同的地方，每一处旁边写着为什么。
 */

import type { AgedToolPruner } from "../../agent/aged-prune.ts";
import type { CompactHistory } from "../../agent/compact-step.ts";
import { RepetitionWatch } from "../../agent/repetition.ts";
import type { AgentRunConfig } from "../../agent/run-config.ts";
import { streamAssistant } from "../../ai/index.ts";
import { textTokens, toolTokens } from "../../tokens.ts";
import { toolTable } from "../../tools/mcp-search.ts";
import type { ApprovalDecision, ApprovalRequest, Message } from "../../types.ts";
import { compactWith } from "../compaction/compaction.ts";
import { inheritedToolEnv, loadTurnHooks, toolHooks } from "../run-policy.ts";
import type { SubAgentOptions } from "./sub-agent-options.ts";
import type { Dispatched } from "./sub-agent-dispatch.ts";

/** 这一次运行自己的那几样：提示词、开场历史、裁剪器、检查点。 */
interface SubAgentRun {
	systemPrompt: string;
	history: Message[];
	pruner: AgedToolPruner;
	checkpoint: number;
}

export async function subAgentRunConfig(options: SubAgentOptions, dispatched: Dispatched, run: SubAgentRun): Promise<AgentRunConfig> {
	const { id, definition, controller, allowed, subState, chosen } = dispatched;
	const registry = options.registry;
	/*
	 * 工具钩子跟着委派下去——同一个 `bash` 调用，主对话里被审计、下一层就不被审计，那钩子就形同虚设。
	 * 一轮开始和收尾的钩子不跟：那是这场对话的开头和结尾，不是这个子代理的。
	 *
	 * 它跑的钩子记在它自己名下（`subagent_event`），进它自己的面板，不进主对话那个钩子按钮——
	 * 和 ZCode 一样：子代理的调用被拦下时，主对话看得到那次调用失败，是哪条钩子拦的去它那里看。
	 */
	const hooks = await loadTurnHooks({
		settings: options.settings,
		cwd: options.cwd,
		sessionId: options.sessionId,
		agentName: definition.name,
		agentId: id,
		signal: controller.signal,
		emit: async (event) => {
			if (event.type !== "hook_run") return;
			await options.emit({ type: "subagent_event", id, event: { ...event, run: registry?.hookRun(id, event.run) ?? event.run } });
		},
	});
	return {
		session: {
			sessionId: id,
			systemPrompt: run.systemPrompt,
			messages: run.history,
			state: subState,
			// Off: it stores the rendered `view` and resumes from it, see `AgentSessionContext.environment`.
			environment: false,
			compact: compactHistory(options, dispatched, run.systemPrompt),
			/*
			 * 一只表、一个裁剪器，跨检查点共用——和主会话续跑链同一个理由：跑满一段攒下的观察，
			 * 不该在接着跑的时候清零。裁剪器放在它自己的状态图里，续跑时也还是那一个。
			 */
			pruner: run.pruner,
			artifacts: options.addresses?.artifacts,
		},
		model: {
			provider: chosen.provider,
			model: chosen.model,
			// Chosen once at dispatch; a later switch in the parent reaches the next dispatch, not this run.
			liveModel: undefined,
			/*
			 * The app default, deliberately — not the dispatching conversation's level.
			 *
			 * A session turned up to the top level is one piece of work somebody decided was
			 * worth it; the sub-agents it dispatches are a dozen cheap errands run in parallel,
			 * and inheriting that level would multiply the decision by however many were sent.
			 */
			thinking: chosen.thinking,
			/*
			 * 它自己的运行 id：带着父会话 id、又和父会话分开，续跑沿用同一个（见 `dispatchSubAgent` 里的 `earlier?.id`）——
			 * 续跑是接着上一次的 `view` 往后发，前缀逐字相同，同一个 key 才落到那份缓存上。
			 */
			cacheKey: id,
			retryPolicy: () => (options.getSettings?.() ?? options.settings).retryPolicy,
			// Inherited, so a host that replaced the provider call replaced it for the whole
			// tree — a sub-agent quietly dialling out would defeat the point of overriding it.
			streamFn: options.streamFn,
			onContext: undefined,
		},
		tools: {
			available: allowed,
			env: {
				/*
				 * The session's policy, which does not stop applying because the work was delegated.
				 *
				 * Each of these was absent, and absent means "no restriction" rather than "inherit":
				 * a sub-agent ran its commands outside the sandbox the permission mode had chosen,
				 * and slipped past every configured hook — the same `bash` call audited in the main
				 * conversation and unaudited one level down.
				 * Delegation is a way of organising work, not a way around what the session decided.
				 *
				 * Derived from settings by the same function as the main turn, not inherited from the
				 * parent run: a delegated search that fell back to "whichever provider answers" would
				 * reach a service the user did not pick, from a run they cannot see.
				 */
				...inheritedToolEnv({
					settings: options.settings,
					cwd: options.cwd,
					project: options.project,
					/*
					 * Previews go under the parent's session, not this run's own id.
					 *
					 * They are thrown away with the conversation that produced them, and a delegated run
					 * is part of that conversation — filed under an id that disappears when the sub-agent
					 * finishes, the page would outlive nothing and be found by no one.
					 */
					sessionId: options.sessionId,
					allowedPaths: options.allowedPaths,
					transcript: options.transcript,
				}),
				// 人说话的对象是主会话，不是它；它也拿不到需要这个的工具（`sessionOnly`）。
				untilSpokenTo: undefined,
				scratchDir: dispatched.scratch,
				resources: dispatched.resources,
				// 子代理不派子代理：`task` 已经不在它的工具表里，这里也不留往下派的入口。
				spawnSubAgent: undefined,
			},
			requestApproval: approvalFrom(options, dispatched),
			...toolHooks(hooks),
		},
		control: {
			signal: controller.signal,
			/*
			 * The same splice-between-turns the main session uses for a message typed mid-run.
			 *
			 * Which is the whole of what "talking to a sub-agent" is: it finishes the step it is
			 * on, reads what was said with its context intact, and carries on rather than
			 * starting over. Nothing here knows where the message came from — the registry
			 * queues it, the loop drains it, exactly as for the parent.
			 */
			drainSteering: registry ? () => registry.drainSteering(id) : undefined,
			// Turn-level hooks stay with the conversation that owns the turn, see above.
			onStop: undefined,
			repetition: new RepetitionWatch(),
			maxTurns: run.checkpoint,
		},
	};
}

/**
 * 它要授权的时候，主窗口得说得出是谁在要。
 *
 * 子代理的授权从来就是送到主窗口那张卡片上的（`requestApproval` 一路传到会话的闸门），只是
 * 卡片不知道是谁在问：同一句「允许写入 src/a.ts？」可能来自主会话，也可能来自后台四个子代理
 * 里的任何一个，而人要据此决定的恰恰是「这个活该不该由它来干」。
 */
function approvalFrom(options: SubAgentOptions, { id, definition, description }: Dispatched) {
	const registry = options.registry;
	return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
		registry?.awaitingApproval(id, true);
		try {
			return await options.requestApproval({
				...request,
				from: { subAgentId: id, agent: definition.name, description },
			});
		} finally {
			registry?.awaitingApproval(id, false);
		}
	};
}

/*
 * The same context compaction the parent gets, for the same reason.
 *
 * A delegated run is the one most likely to need it: sixty turns of reading files is exactly
 * what it is dispatched to do, and its history is its own — the parent's compaction cannot
 * reach it. Without this a long search does not degrade, it stops, with the provider refusing
 * the request for being over the window; and because the `task` tool turns that into a tool
 * error, what the user sees is delegation that mysteriously fails on the big jobs and works on
 * the small ones.
 *
 * The overhead handed over is this run's own: its system prompt and its own subset of the
 * tools, which is not what the parent carries.
 */
function compactHistory(options: SubAgentOptions, { chosen, controller, allowed }: Dispatched, systemPrompt: string): CompactHistory {
	const runProvider = chosen.provider;
	return (messages, model, observer, compactOptions) => compactWith({
		messages,
		model,
		provider: runProvider,
		// 调用方给了信号（分叉请求核对前缀不符时用它在发出前作废）就和子代理自己的合起来，不能盖掉。
		streamFn: (provider, summaryModel, context, streamOptions) => (options.summaryStream ?? streamAssistant)(provider, summaryModel, context, { ...streamOptions, retryPolicy: () => (options.getSettings?.() ?? options.settings).retryPolicy, signal: streamOptions?.signal ? AbortSignal.any([streamOptions.signal, controller.signal]) : controller.signal }),
		// 按发出去的那份工具表算：被延迟的 MCP 工具不在请求里（`tools/mcp-search.ts`）。
		overhead: textTokens(systemPrompt) + toolTokens(toolTable(allowed)),
		observer,
		force: compactOptions?.force,
		lineage: compactOptions?.lineage,
		artifacts: options.addresses?.artifacts,
	});
}
