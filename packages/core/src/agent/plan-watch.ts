/**
 * 清单跟着事走：循环里和任务清单有关的三句话，什么时候说、说什么。
 *
 * - 单独调一次 `todo_write`：在那条结果末尾说一句（`SOLO_TODO_NOTE`）。
 * - 跑了 `PROGRESS_EVERY` 次请求没汇报：两轮之间问一句进度（`stalePlanNote` / `PROGRESS_NOTE`）。
 * - 正文写完了清单却还有「正在做」：收尾前问一次（`openPlanNote`）。
 *
 * 都只问不停，停不停由循环和续跑链决定。从 `loop.ts` 拆出来，是因为这三件事共用一份状态（问没问过、
 * 多久没汇报），而循环只需要知道「这里有没有一句话要说」。演进和实测数字见
 * docs/architecture/agent-loop.md 的「清单跟着事走」。
 */

import { readTodos, todoTool, type TodoItem } from "../tools/todo.ts";
import type { AssistantContent, AssistantMessage, Tool, ToolResultMessage } from "../types.ts";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

/** Appended to a lone todo_write's result. The wording names the cost, not just the rule. */
export const SOLO_TODO_NOTE =
	"（这一轮只调了 todo_write，没有做任何实际工作。从下一轮起，把清单更新和真正的下一步——读文件、改代码、跑命令——放在同一次回复里；单独更新清单是浪费一次往返。）";

/**
 * 多少次请求没汇报进度就问一句。按请求数，和续跑上限是同一把尺子。
 *
 * 20 是在本机 367 次运行上重放出来的：301 次在 20 次请求以内做完，从头到尾不会被问；原来按 10 轮
 * 念清单的那句在同一批会话上要说 50 次，这条说 40 次。说过就重新计数，所以两次之间也至少隔这么多次。
 */
export const PROGRESS_EVERY = 20;

/**
 * 有清单时，汇报就是对一遍清单：只认 `todo_write`，嘴上说了不算——界面上那张清单不会因为它说了一句
 * 而往前走。`2333f4e9` 每隔几轮就说一句，清单却从第 4 次请求停在 1/5 直到收尾。
 *
 * 和重复提示一样夹在两轮之间，跟着下一次请求发出去，不单独占一次请求。不接在工具结果末尾：那一轮
 * 最后一条常常是报错，模型的注意力全在报错上，接在后面的话 2333f4e9 重放三次一次都没被读到。措辞也量
 * 过：「下一次有实际动作时顺手勾掉」是一句可以往后拖的话，五次里只照做一次；「现在就对一遍、这次回复里
 * 带上」五次全照做，四次和下一步放在同一次回复里。
 */
export function stalePlanNote(todos: TodoItem[]): string {
	return `（自动提示）任务清单已经 ${PROGRESS_EVERY} 次请求没更新了，当前是：\n${todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`).join("\n")}\n` +
		"现在就对一遍：已经做完的勾成 completed，正在做的标 in_progress。这次回复里带上 todo_write，和你的下一步操作放在一起。";
}

/**
 * 没有清单时，汇报就是对人说一句话。只问现状，不要它补一份计划：简单的活不需要清单，长出来的活也
 * 不该因为跑得久就被要求先拆步骤。「接着做、不要停下来等」是必须的——只回一段正文的回复会结束这一轮。
 *
 * 只问在做什么，不问做完了什么：后者等于要一份阶段性结论，而这时证据多半还没收齐。`9db78fc1` 排查一半
 * 被问到，答了一句「没有真文件夹，全是软链接」，错的，得用户打断来纠正。
 */
export const PROGRESS_NOTE =
	`（自动提示）你已经连续 ${PROGRESS_EVERY} 次请求没有对用户说过话了。这次回复里先用一两句话说明现在在做什么、下一步做什么；` +
	"不要给阶段性结论，没核实的发现别说成定论。然后在同一次回复里接着调用下一步的工具，不要停下来等回复。不需要为此新建任务清单。";

/** Said once when a run ends on prose while its plan still claims a step is under way. */
export function openPlanNote(open: TodoItem[]): string {
	return `（自动提示）任务清单里还有 ${open.length} 项没勾：\n${open.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n")}\n` +
		"已经做完的，用 todo_write 勾成 completed；要等用户回复的保持原样；真是漏做了，就接着做完。" +
		"只更新清单时不要写正文——上面的回答用户已经看到了。";
}

/** 一次运行里的清单状态。每次 `runAgent` 一只。 */
export class PlanWatch {
	private readonly state: Map<string, unknown>;
	private readonly tools: readonly Tool[];
	/** `asked`：正在处理的这条回复是在回答 `openPlanNote`。一次运行只问一次，之后是 `spent`。 */
	private check: "unasked" | "asked" | "spent" = "unasked";
	/** 这条带工具的回复是在回答 `openPlanNote`——跑完工具后由 `settled` 读。 */
	private settling = false;
	/** 上次汇报（或被问）以来的请求数。 */
	private unreported = 0;

	constructor(state: Map<string, unknown>, tools: readonly Tool[]) {
		this.state = state;
		this.tools = tools;
	}

	/** 一条只有正文的回复到了。它要是在回答 `openPlanNote`，这个问题就用掉了。 */
	replied(): void {
		this.answered();
	}

	/** 一条带工具的回复要跑了：交回接在每条成功结果末尾的那句话，没有就是 `undefined`。 */
	beforeTools(toolCalls: ToolCall[]): string | undefined {
		this.settling = this.answered();
		/*
		 * A reply that only updated the list did nothing else. Said in that call's own result, where the
		 * model reads next. Measured before this: nearly half the tool turns on a three-step task were a
		 * lone todo_write.
		 */
		const solo = !this.settling && toolCalls.length === 1 && toolCalls[0].name === todoTool.name && this.tools.length > 1;
		return solo ? SOLO_TODO_NOTE : undefined;
	}

	/** 回答 `openPlanNote` 时只动了清单：回答在上面，人已经看过了，不再要一段新正文。 */
	settled(toolCalls: ToolCall[], toolResults: ToolResultMessage[]): boolean {
		return this.settling && toolCalls.every((call) => call.name === todoTool.name) && toolResults.every((result) => !result.isError);
	}

	/**
	 * 跑得久了，问它一句做到哪了。什么算「汇报过」看手上有没有没做完的清单，见 `stalePlanNote` 与
	 * `PROGRESS_NOTE`。只问不停：问过还不说的，2026-10-11 重放里唯一一次是一场改了 30 次文件的真实工作
	 * （`c3b2b5f0`），按「不汇报」叫停就是 `repetition.ts` 顶上记着的那次误伤再来一遍。
	 */
	progress(assistant: AssistantMessage, toolCalls: ToolCall[]): string | undefined {
		const todos = this.listing() ? readTodos(this.state) : [];
		const open = todos.some((todo) => todo.status !== "completed");
		const spoke = assistant.content.some((part) => part.type === "text" && part.text.trim() !== "");
		if (toolCalls.some((call) => call.name === todoTool.name) || (!open && spoke)) {
			this.unreported = 0;
			return undefined;
		}
		this.unreported += 1;
		if (this.unreported < PROGRESS_EVERY) return undefined;
		this.unreported = 0;
		return open ? stalePlanNote(todos) : PROGRESS_NOTE;
	}

	/**
	 * 正文写完了，清单却还说某一步「正在做」：问它一次。
	 *
	 * 不违背「有正文就交还给人」：这不是替它续跑，它可以原样保留清单结束。要问是因为漏勾很常见——
	 * 2026-10-10 `2333f4e9` 五步全做完，思考里写着「Let me finalize the todos」，回复里却没有这次调用，
	 * 清单停在 1/5，界面说它停在第 2 步。`turn-checks.ts` 把它排在 Stop 钩子后面，钩子看到的是真正的回答。
	 *
	 * 只看 in_progress：一轮都收尾了还说「正在做」，清单和事实自相矛盾。剩下的全是 pending，是它有意
	 * 停在那一步前面（多半在等人确认）——真实模型上量过，那种情况问了也只是原样再交一遍清单，白花一次请求。
	 */
	closing(turnsLeft: boolean): string | undefined {
		const open = readTodos(this.state).filter((todo) => todo.status !== "completed");
		if (!open.some((todo) => todo.status === "in_progress") || this.check !== "unasked" || !turnsLeft || !this.listing()) return undefined;
		this.check = "asked";
		return openPlanNote(open);
	}

	/** Whether the reply being handled answers `openPlanNote`. Either way the question is spent. */
	private answered(): boolean {
		if (this.check !== "asked") return false;
		this.check = "spent";
		return true;
	}

	private listing(): boolean {
		return this.tools.some((tool) => tool.name === todoTool.name);
	}
}
