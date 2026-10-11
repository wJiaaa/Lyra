/**
 * 子代理的运行：把它的事件转出去，一段一段地跑到检查点，必要时讨一份交接。
 *
 * `runSubAgent` 的中间一段。进来时它已经上了名单、拿到了名额（`sub-agent-dispatch.ts`），出去时
 * 交回跑出来的一切，由 `sub-agent-finish.ts` 拼成交给派它那一方的答案。抛出的异常在这里记账，
 * 名额和停止信号的挂钩也在这里还掉。
 */

import { sessionPruner } from "../agent/aged-prune.ts";
import type { AgentEventSink } from "../agent/events.ts";
import type { AgentRunResult } from "../agent/run-config.ts";
import { runTurn } from "../agent/runner.ts";
import { CODE_INTEL_KEY, CodeIntelManager } from "../lsp/manager.ts";
import type { PromptContext } from "../prompt/context.ts";
import { TODOS_KEY, type TodoItem } from "../tools/todo.ts";
import type { JsonSchema, Message, Tool } from "../types.ts";
import { continueWhileWorkRemains, type ContinuationDeps } from "./continuation.ts";
import type { SubAgentOptions } from "./sub-agent-options.ts";
import { subAgentRunConfig } from "./sub-agent-config.ts";
import type { Dispatched } from "./sub-agent-dispatch.ts";
import { makeYieldTool, YIELD_KEY } from "./yield-tool.ts";

/**
 * 一个没有声明输出格式的子代理，到检查点时交的那份交接。
 *
 * `general` 之前在这里什么都不交：只有带 schema 的子代理有补交的那一轮，其余的交回的是「停下前
 * 最后说的话」——一个读文件读到一半被截断的子代理，最后说的多半是「让我再看看 xxx」。
 *
 * 三个字段对着续跑的人要问的三件事，缺一不可：已经知道了什么（别再查一遍）、还差什么（接下来
 * 干什么）、打算怎么干（接手的人照着走，或者改道）。
 */
export const HANDOFF_SCHEMA: JsonSchema = {
	type: "object",
	required: ["summary", "remaining"],
	properties: {
		summary: { type: "string", description: "已经做完了什么、查到的关键事实——带上 `path:line`，接手的人不用再查一遍。" },
		remaining: { type: "string", description: "还没做完的部分，以及卡在哪。" },
		next: { type: "string", description: "你打算接下来怎么做——接着跑的时候照这个走。" },
	},
};

/** 跑完之后交给收尾的东西。 */
export interface SubAgentRan {
	result: AgentRunResult;
	/** Every round's messages, so the prose fallback can see what the last one said. */
	produced: Message[];
	/** 模型此刻眼里的历史，留给续跑。 */
	view: Message[];
	/** Whether the extra round got a delivery out of it, which changes what the answer says. */
	salvaged: boolean;
	steps: string[];
}

export async function runDispatched(
	options: SubAgentOptions,
	dispatched: Dispatched,
	setup: {
		prompt: PromptContext;
		history: Message[];
		checkpoint: number;
	},
): Promise<SubAgentRan> {
	const { id, controller, subState, allowed, yieldTool, release, detach } = dispatched;
	const { history, checkpoint } = setup;
	const { systemPrompt, sections } = setup.prompt;
	const registry = options.registry;
	const steps: string[] = [];

	/** Everything on its way out of the loop: the pane, the roster, and the step list. */
	const relay: AgentEventSink = async (event) => {
		// `notice` 也转：拒收恢复、超长压缩后重试这类说明是它自己的事，进它自己的面板。
		if (event.type === "tool_start" || event.type === "tool_left" || event.type === "request" || event.type === "retry" || event.type === "retry_settled" || event.type === "agent_end" || event.type === "turn_start" || event.type === "compacted" || event.type === "command_status" || event.type === "notice") {
			await options.emit({ type: "subagent_event", id, event });
		}
		// Record activity in registry for live sub-agent status line without toast spamming
		if (event.type === "tool_start") {
			steps.push(event.summary);
			registry?.activity(id, event.summary);
		}
		/*
		 * 卡在重连上也是一种状态，而且是最该说出口的那种。
		 *
		 * 这两行之前不存在：子代理的 `retry` 只进了转录，面板不认识它，主对话的抖动提示也不解包
		 * `subagent_event`（见 `apply-event.ts`）。于是一个正在反复重连的子代理，在界面上和一个
		 * 正在安静干活的子代理长得一模一样——派它来的人只看见一个一直转的 task，没有任何线索说明
		 * 它在等什么、等了多少次。
		 */
		if (event.type === "retry") registry?.retrying(id, { attempt: event.attempt, reason: event.reason });
		if (event.type === "retry_settled") registry?.retrying(id, undefined);
		/*
		 * The transcript, as it is written.
		 *
		 * `message_end` rather than `message_start`: a message still streaming has nothing worth
		 * showing yet. These carry the sub-agent's own id and go nowhere near the parent model
		 * transcript — durable events keep them available after reopening.
		 */
		if (event.type === "message_end") {
			// A steered message was announced when it was said (`steerSubAgent`); once is enough.
			if (registry?.record(id, event.message) === false) return;
			await options.emit({ type: "subagent_message", id, message: event.message });
		}
	};

	/**
	 * Whether it is worth asking once more for a delivery.
	 *
	 * Only for a run that stopped at a checkpoint with work left and has not already yielded — any
	 * definition, not only the ones that declare a schema: a `general` sub-agent cut off at the
	 * checkpoint used to hand back whatever sentence it happened to say last. An aborted one is
	 * excluded on purpose: stopping it was somebody's decision, and spending another request would
	 * be arguing with it.
	 */
	const needsFinalYield = (reason: AgentRunResult["reason"]) =>
		reason === "max_turns" && subState.get(YIELD_KEY) === undefined && !controller.signal.aborted;

	let result: AgentRunResult;
	const produced: Message[] = [];
	/**
	 * 模型眼里的历史，随着每一段往前走——续跑、检查点之后接着跑，都接在它后面。
	 *
	 * 讨交接的那一轮不算进来：那是跟派它来的人的一次交代，不是它干活的一部分。续跑时它从交代
	 * 之前的地方接着干，「这是最后一轮、只剩 yield」那句话不该出现在它往后的历史里。
	 */
	let view: Message[] = history;
	let salvaged = false;
	const pruner = sessionPruner(subState);
	// What its compaction cut goes to the log as well, or a restart resends it whole (`subagent_views`).
	pruner.onAdopt = (views) =>
		void options.emit({ type: "subagent_views", id, views: views.flatMap(({ source, view }) => (source.role === "toolResult" ? [{ toolCallId: source.toolCallId, message: view }] : [])) }).catch(() => {});
	try {
		await options.emit({ type: "subagent_event", id, event: {
			type: "context", systemPrompt, tools: allowed.map(tool => tool.name),
			skills: options.skills.map(skill => skill.name), sections,
			schemas: allowed.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		} });
		const runConfig = await subAgentRunConfig(options, dispatched, { systemPrompt, history, pruner, checkpoint });
		/** 跑一段，并记下模型此刻眼里的历史。 */
		const segment = async (messages: Message[]): Promise<AgentRunResult> => {
			const ran = await runTurn({ ...runConfig, session: { ...runConfig.session, messages } }, relay);
			produced.push(...ran.messages);
			view = ran.view ?? [...messages, ...ran.messages];
			return ran;
		};

		/*
		 * 到了检查点，清单在往前推就接着跑。
		 *
		 * 判据和主会话的续跑链是同一个，直接用它：清单里还有没做完的、并且这一段确实打了勾，就再
		 * 跑一段；连着两段一项没完成、或者根本没写清单，就停下来交接。这条判据在主会话上用真实事故
		 * 校准过（见 `continuation.ts` 顶上那段），不是另起一个「它是不是在瞎忙」的猜测——那种猜测
		 * 试过两次，两次都误伤了真实工作（`repetition.ts` 顶上）。
		 *
		 * 提示发到它自己的面板上，不进主对话：那是它的事。
		 */
		const checkpoints = {
			run: segment,
			messages: () => view,
			todos: () => (subState.get(TODOS_KEY) as TodoItem[] | undefined) ?? [],
			aborted: () => controller.signal.aborted,
			notify: (notice: Parameters<ContinuationDeps["notify"]>[0]) => options.emit({ type: "subagent_event", id, event: { type: "notice", level: "info", ...notice } }),
			// 没写清单就撞上检查点的，再给一段——见 `ContinuationDeps.planless`。
			planless: () => planDemand(checkpoint),
			resuming: () => {},
			signal: controller.signal,
			// 请求那一层已经按设置重试过了，外面这层不再加码——理由见 `session-turn.ts` 同一处。
			requestRetriesHandled: true,
		};
		result = await continueWhileWorkRemains(await segment(history), checkpoints);
		/*
		 * 收尾时有人对它说了话，还没送进去。
		 *
		 * 循环到了检查点就不再取插话（取了也送不进下一轮），话留在登记簿里；而登记簿收场时会把它
		 * 清掉——面板上那句话发出去了，它却再也读不到。所以接着跑一段：循环顶上照常取走、写进转录，
		 * 跟跑到一半时插话是同一条路。停在检查点的也一样：人开了口，是否接着干不该由清单替他决定。
		 * 主会话的同一件事由 `AgentSession.drainPending` 兜着。
		 */
		const heardMore = () => !controller.signal.aborted && registry?.hasSteering(id) === true;
		while ((result.reason === "done" || result.reason === "max_turns") && heardMore()) {
			result = await continueWhileWorkRemains(await segment(view), checkpoints);
		}

		/*
		 * 停在检查点、还有活没干完时，讨一份交接回来。
		 *
		 * 有 schema 的子代理只认 `yield`——没调用就等于什么都没交。没有 schema 的，从前连这一轮都
		 * 没有，交回的是它停下前最后说的那句话：一个读文件读到一半被截断的子代理，最后说的多半是
		 * 「让我再看看 xxx」。四个 explore 各跑了半小时、一份报告都没有，就是这么来的。
		 *
		 * 所以再给一轮，工具表里只剩 `yield`——没有 schema 的用交接那一份（做了什么、还剩什么、
		 * 下一步）。它没有别的事可做，只能交。两轮而不是一轮：字段填错时校验会退回来，留一次改正的
		 * 机会比让整轮白费划算。
		 *
		 * 交完它并没有被扔掉：上下文留着（`view` 停在这一轮之前），派它来的那一方可以续跑。
		 *
		 * 只在这一种收尾上做。`stalled` 是它在原地打转，再问一次多半还是同一个圈；上游出错时
		 * 连接本身就是坏的；被人按停的那次，用户要的就是它别再花钱了。
		 */
		if (needsFinalYield(result.reason)) {
			const handoff = yieldTool ?? makeYieldTool(HANDOFF_SCHEMA, { mode: "permissive" });
			const salvage = await runTurn(
				{
					session: {
						...runConfig.session,
						// 模型眼里的那一份：压缩过就是压缩过的。从前拼的是完整原文，压缩过的子代理在这一轮又撑爆一次。
						messages: [...view, finalDemand(checkpoint)],
						pruner: undefined,
						artifacts: undefined,
					},
					// 同一个模型、同一个 cacheKey：讨交接这一轮接的也是同一份 `view`，前缀大半相同。
					model: runConfig.model,
					tools: {
						// 只有 yield。剩下的工具都拿走，它就没有第二条路可走了。
						available: [handoff as unknown as Tool],
						env: { ...runConfig.tools.env, spawnSubAgent: undefined },
						requestApproval: runConfig.tools.requestApproval,
						beforeToolCall: undefined,
						afterToolCall: undefined,
						permissionRequest: undefined,
					},
					control: {
						signal: controller.signal,
						drainSteering: undefined,
						onStop: undefined,
						repetition: undefined,
						maxTurns: 2,
					},
				},
				relay,
			);
			produced.push(...salvage.messages);
			salvaged = subState.get(YIELD_KEY) !== undefined;
		}
	} catch (error) {
		/*
		 * A run that threw has to be marked, or it stays "running" for the life of the session.
		 *
		 * The throw is re-raised: `task` turns it into a tool error for the parent, which is how
		 * the model finds out. This only makes sure the record agrees with what happened.
		 */
		registry?.finish(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
		await options.emit({ type: "subagent_done", id, steps, answer: "", status: "failed", error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		// 模型那部分跑完了，名额先还：后面只剩记账，排着的下一个不该等它记完。
		release?.();
		detach();
		/*
		 * A delegated run has its own state map, so anything heavy it started is its own to stop.
		 *
		 * The session's `dispose` cannot reach this one — it looks at the session's map, and a
		 * sub-agent's is deliberately separate so its file reads and todo list stay out of the
		 * parent's. Which means a sub-agent that called `lsp` would leave a language server running
		 * for the life of the process, once per dispatch.
		 */
		const codeIntel = subState.get(CODE_INTEL_KEY);
		if (codeIntel instanceof CodeIntelManager) await codeIntel.dispose().catch(() => {});
		// 状态图会留下来给续跑用，一个已经关掉的语言服务不能跟着留下——续跑时要用，就让它重新起一个。
		subState.delete(CODE_INTEL_KEY);
	}
	return { result, produced, view, salvaged, steps };
}

/**
 * The message that spends the salvage round.
 *
 * Blunt, and it has to be: the round it opens has one tool on the table and one thing worth doing
 * with it. "不完整也要交" is the important half — a model that has been told it is out of budget
 * will otherwise apologise for not finishing and deliver nothing, which is the failure this whole
 * round exists to prevent.
 *
 * 「上下文会留着」也要说：交接是写给接着干的人看的，包括它自己。知道自己可能被续跑的模型，
 * 会把「下一步」写成能照着走的样子，而不是一句「时间不够了」。
 *
 * `synthetic`, because the runtime is speaking. It has to be a user message for the model to take
 * it as an instruction, and the pane must not draw it as something the person typed.
 */
function finalDemand(rounds: number): Message {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`（自动追加）到检查点了：这一段的 ${rounds} 轮已经用完，你手上只剩 \`yield\` 一个工具。` +
					"按它的字段把目前的进展交上去：做完了什么、查到的关键事实（带 `path:line`）、还剩什么没做、下一步打算怎么做——" +
					"没有对应字段的写进 `summary`。不完整也要交。" +
					"你的上下文会原样留着，派你来的人可能让你从这里接着做。不调用 `yield`，他就什么都拿不到。",
			},
		],
		timestamp: Date.now(),
		synthetic: true,
	};
}

/**
 * 没写清单就撞上检查点时，接着跑的那一段以这句话开头。
 *
 * 两条路都给：列清单接着做，或者现在收尾。只给第一条的话，一个其实已经查够了的子代理会为了
 * 「有清单」而硬凑三项、再跑六十轮；只给第二条，就退回了从前那一刀。
 *
 * `synthetic`：这是运行时在说话，不是派它来的人。
 */
function planDemand(rounds: number): Message {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text:
					`（自动追加）这一段的 ${rounds} 轮用完了。还没做完的话，先用 \`todo_write\` 把剩下的步骤列出来再接着做——` +
					"之后每到检查点，清单在往前推就会让你继续；手上的信息已经够了，就现在收尾交付。" +
					"接下来把互不依赖的读取和搜索放在同一条回复里一起发。",
			},
		],
		timestamp: Date.now(),
		synthetic: true,
	};
}
