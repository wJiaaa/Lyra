/**
 * `submit_plan`：计划模式的出口。模型交计划，人批准或打回；批准那一刻开关关掉。
 *
 * 计划是一段 Markdown（同 codex 的 `<proposed_plan>`），写什么由计划模式那段提示词说，不拆字段：
 * 拆成六栏时每份计划都被套成同一个样子，大小不分。计划也不是清单，批准时不往任务清单里写，
 * 怎么拆步由模型执行时自己记——曾经把步骤直接当清单，计划于是写成了一串动作。
 * 审批走 `ask_user` 同一条交互式通道：它在三档权限下都会问人，full 档也不例外。
 */

import { errorResult } from "../tools/result.ts";
import type { ApprovedPlan } from "../types/message.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { inPlanMode, PLAN_MODE_KEY } from "./plan-mode.ts";
import { normalizePlan, planTitle, renderPlan, SUBMIT_PLAN_TOOL_NAME } from "./plan-view.ts";

/** 卡片上的两个选项。自由输入也接受：写了什么，什么就是打回的理由。 */
export const PLAN_APPROVE = "批准，开始执行";
export const PLAN_REVISE = "要改";

interface SubmitPlanArgs {
	plan: string;
}

export const submitPlanTool: Tool<SubmitPlanArgs> = {
	name: SUBMIT_PLAN_TOOL_NAME,
	description:
		"Submit the plan for the user to approve. Available in plan mode only. Submit it only when it is decision complete: whoever " +
		"carries it out has nothing left to decide. It is not a task list. Approval turns plan mode off. If the user asks for changes, " +
		"submit a complete replacement.",
	parameters: {
		type: "object",
		properties: {
			plan: { type: "string", description: "The whole plan as Markdown, in the user's language: a title, a brief summary, the key changes, the test plan, the assumptions." },
		},
		required: ["plan"],
	},
	executionMode: "sequential",
	// 只有会话本身能交计划：子代理的计划是报告，不是闸门。
	sessionOnly: true,
	summarize: (args) => `Plan: ${planTitle({ plan: String(args.plan ?? "") }).slice(0, 40)}`,
	async execute(args, ctx: ToolContext): Promise<ToolResult> {
		if (!ctx.requestApproval) return errorResult("This host cannot ask the user, so no plan can be approved.");
		if (!inPlanMode(ctx.state)) return errorResult("Plan mode is off; there is nothing to approve. Do the work.");
		const plan = normalizePlan(args as unknown as Record<string, unknown>);
		if (typeof plan === "string") return errorResult(plan);

		const rendered = renderPlan(plan);
		const decision = await ctx.requestApproval({
			kind: "interactive", title: "审批计划", detail: rendered, subject: SUBMIT_PLAN_TOOL_NAME,
			options: [PLAN_APPROVE, PLAN_REVISE], allowCustomInput: true, selectionMode: "single", allowSkip: false,
		});

		if (typeof decision === "object" && "answer" in decision && decision.answer === PLAN_APPROVE) {
			// 批准时附上的评论是执行时的注意事项，不是打回：计划照批，评论随计划一起留下（压缩后也在）。
			const notes = decision.note;
			const approved: ApprovedPlan = { ...plan, ...(notes ? { notes } : {}), approvedAt: Date.now() };
			// 开关就地关掉：这一轮剩下的调用走的是同一张工具表，包着的 `execute` 从此放行。
			ctx.state.set(PLAN_MODE_KEY, false);
			return {
				content: [{ type: "text", text: `The user approved the plan${notes ? " with notes" : ""}. Plan mode is off; every tool is available again.\n\n${notes ? renderPlan(approved) : rendered}\n\nCarry it out now. If it takes three or more steps, break it into a task list with \`todo_write\` alongside your first action.${notes ? " The notes are the user's comments on this plan: follow them as you carry it out." : ""}` }],
				details: { kind: "plan", plan: approved },
			};
		}
		// 填表的回答（`values`）只来自 MCP 的 elicitation，这张卡片不会收到；按没有反馈处理。
		if (typeof decision === "object" && "answer" in decision) {
			const feedback = (Array.isArray(decision.answer) ? decision.answer.join("; ") : decision.answer).trim();
			const said = feedback && feedback !== PLAN_REVISE ? feedback : "no reason given";
			return {
				content: [{ type: "text", text: `The user did not approve the plan. Feedback: ${said}\n\nPlan mode stays on. Revise the plan and call \`${SUBMIT_PLAN_TOOL_NAME}\` again.` }],
				details: { kind: "plan-feedback", feedback: said },
			};
		}
		/*
		 * 拒绝、超时、没人在：没有反馈就没有可改的方向，这一轮停在这里，由人来说下一步。
		 * `terminate` 让循环不再多要一条正文——卡片本身已经说明了发生什么。
		 */
		return {
			content: [{ type: "text", text: "The plan was not approved and no feedback was given (declined, or nobody answered). Plan mode stays on; wait for the user." }],
			details: { kind: "plan-feedback", feedback: null },
			terminate: true,
		};
	},
};
