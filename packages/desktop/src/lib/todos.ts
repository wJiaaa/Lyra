import type { ApprovedPlan, TodoItem } from "@plume/core";

/**
 * The whole task list one tool result wrote, or `null` when it wrote none.
 *
 * Two tools write one: `todo_write`, and an approved `submit_plan` — approving a plan turns its
 * steps into the list, and the result carries only the plan, so the list is derived from the steps.
 * Reading `todo_write` alone left the task list empty after every approval. Same rule as core's
 * `todosOf`; the renderer cannot import values from core's root entry, so it keeps its own copy.
 */
export function writtenTodos(toolName: string, details: unknown, isError: boolean): TodoItem[] | null {
	if (isError) return null;
	if (toolName === "todo_write") {
		const written = details as { kind?: string; todos?: TodoItem[] } | undefined;
		return written?.kind === "todo" && Array.isArray(written.todos) ? written.todos : null;
	}
	if (toolName === "submit_plan") {
		const approved = details as { kind?: string; plan?: ApprovedPlan } | undefined;
		if (approved?.kind !== "plan" || !Array.isArray(approved.plan?.steps)) return null;
		return approved.plan.steps.map((step) => ({ content: step.what, status: "pending" }));
	}
	return null;
}
