import type { ToolResult } from "@plume/core";

/** Shared transcript data must not depend on either conversation's live store. */
export interface ToolRun {
	toolCallId: string;
	toolName: string;
	summary: string;
	args: Record<string, unknown>;
	status: "running" | "done" | "error";
	result?: ToolResult;
	startedAt: number;
	finishedAt?: number;
}

/**
 * 主会话此刻卡在等另一个会话做完（`wait_for_session`）上。
 *
 * 和等子代理是同一回事：这时候人说的话该直接送进去，运行时会让它放手、先回应人（`untilSpokenTo`），
 * 而不是在输入框上方排到对方做完为止——那可能是十分钟。
 */
export function awaitingSession(runs: Record<string, ToolRun>): boolean {
	return Object.values(runs).some((run) => run.toolName === "wait_for_session" && run.status === "running");
}
