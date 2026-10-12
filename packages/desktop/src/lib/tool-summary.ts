/**
 * Human-readable one-liners for tool calls.
 *
 * The main process sends a summary with each live `tool_start`, but a session reopened from
 * disk only has the raw call, so the same labels are derived here from the arguments.
 */
export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const str = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);

	switch (name) {
		case "read": {
			const target = str("path") ?? str("file") ?? str("filePath");
			return target ? `Read ${target}` : "Read file";
		}
		case "write": {
			const target = str("path") ?? str("file") ?? str("filePath");
			return target ? `Write ${target}` : "Write file";
		}
		case "edit": {
			const target = str("path") ?? str("file") ?? str("filePath");
			return target ? `Edit ${target}` : "Edit file";
		}
		case "ls": {
			const target = str("path") ?? str("dir") ?? str("cwd");
			return `List ${target ?? "."}`;
		}
		case "glob": {
			const term = str("pattern") ?? str("query") ?? str("search");
			return term ? `Find ${term}` : "Find files";
		}
		case "grep": {
			const term = str("pattern") ?? str("query") ?? str("search");
			return term ? `Search "${term}"` : "Search";
		}
		case "symbol": {
			const term = str("name") ?? str("query") ?? str("symbol") ?? str("pattern");
			return term ? `Find definition of ${term}` : "Find definition";
		}
		case "web_search": {
			const term = str("query") ?? str("pattern") ?? str("search");
			return term ? `Search ${term}` : "Search the web";
		}
		case "bash": {
			const cmd = str("description") ?? (str("command") ?? "bash").split("\n")[0].slice(0, 80);
			return cmd || "Run bash command";
		}
		case "bash_output":
			return `Check job ${str("id") ?? ""}`.trim() || "Check job";
		case "todo_write":
			return "Update task list";
		case "task":
			return str("description") ?? "Sub-agent task";
		case "skill":
			return `Skill: ${str("name") ?? ""}`.trim() || "Skill";
		case "mcp_search":
			// 和 core 的 `mcpSearchTool.summarize` 同一句。
			return `Search MCP tools “${str("query") ?? ""}”`;
		case "mcp_call":
			// 只有参数没对上、被拦下的才以它自己的名字留下来（见 `routedMcpCall`）；同 core 的 summarize。
			return str("tool") ?? "mcp_call";
		case "web_fetch":
			return `Fetch ${str("url") ?? ""}`.trim() || "Fetch URL";
		case "generate_image": {
			// 和 core 的 `generateImageTool.summarize` 同一句，`describeActivity` 认的是它。
			const prompt = str("prompt")?.trim().split("\n")[0];
			return prompt ? `Generate image ${prompt.slice(0, 80)}` : "Generate image";
		}
		default:
			// MCP tools are named mcp__<server>__<tool>; show the readable half.
			if (name.startsWith("mcp__")) {
				const [, server, tool] = name.split("__");
				return `${server}: ${tool}`;
			}
			return name;
	}
}

/**
 * 经 `mcp_call` 转手的调用，按它真正叫的那个工具记：直播时工具卡片收到的就是那个工具的名字和参数
 * （`core/src/agent/tool-run.ts` 在执行前换掉），重开会话从日志重建时要画成同一张卡。
 */
export function routedMcpCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
	if (name !== "mcp_call" || typeof args.tool !== "string") return { name, args };
	const inner = args.arguments;
	return { name: args.tool, args: inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {} };
}

/**
 * 对话里画的那一张：经 `mcp_call` 转手的调用，换成它真正叫的那个工具的名字和参数，卡片、图标、
 * 一行概述、preview 的页面都跟着它走。消息本身不改：发给模型的历史里那条就是 `mcp_call`。
 */
export function routedBlock<B extends { name: string; arguments: Record<string, unknown> }>(block: B): B {
	const routed = routedMcpCall(block.name, block.arguments);
	return routed.name === block.name ? block : { ...block, name: routed.name, arguments: routed.args };
}
