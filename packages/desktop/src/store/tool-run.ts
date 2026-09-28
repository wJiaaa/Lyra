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
