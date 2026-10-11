/**
 * 派发准备：它是谁、能用哪些工具、跑哪个模型——然后上名单、排队拿名额。
 *
 * `runSubAgent` 的第一段。到这里为止它一轮都还没跑；排着队被停下的那一个也在这里收场，后面几段
 * （`sub-agent-run.ts`、`sub-agent-finish.ts`）不必认得它。
 */

import { randomUUID } from "node:crypto";
import { resolveSubAgentModel } from "../config/model-choice.ts";
import type { ResourceRouter } from "../resources/router.ts";
import { SKILLS_KEY } from "../skills/tool.ts";
import { AGENTS_KEY, BUILTIN_AGENTS, type AgentDefinition } from "../tools/task.ts";
import { todoTool } from "../tools/todo.ts";
import type { JsonSchema, Message, ModelConfig, ProviderConfig, Tool } from "../types.ts";
import { DispatchCancelled } from "./dispatch-guard.ts";
import { buildRouter } from "./session-capabilities.ts";
import { scratchDir } from "./session-facts.ts";
import type { SubAgentAnswer, SubAgentOptions, SubAgentRequest } from "./sub-agent-options.ts";
import type { SubAgentConversation } from "./sub-agents.ts";
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

/**
 * 交接用的 `yield` 怎么介绍自己。
 *
 * 不能用带 schema 的那一句（「做完必须调用、正文送不到」）：没有 schema 的子代理做完了就是用正文
 * 回答，那句话会把每一次正常收尾都变成一份 summary/remaining 的交接。它从派发起就在工具表里，
 * 只是为了讨交接那一轮的工具表不变（见 `dispatchSubAgent` 里挂上它的那一段）。
 */
const HANDOFF_DESCRIPTION =
	"Hand over unfinished work to whoever dispatched you. Call this only when you are told you have reached a checkpoint; " +
	"calling it ends your run. When you finish the task, answer in plain text instead — that is how a finished answer is delivered.";

/** 面板上按停时 `abort` 带的理由，用来跟「父会话整轮被停」分开。 */
export const STOPPED_BY_USER = "stopped-by-user";

/**
 * Every shipped scheme but `agent://`. Its data (`SUBAGENTS_KEY`) is the session's roster, and a
 * sub-agent has no business reading its siblings' transcripts — it was handed a task, not the session.
 */
const SUB_AGENT_SCHEMES = ["skill", "scratch", "plume", "session", "plugin", "mcp", "artifact"];

/** 一个已经上了名单、拿到了名额的子代理：后面几段要用的全在这里。 */
export interface Dispatched {
	/** 续跑的那一个；新派的没有。 */
	earlier: { id: string; conversation: SubAgentConversation } | undefined;
	definition: AgentDefinition;
	/** 派它时说的那一句「去做什么」：名单、授权卡片上都用它认人。 */
	description: string;
	id: string;
	chosen: ReturnType<typeof resolveSubAgentModel>;
	allowed: Tool[];
	subState: Map<string, unknown>;
	resources: ResourceRouter;
	scratch: string;
	controller: AbortController;
	/** 不再听父会话的停止信号。 */
	detach: () => void;
	/** 把名额还回去；没排队的没有。 */
	release: (() => void) | undefined;
	opening: Message;
}

export async function dispatchSubAgent(
	options: SubAgentOptions,
	input: SubAgentRequest,
	provider: ProviderConfig,
	model: ModelConfig,
): Promise<Dispatched | { stopped: SubAgentAnswer }> {
	const earlier = input.resume === undefined ? undefined : resumable(options, input.resume);

	// 续跑的时候不换人：它是谁，当初派出去时就定了。
	const wanted = earlier ? earlier.conversation.agent : input.agentType ?? "general";
	const definition = options.agents.find((a) => a.name === wanted) ?? BUILTIN_AGENTS[0];
	/*
	 * 清单总在：它是子代理自己的记事本，不是一件能力。
	 *
	 * 定义里的 `tools` 管的是它能对世界做什么——`review` 只读，所以没有 `write`。`todo_write`
	 * 什么都不碰，写的是它自己状态图里的一张单子；而检查点上「要不要接着跑」看的正是这张单子
	 * （`continuation.ts`）。一个只读审查者没有它，就只能在第六十轮被一刀切下，不管它读到哪了。
	 */
	const fromSession =
		definition.tools === "*"
			? options.tools
			: options.tools.filter((t) => (definition.tools as string[]).includes(t.name) || t.name === todoTool.name);

	/*
	 * 子代理不派子代理：`task` 不进它的工具表，不管定义里写了什么。
	 *
	 * 拿掉工具而不是等它调了再拒：模型不会想要一个没见过的工具，事后报错要多花一轮才发现这条路本来
	 * 就走不通。拆活是主会话的事——它看得见全局，派出去的每一个也都在它的名单和闸门里。
	 */
	const withoutTask = fromSession.filter((tool) => tool.name !== "task");
	// A resumed run keeps the id it had: same row on the roster, same transcript, same `agent://`.
	const id = earlier?.id ?? `${options.sessionId}:sub:${randomUUID().slice(0, 8)}`;

	// Local preferences override portable definitions; an explicit missing model is an error.
	const chosen = resolveSubAgentModel(options.getSettings?.() ?? options.settings, definition, { provider, model });

	/*
	 * A declared output shape turns the reply into an object.
	 *
	 * Built per run because the tool carries the attempt counter — a fresh one each dispatch, so a
	 * sub-agent that used up its retries does not hand a spent budget to the next one.
	 *
	 * 没有声明的也从这里起就带着交接那一份。不是要它中途交，是讨交接那一轮（`sub-agent-run.ts`）
	 * 的工具表必须和前面每一轮逐字节相同：工具定义排在请求最前面，从前到检查点才把 `yield` 塞进来，
	 * 整段前缀缓存从第 0 字节起作废，一次就是几十万 token 按原价重算。
	 */
	const yieldTool = definition.output
		? makeYieldTool(definition.output, { mode: definition.schemaMode })
		: makeYieldTool(HANDOFF_SCHEMA, { mode: "permissive", description: HANDOFF_DESCRIPTION });
	const allowed = [...withoutTask, yieldTool as unknown as Tool];
	/*
	 * 续跑的用它原来那一份：清单、读过哪些文件、裁剪器都在里面。丢了它，它要改一个文件得先
	 * 重读一遍，清单也得从头写——那正是续跑要省下的东西。
	 */
	// The sub-agent gets its own message list and its own state map, so its file reads and
	// todo list cannot leak into the parent's.
	const subState = earlier?.conversation.state ?? new Map<string, unknown>();
	for (const [key, value] of options.addresses?.lookups ?? []) subState.set(key, value);
	const resources = buildRouter(SUB_AGENT_SCHEMES);
	const scratch = options.addresses?.scratchDir ?? scratchDir(options.sessionId);
	subState.set(SKILLS_KEY, options.skills);
	subState.set(AGENTS_KEY, options.agents);
	// 上一段交的东西说的是上一段。这一段要交，就得自己再交一次——否则一次什么都没交的续跑会把旧的那份当成新结论。
	subState.delete(YIELD_KEY);

	/*
	 * Its own controller, chained to the parent's.
	 *
	 * Two things must be able to stop this run and they are not the same thing: the session going
	 * away, which stops everything, and someone deciding *this* sub-agent is wedged, which must
	 * leave the parent and its siblings alone. Chaining gives the first without conceding the
	 * second — aborting here is local, aborting upstream still reaches here.
	 */
	const controller = new AbortController();
	const stopWithParent = () => controller.abort();
	options.signal?.addEventListener("abort", stopWithParent, { once: true });
	const detach = () => options.signal?.removeEventListener("abort", stopWithParent);
	const registry = options.registry;
	/*
	 * 面板上按停的那一下，要认得出是人按的。
	 *
	 * 父会话整轮被停和这一个被单独按停，落到这里都是 `abort`。前者整件事都停了，没人会读结果；
	 * 后者父会话还在跑，会读到它交回的东西——它得知道这是人的决定，别转头就让它接着跑。
	 */
	const stopByUser = () => controller.abort(STOPPED_BY_USER);
	// 要排队的，先以「排队中」上名单——排着的时候也看得见、停得下。
	const queued = options.admission !== undefined;
	if (earlier) registry?.reopen(id, { abort: stopByUser, queued });
	else
		registry?.start({
			id,
			agent: definition.name,
			description: input.description,
			abort: stopByUser,
			queued,
		});
	options.onRegistered?.(id);
	// 续跑的那一个，排着队被停也还留着上一段的上下文（见下面的 `keep`），从这里起就能再续。
	if (earlier && registry) input.onResumable?.(id);
	/*
	 * What it was asked to do, as the first line of its transcript.
	 *
	 * The loop only announces messages it *produces*, and the dispatch prompt is one it was handed —
	 * so without this the pane opened onto the sub-agent's replies with nothing to say what it had
	 * been told, which is the one piece of context a reader has none of. It is also the thing worth
	 * checking first when a sub-agent goes the wrong way: usually the prompt sent it there.
	 */
	// 派它出去的那一方说的，不是看着面板的人——面板据此把它画成任务，而不是一个人发的气泡。
	const opening: Message = { role: "user", content: [{ type: "text", text: input.prompt }], timestamp: Date.now(), origin: "parent" };
	registry?.record(id, opening);
	/*
	 * 续跑的这一句是转录中间新添的，要单独发出去。
	 *
	 * 新派的那一句不用：`subagent` 事件里带着它，面板打开时从登记簿整份读。而续跑时面板多半
	 * 正开着，只收增量——不发，这一句就只在登记簿里，屏幕上看到的是它没头没尾地又动起来了。
	 */
	if (earlier) await options.emit({ type: "subagent_message", id, message: opening });

	await options.emit({
		type: "subagent",
		id,
		agent: definition.name,
		description: input.description,
		prompt: input.prompt,
		tools: allowed.map((tool) => tool.name),
		provider: chosen.provider.id,
		model: chosen.model.modelId,
		...(earlier ? { resumed: true } : {}),
	});

	/*
	 * 排队：拿到名额才开跑。
	 *
	 * 排着的时候被停（人在面板上按停、整个会话被停），当场离队、记作停下，一轮都不跑。从前闸门
	 * 在调用方那一层，排着的那几个既不在名单上、也听不到停止——会话停下之后，前面的一跑完，它们
	 * 照样被放进来，对着一个已经停下的会话开跑。
	 */
	let release: (() => void) | undefined;
	if (options.admission) {
		try {
			release = await options.admission(controller.signal);
		} catch (error) {
			detach();
			if (!(error instanceof DispatchCancelled)) {
				registry?.finish(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
			registry?.finish(id, { status: "aborted" });
			// 续跑的那一个还没动过：上一段留下的上下文原样放回去，以后照样能接着跑。
			if (earlier) registry?.keep(id, earlier.conversation);
			await options.emit({ type: "subagent_done", id, steps: [], answer: "", status: "aborted" });
			return {
				stopped: {
					text: "（它还在排队的时候就被停下了，一步都没做。）",
					...(registry ? { id } : {}),
					...(controller.signal.reason === STOPPED_BY_USER ? { stoppedByUser: true } : {}),
				},
			};
		}
		registry?.admit(id);
	}
	// 新派的拿到名额才有东西可留：从这里起，不管怎么停下，`finishSubAgent` 都会 `keep` 它的上下文。
	if (!earlier && registry) input.onResumable?.(id);

	return { earlier, definition, description: input.description, id, chosen, allowed, subState, resources, scratch, controller, detach, release, opening };
}

/**
 * 要续跑的那一个，以及能不能续。
 *
 * 不能续的各给一句能据以行动的话——`task` 会把它原样交给模型。
 */
function resumable(options: SubAgentOptions, wanted: string): { id: string; conversation: SubAgentConversation } {
	if (!options.registry) throw new Error("这里不保留子代理的上下文，没法续跑；重新派一个，并把之前交回的结论写进 prompt。");
	const found = options.registry.lookupResumable(wanted);
	if ("refusal" in found) throw new Error(found.refusal);
	return { id: found.id, conversation: found.conversation };
}
