/**
 * 计划模式：先只读地看，交一份计划，批准之前改不了任何东西。
 *
 * 开关按会话记在 `SessionMeta.planMode`，不做成第四档权限：计划和权限是两件事，「计划中 + 完全
 * 访问」也是成立的组合；权限是全局的，一个对话进计划模式不该让别的窗口跟着进去。
 *
 * 只读靠执行期拒绝，不裁工具表、不靠提示词。工具定义排在请求最前面，批准之后要把写工具还给
 * 模型，裁过的表一变整段前缀缓存就作废；提示词是请求，模型会忘（codex 只靠提示词，ZCode 的
 * `mode.plan.nonReadOnly` 是执行期规则，后者才拦得住）。所以每个工具的 schema 原样留着，`execute`
 * 外面包一层：开关开着就拒绝会改东西的调用；批准那一刻开关关掉，同一轮里同一张工具表接着用。
 * 包的是会话的状态图，所以这一轮派出去的子代理拿到的也是包过的工具，同样受管。见 ADR-0044。
 */

import { isReadOnlyCommand } from "../tools/bash.ts";
import { errorResult } from "../tools/result.ts";
import type { Message, Tool, ToolContext, ToolResult } from "../types.ts";
import { SUBMIT_PLAN_TOOL_NAME } from "./plan-view.ts";

/** 会话状态图里的开关。每轮开始按 `SessionMeta.planMode` 写入，批准计划时就地关掉。 */
export const PLAN_MODE_KEY = "planMode";

export function inPlanMode(state: Map<string, unknown>): boolean {
	return state.get(PLAN_MODE_KEY) === true;
}

/**
 * 不改任何东西的内置工具，按名字放行。
 *
 * 名单而不是 `mutating !== true`：多数内置工具没标 `mutating`，缺省放行等于「没想到的都放过」，
 * 和沙箱「拿不到约束就拒绝」（ADR-0004）相反。不在名单上、又没明说 `mutating: false` 的一律拒绝。
 * `task` 在名单上：子代理拿到的是同一张包过的表。`bash_output` 只读后台作业的输出；计划模式里
 * 起得来的后台作业本身就是只读命令。
 */
const READ_ONLY_TOOLS = new Set([
	"read", "ls", "glob", "grep", "symbol", "web_fetch", "web_search", "recall", "skill",
	"todo_write", "ask_user", "task", "bash_output", SUBMIT_PLAN_TOOL_NAME,
]);

function refusal(tool: string, why: string): ToolResult {
	return errorResult(
		`Plan mode: ${why}, so "${tool}" did not run. Investigate with read-only tools, then call \`${SUBMIT_PLAN_TOOL_NAME}\`; ` +
		"once the user approves the plan every tool is available again.",
	);
}

/**
 * 同一张工具表，开关开着时只放行只读调用。
 *
 * 只换 `execute`，name / description / parameters 原样，发给模型的工具定义逐字节不变。开关是
 * 运行时读的：`submit_plan` 批准后把它关掉，包着的 `execute` 就直接放行，不用换表。
 */
export function planModeTools(tools: readonly Tool[], state: Map<string, unknown>): Tool[] {
	return tools.map((tool) => ({
		...tool,
		execute: (args: Record<string, unknown>, ctx: ToolContext) => {
			if (!inPlanMode(state)) return tool.execute(args, ctx);
			const verdict = allow(tool, args);
			if (verdict !== "ok") return Promise.resolve(verdict);
			/*
			 * 只读命令也压进只读沙箱：`isReadOnlyCommand` 是按命令文本认的，认错一次的代价由沙箱
			 * 兜住。外层的 `sandboxMode` 来自权限档，批准后同一轮里恢复成那一档。
			 */
			if (tool.name === "bash") return tool.execute(args, { ...ctx, sandboxMode: "read-only" });
			return tool.execute(args, ctx);
		},
	}));
}

function allow(tool: Tool, args: Record<string, unknown>): "ok" | ToolResult {
	if (tool.name === "bash") {
		if (args.escalate) return refusal(tool.name, "nothing may leave the read-only sandbox");
		if (typeof args.command !== "string" || !isReadOnlyCommand(args.command)) return refusal(tool.name, "this command is not recognised as read-only");
		return "ok";
	}
	if (tool.name === "lsp") return args.operation === "rename" ? refusal(tool.name, "a rename edits files") : "ok";
	if (READ_ONLY_TOOLS.has(tool.name) || tool.mutating === false) return "ok";
	return refusal(tool.name, "it can change things");
}

/** 计划模式的一轮查过东西、以正文收尾、却没交计划时，说一次的那句。 */
export const UNSUBMITTED_PLAN_NOTE =
	`（自动提示）现在是计划模式：计划只有通过 \`${SUBMIT_PLAN_TOOL_NAME}\` 提交，用户才看得到审批卡、才能批准，写在回复正文里的方案批不了。` +
	`如果上面的回复就是方案，现在把它完整地用 \`${SUBMIT_PLAN_TOOL_NAME}\` 交上来，不要再把正文写一遍；还缺用户的决定，就用 \`ask_user\` 问。` +
	"如果这一轮只是回答问题、用户并没有要改东西，回一句「无需计划」即可。";

/**
 * 计划模式的一轮以正文收尾，计划却没交：提醒一次。返回 `undefined` 是没有要说的。
 *
 * 起因是 2026-10-15 的 `a2637a66`：GPT 系模型查了 32 次代码，把方案写成普通回复就结束了，没调
 * `submit_plan`——审批卡没出现，用户追问「你生成的计划呢」才补交。拦不如纠正：给它一句能照做的话，
 * 而不是让这一轮静静地以「完成」收场。只说一次：说过还不交，就是它认定这里不需要计划，停下交给人。
 *
 * 这一轮没调过任何工具的不问。本机 12 个计划模式会话里，以正文收尾、没交计划的 4 次中 3 次是
 * 「你好」「现在是计划模式吗」这种一个工具都没调的问答，问了只会多一次请求和一段多余的正文；
 * 真正漏交的那次查了 32 次。调过 `ask_user` 的也不问：它在等人回答，或者已经照人的回答收住了。
 *
 * `since` 交回这一轮（含续跑）到目前为止写进日志的消息；`state` 是会话的状态图，批准计划时开关
 * 已经关掉，也就不再问。
 */
export function unsubmittedPlanCheck(state: Map<string, unknown>, since: () => readonly Message[]): () => Message | undefined {
	let reminded = false;
	return () => {
		if (reminded || !inPlanMode(state)) return undefined;
		const called = since().flatMap((message) => (message.role === "toolResult" ? [message.toolName] : []));
		if (called.length === 0 || called.includes(SUBMIT_PLAN_TOOL_NAME) || called.includes("ask_user")) return undefined;
		reminded = true;
		return { role: "user", content: [{ type: "text", text: UNSUBMITTED_PLAN_NOTE }], timestamp: Date.now(), synthetic: true };
	};
}
