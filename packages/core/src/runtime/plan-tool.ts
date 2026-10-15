/**
 * `submit_plan`：计划模式的出口。模型交计划，人批准或打回；批准那一刻开关关掉、步骤进清单。
 *
 * schema 沿用内置 `plan` 子代理的那份（步骤带文件、风险、未知项），不另造一种计划格式。
 * 审批走 `ask_user` 同一条交互式通道：它在三档权限下都会问人，full 档也不例外。
 */

import { errorResult } from "../tools/result.ts";
import { planTodos, TODOS_KEY } from "../tools/todo.ts";
import type { ApprovedPlan } from "../types/message.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { inPlanMode, PLAN_MODE_KEY } from "./plan-mode.ts";
import { normalizePlan, renderPlan, SUBMIT_PLAN_TOOL_NAME } from "./plan-view.ts";

/** 卡片上的两个选项。自由输入也接受：写了什么，什么就是打回的理由。 */
export const PLAN_APPROVE = "批准，开始执行";
export const PLAN_REVISE = "要改";

interface SubmitPlanArgs {
	title?: string;
	steps: { what: string; files?: string[] }[];
	risks?: string[];
	unknowns?: string[];
}

export const submitPlanTool: Tool<SubmitPlanArgs> = {
	name: SUBMIT_PLAN_TOOL_NAME,
	description:
		"Submit the plan for the user to approve. Available in plan mode only. Ordered steps, each a change somebody could make without " +
		"asking a follow-up question and naming the files it touches; the risks you can see; what you could not determine from the code. " +
		"Approval turns plan mode off and puts the steps on the task list. If the user asks for changes, revise and submit again.",
	parameters: {
		type: "object",
		properties: {
			title: { type: "string", description: "One line naming the change." },
			steps: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					required: ["what"],
					properties: {
						what: { type: "string", description: "The change, concretely." },
						files: { type: "array", items: { type: "string" }, description: "Project-relative paths this step touches." },
					},
				},
			},
			risks: { type: "array", items: { type: "string" }, description: "What could go wrong, and where. Empty is a valid answer." },
			unknowns: { type: "array", items: { type: "string" }, description: "What you could not determine from the code and would need to ask about." },
		},
		required: ["steps"],
	},
	executionMode: "sequential",
	// 只有会话本身能交计划：子代理的计划是报告，不是闸门。
	sessionOnly: true,
	summarize: (args) => `Plan: ${String(args.title ?? args.steps?.[0]?.what ?? "").slice(0, 40)}`,
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
			// 步骤就是清单。批准的计划是正本，之后 `todo_write` 改的是它的状态。
			ctx.state.set(TODOS_KEY, planTodos(plan.steps));
			return {
				content: [{ type: "text", text: `The user approved the plan${notes ? " with notes" : ""}. Plan mode is off; every tool is available again.\n\n${notes ? renderPlan(approved) : rendered}\n\nThe steps are now the task list. Start with step 1 and keep the list in step with the plan.${notes ? " The notes are the user's comments on this plan: follow them as you carry it out." : ""}` }],
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
