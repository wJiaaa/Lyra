/**
 * 一个 MCP 工具，包成循环认识的 `Tool`：审批、超时、取消、进度，结果交给 `result.ts`。
 *
 * 工具不握着某一条连接，而是每次调用时向它的服务器要一个现在能用的 client（`McpToolHandle`）：
 * 服务器断线重连之后，已经发给模型的那份工具表照样能用，不必为了换一个 client 改工具表——
 * 工具表在提示缓存前缀的最前面，改一次整个前缀重算。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError, type Progress } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema, Tool, ToolResult } from "../types.ts";
import { toToolResult } from "./result.ts";
import type { McpServerConfig } from "./types.ts";

/** 一个工具找它的服务器要东西的地方。由 `client.ts` 里每台服务器的那一格实现。 */
export interface McpToolHandle {
	/** 现在的声明（人可能刚改过名字或信任开关，不必为此重连）。 */
	config(): McpServerConfig;
	/** 一个能用的 client：连着就给；正在重连就等一会儿；连不上抛出说明原因的错误。 */
	client(signal?: AbortSignal): Promise<Client>;
	/** 没收到回复、也没收到进度，等多久算超时。 */
	callTimeoutMs: number;
	/** 调用失败时补在错误后面的话（服务器断了的话，带上它 stderr 的最后几行）。 */
	explain(): string;
	/** 服务器自己说它是做什么的（`serverInfo.description`，没有就是 `instructions` 的第一行）。 */
	describe(): string | undefined;
}

export interface RawMcpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	/** MCP tool annotations. The server's own word, not a guarantee; see `toAgentTool`. */
	annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown };
	/** 只读 `ui.visibility`，见 `client.ts` 的 `offeredToModel`。 */
	_meta?: { ui?: { visibility?: unknown } };
}

/** 进度最多这么密地推给界面：有的服务器每处理一行就报一次。 */
const PROGRESS_EVERY_MS = 200;

export function toAgentTool(handle: McpToolHandle, raw: RawMcpTool, qualifiedName: string): Tool {
	const server = handle.config();
	const description = raw.description ?? `${raw.name} (from MCP server ${server.name})`;
	/*
	 * 注解是服务器自己说的，规范明说不可信。所以它们只往谨慎的方向单独起作用：
	 *
	 * - `destructiveHint`：审批策略据此把这次调用判成有风险，卡片上写明理由。一个自称只读又自称
	 *   破坏的工具按破坏算——两句矛盾的话里，只能信更谨慎的那句。
	 * - `readOnlyHint`：单凭它不免审批。人在设置里打开这台服务器的「信任只读声明」之后，它才在
	 *   `auto` 模式下免掉逐次确认——那是人对这台服务器下的判断，注解只是在这个判断之内作参考。
	 *   `ask` 模式照样问，`full` 本来就不问，都与它无关。
	 * - `openWorldHint`：不参与判定。一个只读、会访问外部的工具（搜索、查文档）和 `web_fetch` 读一个
	 *   公开地址是同一类事，内置的网络策略在 `auto` 模式下也不为后者问人；默认值又是 true，拿它
	 *   加审批等于给几乎每个工具加。
	 *
	 * 「只读」还决定能不能和同一批里的其他调用并行：说错的代价是两个调用同时跑，不是越权。
	 */
	const destructive = raw.annotations?.destructiveHint === true;
	const readOnly = raw.annotations?.readOnlyHint === true && !destructive;

	return {
		name: qualifiedName,
		description,
		parameters: normalizeSchema(raw.inputSchema),
		mutating: !readOnly,
		executionMode: readOnly ? "parallel" : "sequential",
		summarize: () => `${handle.config().name}: ${raw.name}`,
		mcp: {
			tool: raw.name,
			server: () => {
				const { id, name } = handle.config();
				const description = handle.describe();
				return description ? { id, name, description } : { id, name };
			},
		},

		async execute(args, ctx): Promise<ToolResult> {
			const current = handle.config();
			if (ctx.requestApproval) {
				const decision = await ctx.requestApproval({
					kind: "mcp",
					title: `${current.name} → ${raw.name}`,
					detail: JSON.stringify(args, null, 2).slice(0, 2000),
					subject: qualifiedName,
					...(readOnly ? { readOnly: true } : {}),
					...(destructive ? { destructive: true } : {}),
					...(current.trustReadOnly === true ? { trusted: true } : {}),
				});
				if (decision !== "once" && decision !== "always") return failed("The user rejected this MCP call.");
			}

			let client: Client;
			try {
				client = await handle.client(ctx.signal);
			} catch (error) {
				return failed(`MCP call failed: ${message(error)}`);
			}
			let shown = 0;
			/*
			 * 给了 `onprogress`，SDK 才在请求里带 progressToken；带了它，服务器的进度通知才会到，
			 * `resetTimeoutOnProgress` 才有东西可重置。所以即便没有界面要看进度，也要给。
			 */
			const onprogress = (progress: Progress) => {
				const now = Date.now();
				if (!ctx.onProgress || now - shown < PROGRESS_EVERY_MS) return;
				shown = now;
				ctx.onProgress({ content: [{ type: "text", text: progressLine(progress) }], details: { kind: "mcp-progress", ...progress } });
			};
			try {
				/*
				 * 超时按「多久没动静」算，不按总时长：一个每隔几秒报一次进度的长任务是活的，不该被
				 * 掐掉；一个既不回复也不报进度的，到点就取消。不设总时长上限：报着进度的调用是在干活，
				 * 要它停的是人，人有停止按钮。取消（人按停止、超时）由 SDK 发 `notifications/cancelled`。
				 */
				const response = await client.callTool({ name: raw.name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
					signal: ctx.signal,
					timeout: handle.callTimeoutMs,
					resetTimeoutOnProgress: true,
					onprogress,
				});
				return toToolResult(response, { serverId: current.id, serverName: current.name, tool: raw.name, scratchDir: ctx.scratchDir });
			} catch (error) {
				if (error instanceof McpError && error.code === ErrorCode.RequestTimeout && !ctx.signal?.aborted) {
					return failed(
						`MCP call timed out: "${current.name}" sent neither a result nor progress for ${duration(handle.callTimeoutMs)}, so the call was cancelled.${handle.explain()}`,
					);
				}
				return failed(`MCP call failed: ${message(error)}${handle.explain()}`);
			}
		},
	};
}

function progressLine(progress: Progress): string {
	const amount = progress.total !== undefined ? `${progress.progress}/${progress.total}` : String(progress.progress);
	return progress.message ? `${amount} · ${progress.message}` : amount;
}

function duration(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

function failed(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** MCP servers may omit the schema or send a non-object; the providers require an object schema. */
function normalizeSchema(schema: unknown): JsonSchema {
	if (schema && typeof schema === "object" && (schema as JsonSchema).type === "object") return schema as JsonSchema;
	return { type: "object", properties: {}, additionalProperties: true };
}
