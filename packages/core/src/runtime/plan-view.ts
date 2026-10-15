/**
 * 计划模式里不碰 Node 的那一半：计划长什么样、会话历史里眼下是哪一份。
 *
 * 渲染进程经 `@plume/core/plan-view` 导入。`plan-mode.ts` 连着 `bash` 的只读判定，一路通到
 * `node:child_process`，浏览器从那里拿一个函数就是白屏，所以拆出这个只有类型依赖的文件。
 */

import type { ApprovedPlan, Message } from "../types/message.ts";

export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";

export type PlanDraft = Omit<ApprovedPlan, "approvedAt">;

/** 计划在转录、审批卡片、计划面板和压缩快照里长的样子。 */
export function renderPlan(plan: PlanDraft): string {
	const lines: string[] = [];
	if (plan.title) lines.push(`# ${plan.title}`, "");
	if (plan.current) lines.push("## 现状", plan.current, "");
	lines.push("## 方案", plan.approach);
	if (plan.changes.length) lines.push("", "## 改动", ...plan.changes.map((change) => `- \`${change.file}\`：${change.what}`));
	if (plan.verification.length) lines.push("", "## 验证", ...plan.verification.map((check) => `- ${check}`));
	if (plan.risks.length) lines.push("", "## 风险", ...plan.risks.map((risk) => `- ${risk}`));
	if (plan.unknowns.length) lines.push("", "## 未确定", ...plan.unknowns.map((unknown) => `- ${unknown}`));
	if (plan.notes) lines.push("", "## 执行时注意", plan.notes);
	return lines.join("\n");
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : []);

/** 模型交上来的参数整理成计划；不成形时返回说给模型听的那句错误。 */
export function normalizePlan(args: Record<string, unknown>): PlanDraft | string {
	const approach = text(args.approach);
	if (!approach) return "Describe the approach in `approach`.";
	if (!Array.isArray(args.changes) || args.changes.length === 0) return "List the files you will change in `changes`.";
	const changes: PlanDraft["changes"] = [];
	for (const change of args.changes as unknown[]) {
		const { file, what } = (typeof change === "object" && change !== null ? change : {}) as { file?: unknown; what?: unknown };
		const path = text(file);
		const edit = text(what);
		if (!path || !edit) return "Every change needs a nonempty `file` and `what`.";
		changes.push({ file: path, what: edit });
	}
	const verification = texts(args.verification);
	if (verification.length === 0) return "Say how you will verify the change in `verification`.";
	const title = text(args.title);
	const current = text(args.current);
	return { ...(title ? { title } : {}), ...(current ? { current } : {}), approach, changes, verification, risks: texts(args.risks), unknowns: texts(args.unknowns) };
}

export interface CurrentPlan {
	plan: PlanDraft;
	/** `approved` 批准了；`declined` 被打回或没人回答；`open` 还没有结果——在等审批，或者那一轮断在了半路。 */
	status: "approved" | "declined" | "open";
	/** 交这份计划的那次调用。压缩前批准、只剩快照的计划没有。 */
	toolCallId?: string;
}

/**
 * 会话里眼下的那份计划：最后一次交上来的，不论批没批。
 *
 * 不另存文件，直接从历史里读——交计划的调用和它的结果本来就在会话日志里，再写一份就是两处真相
 * （ADR-0044）。往回找：先遇到结果，再遇到它的调用。打回的计划也算「眼下的」：人要看的正是自己
 * 刚打回的那份，模型改完再交，新的那份自然排到最后。压缩以后调用可能已经不在了，那时以快照里批准的
 * 那份为准（`compactionContext.plan`）。
 */
export function currentPlan(messages: readonly Message[]): CurrentPlan | null {
	const results = new Map<string, "approved" | "declined" | "error">();
	// 批准的那份以结果里存的为准：批准时附上的注意事项只在那里，交上来的参数里没有。
	const approvedPlans = new Map<string, PlanDraft>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "toolResult") {
			if (message.toolName !== SUBMIT_PLAN_TOOL_NAME) continue;
			const kind = (message.details as { kind?: string } | undefined)?.kind;
			results.set(message.toolCallId, message.isError ? "error" : kind === "plan" ? "approved" : "declined");
			const approved = (message.details as { plan?: ApprovedPlan } | undefined)?.plan;
			if (!message.isError && kind === "plan" && approved && Array.isArray(approved.changes)) {
				const { approvedAt: _approvedAt, ...plan } = approved;
				approvedPlans.set(message.toolCallId, plan);
			}
		} else if (message.role === "assistant") {
			for (let j = message.content.length - 1; j >= 0; j--) {
				const block = message.content[j];
				if (block.type !== "toolCall" || block.name !== SUBMIT_PLAN_TOOL_NAME) continue;
				// 被工具当场退回的那次（参数不成形、计划模式已关）人没见过，模型会再交；它不是一份计划。
				const result = results.get(block.id);
				const plan = normalizePlan(block.arguments);
				if (result === "error" || typeof plan === "string") continue;
				return { plan: approvedPlans.get(block.id) ?? plan, status: result ?? "open", toolCallId: block.id };
			}
		} else if (message.role === "user" && message.synthetic && message.compactionContext?.plan) {
			return { plan: message.compactionContext.plan, status: "approved" };
		}
	}
	return null;
}
