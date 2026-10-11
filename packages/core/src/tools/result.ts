import type { ToolResult } from "../types.ts";

/**
 * Lives beside the tools, not in `agent/tool-run.ts`: the tools sit below the loop, and importing
 * this from the executor closed a cycle through `skills/tool.ts`.
 */
export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}
