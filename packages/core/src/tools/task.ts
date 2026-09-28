import { errorResult } from "../agent/tool-run.ts";
import { SUBAGENTS_KEY } from "../resources/handlers.ts";
import { DISPATCH_KEY, refuseDispatch, rootDispatch, type DispatchContext } from "../runtime/dispatch-guard.ts";
import type { SubAgentRegistry } from "../runtime/sub-agents.ts";
import type { SubAgentAnswer, Tool, ToolResult } from "../types.ts";

export { BUILTIN_AGENTS, resolveAgentName, type AgentDefinition } from "../agents-builtin.ts";
import { resolveAgentName, type AgentDefinition } from "../agents-builtin.ts";

export const AGENTS_KEY = "agents";

interface TaskArgs {
	description: string;
	prompt: string;
	subagent_type?: string;
	resume?: string;
}

/**
 * Delegate work to a nested agent with its own context window.
 *
 * The point is context isolation: a search that reads forty files returns one paragraph to
 * the parent instead of forty file dumps.
 *
 * 什么活值得派，写在描述里，而且是固定的一段：不随推理等级、设置或这一轮说了什么变化。以前这件事
 * 放在系统提示里按推理等级换五种说法，档位变一次，提示词就要补发一次增量；而高档那几句「可以主动
 * 派」「放开编排」只说了倾向、没说标准，量到的是主代理把「给刚写的函数补测试」也派了出去——为了派，
 * 先在推理里把接口约定一条条写死，子代理从零开始又设计一遍。
 */
export const taskTool: Tool<TaskArgs> = {
	name: "task",
	description:
		"Run a sub-agent with its own context window and report back only its final answer. " +
		"A sub-agent starts from nothing: it cannot see your context, the prompt you write is all it knows, and what it reads and thinks never reaches you — only its conclusion does. " +
		"So two kinds of work are worth delegating: work whose intermediate output is large and whose conclusion is all you need (sweeping dozens of files for one answer, running something with long output to get its failures), " +
		"and a sizeable piece of work that does not depend on what you are doing. " +
		"Do everything else yourself: a change you can make in a step or two, part of what you are writing right now (such as tests for the function you just wrote), " +
		"or work you could only hand off after spelling out its interfaces and conventions — spelling those out costs as much as doing it. " +
		"Agents with write tools edit files directly, and their risky actions are asked of the user in this window like yours. " +
		"Several calls in one reply run in parallel and extra ones wait in a queue, so dispatch independent pieces together rather than one per reply. " +
		"When you run several at once, have each skip builds, lints and tests and verify once yourself at the end; pieces that need a shared interface which does not exist yet are not independent — write the interface first, or do not split. " +
		"The sub-agent cannot ask you questions, so put everything it needs in `prompt`. " +
		"Each call starts a fresh sub-agent with an empty context, unless you pass `resume` with the id of one you dispatched earlier: " +
		"then that same sub-agent continues with everything it already read and did, and `prompt` is what you tell it next. " +
		"A sub-agent that stopped before finishing keeps its context: continue it with `resume` rather than dispatching the same work again.",
	parameters: {
		type: "object",
		properties: {
			description: { type: "string", description: "3-5 word summary of the task." },
			prompt: {
				type: "string",
				description: "Self-contained instructions for the sub-agent. When resuming, what it should do next.",
			},
			subagent_type: { type: "string", description: "Which agent definition to use. Defaults to `general`. Ignored when resuming." },
			resume: {
				type: "string",
				description:
					"The id of a sub-agent you dispatched earlier (given at the end of its result). It continues from where it stopped, with its whole context — use this rather than dispatching the same work again.",
			},
		},
		required: ["description", "prompt"],
		additionalProperties: false,
	},
	summarize: (args) => args.description ?? "Sub-agent task",

	async execute(args, ctx): Promise<ToolResult> {
		if (!ctx.spawnSubAgent) return errorResult("Sub-agents are not available in this session.");
		if (typeof args.prompt !== "string" || !args.prompt.trim()) return errorResult("`prompt` is required.");

		/*
		 * `undefined` and `[]` mean different things, and conflating them switched the check off.
		 *
		 * `undefined` is a session that never registered a roster — a CLI path, a test — where
		 * refusing every name would break a caller doing its own resolution. `[]` is a session that
		 * registered one and it is empty, where the only honest answer to any name is that it does
		 * not exist. The old `agents.length > 0` guard read the two the same way, so in the empty
		 * case every name passed and a typo came back as a `general` sub-agent doing something
		 * adjacent to what was asked.
		 */
		const agents = ctx.state.get(AGENTS_KEY) as AgentDefinition[] | undefined;
		/*
		 * 续跑：它是谁由它当初被派出去时定下，不看这次的 `subagent_type`。
		 *
		 * 能在这里认出来就在这里拦——找不到、还在跑、上下文已经没了，都给一句能据以行动的话，
		 * 而不是一条「Sub-agent failed」。认不出来的（嵌套在子代理里、状态图里没有登记簿），交给
		 * `runSubAgent` 自己认，它同样只放行自己派出去的那些。
		 */
		const resuming = typeof args.resume === "string" && args.resume.trim() ? args.resume.trim() : undefined;
		const found = resuming ? (ctx.state.get(SUBAGENTS_KEY) as SubAgentRegistry | undefined)?.lookupResumable(resuming) : undefined;
		if (found && "refusal" in found) return errorResult(found.refusal);
		// 旧名先翻译一次：三天前的会话里那条 `task` 写的还是 `fast`，它指的人还在。见 `RENAMED_AGENTS`。
		const requested = found ? found.summary.agent : resolveAgentName(args.subagent_type ?? "general", agents ?? []);
		if (!resuming && agents && !agents.some((a) => a.name === requested)) {
			const available = agents.length > 0 ? agents.map((a) => a.name).join(", ") : "none are defined in this session";
			return errorResult(`Unknown subagent_type "${requested}". Available: ${available}.`);
		}
		// 名字只在认出来的时候可信；没认出来的续跑，下面按名字的那道关卡交给 `runSubAgent`。
		const named = !resuming || found !== undefined;

		/*
		 * 深度与自递归，在这里拦。
		 *
		 * 深度的主路径是把 `task` 从工具表里拿掉（见 `sub-agent.ts`）——模型不会想要一个没见过的
		 * 工具。这里是兜底，而且是**自递归**唯一能拦的地方：`explore → reviewer → explore` 这条
		 * 链只有在派生的那一刻才看得见，工具表看不出来。
		 *
		 * 没有链就是主会话——`undefined` 在这里的意思是「第 0 层」，不是「不检查」。
		 */
		const refusal = named ? refuseDispatch((ctx.state.get(DISPATCH_KEY) as DispatchContext | undefined) ?? rootDispatch(), requested) : null;
		if (refusal) return errorResult(refusal);

		try {
			const answer = await ctx.spawnSubAgent({
				description: args.description ?? "Sub-agent task",
				prompt: args.prompt,
				agentType: requested,
				...(resuming ? { resume: resuming } : {}),
			});
			/*
			 * The object rides in `details`, never flattened into the text.
			 *
			 * `content` is what the model reads and `details` is what the UI renders and what
			 * `agent://<id>/<field>` indexes into. Serialising the object into the text as well
			 * would put it in the parent's context twice — once as prose, once as JSON — which is
			 * the cost delegation exists to avoid.
			 */
			return {
				/*
				 * The fallback is now only for a clean finish that said nothing at all.
				 *
				 * Every other ending describes itself — see `incompleteNote` in `sub-agent.ts`. What is
				 * left is a run that stopped because it had nothing more to do and neither yielded nor
				 * wrote a word. Saying that in those terms matters: the parent's next move after "it
				 * finished and said nothing" is not the one it makes after "it was cut off partway".
				 */
				content: [
					{
						type: "text",
						text: withResumeHint(answer.text || "（子代理没有留下任何输出：既没有调用 `yield` 交付结果，也没有说任何话。）", answer),
					},
				],
				details: {
					kind: "task",
					description: args.description,
					agentType: requested,
					output: answer.output,
					warnings: answer.warnings?.length ? answer.warnings : undefined,
					...(answer.id ? { subAgentId: answer.id } : {}),
					...(resuming ? { resumed: true } : {}),
					// 父会话没等它跑完：卡片据此跟着登记簿画它的实时状态，而不是把这句「转到后台」当结论。
					...(answer.detached ? { detached: true } : {}),
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// 续跑被拒是一句该据以行动的话（找不到、还在跑、不是你派的），不是一次「失败」。
			return errorResult(resuming ? message : `Sub-agent failed: ${message}`);
		}
	},
};

/**
 * 结果末尾那一句：它还在，怎么接着用它。
 *
 * 只说给模型听——面板上的人有「接着跑」按钮，这段话不进登记簿、不进面板。没做完的那种要说得
 * 最重：「从零重派」是反馈里白烧 token 的那条路，而模型不被明说就会走它——它只知道任务没完成，
 * 不知道那个子代理还在。做完了的也给一个 id，追问一句它刚才的结论不该从头再查一遍。
 */
function withResumeHint(text: string, answer: SubAgentAnswer): string {
	if (!answer.id) return text;
	// 还在后台跑的，结果会自己送回来——这时候给一句「用 resume 追问它」，正好把模型往重复派活上引。
	if (answer.detached) return `${text}\n\n（子代理 id：\`${answer.id}\`。）`;
	if (answer.stoppedByUser) return `${text}\n\n（这个子代理是用户在面板上手动停下的。除非用户要求，不要续跑它。）`;
	if (answer.incomplete) {
		return (
			`${text}\n\n要它接着干：再调一次 \`task\`，传 \`resume: "${answer.id}"\`，prompt 里写接着做什么（可以照它交接里的下一步）。` +
			"它会带着全部上下文从停下的地方继续，只多付新增的轮次。**不要**重新派一个做同样的事——新派的从零开始，会把它读过的东西再读一遍。" +
			"剩下的不多，也可以自己接手。"
		);
	}
	/*
	 * 末尾那半句「这是材料」是说给正要写回答的那个模型的。
	 *
	 * 指引里也写了，但指引在系统提示词里、隔着几万字；模型写最后那段回答时，眼前是这几份结果。
	 * 没有这半句，几个子代理的结果一起回来时，它最顺手的写法就是按人头逐个转述——「子智能体 2：
	 * 核心逻辑……」——把它自己该做的合并推给了读的人（2026-09-26 的真实会话就是这么答的）。
	 */
	return `${text}\n\n（子代理 id：\`${answer.id}\`。要追问它、或让它在这个基础上接着做，用 \`task\` 的 \`resume\`。它交的是材料：回答用户时和别的结论合在一起、按问题组织。）`;
}
