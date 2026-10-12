/**
 * MCP 服务器在工具调用中途反问用户（`elicitation/create`）时，问到人面前、把回答交回去。
 *
 * 问人走的是审批那条通道（`ApprovalGate`，`kind: "form"`）：卡片、倒计时、撤回、子代理停下时
 * 收卡，都是现成的，再造一条只会和它慢慢分叉。
 *
 * 能问人的宿主才在 capabilities 里声明 elicitation（`elicitationCapability`）。问不了人的——命令行、
 * 设置页临时连的那一下——不声明；照规范服务器不该再发，真发来了也回 decline，而不是让一个
 * 「方法不存在」的错误把整次工具调用拖垮。
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema, ErrorCode, McpError, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalDecision, ApprovalRequest } from "../types.ts";
import { formFields, UnsupportedFormError } from "./form.ts";
import type { McpServerConfig } from "./types.ts";

/** 把一张表单交给人，等回答。`signal` 断了就撤回卡片——服务器已经不等了。 */
export type AskPerson = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;

/** 只声明表单这一种：URL 模式要把人带去浏览器里办事，这里没有做。 */
export const elicitationCapability = { elicitation: { form: {} } } as const;

/**
 * 每台服务器一条队：同一台服务器同时发来几张表单，一张一张问。
 *
 * 一起摊给人，后面几张的倒计时在人还没看见它们时就在走；而且人分不清哪一张是先来的。排着的那张
 * 服务器若先取消了，直接出队，不会再弹出来。
 */
export class ElicitationQueue {
	private readonly tails = new Map<string, Promise<unknown>>();

	run<T>(server: string, signal: AbortSignal, job: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(server) ?? Promise.resolve();
		const turn = previous.then(() => {
			if (signal.aborted) throw signal.reason ?? new Error("cancelled");
			return job();
		});
		const tail = turn.catch(() => {});
		this.tails.set(server, tail);
		void tail.then(() => {
			if (this.tails.get(server) === tail) this.tails.delete(server);
		});
		return turn;
	}
}

/** 给一个刚建好、还没连上的 Client 装上回答 elicitation 的处理。 */
export function handleElicitation(client: Client, server: McpServerConfig, ask: AskPerson | undefined, queue: ElicitationQueue): void {
	if (!ask) {
		// 没声明能力，不能用 `setRequestHandler` 注册（SDK 会拦），走兜底的处理。
		client.fallbackRequestHandler = async (request) => {
			if (request.method === "elicitation/create") return { action: "decline" } satisfies ElicitResult;
			throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
		};
		return;
	}
	client.setRequestHandler(ElicitRequestSchema, async (request, extra): Promise<ElicitResult> => {
		const params = request.params;
		// SDK 已经按声明的能力挡掉了 URL 模式，这里只会是表单。
		if (params.mode === "url") throw new McpError(ErrorCode.InvalidParams, "URL-mode elicitation is not supported");
		let fields;
		try {
			fields = formFields(params.requestedSchema);
		} catch (error) {
			if (error instanceof UnsupportedFormError) throw new McpError(ErrorCode.InvalidParams, `Unsupported elicitation schema: ${error.message}`);
			throw error;
		}
		const decision = await queue.run(server.id, extra.signal, () =>
			ask({ kind: "form", title: server.name, detail: params.message, subject: `mcp_elicitation:${server.id}`, fields }, extra.signal),
		);
		return elicitResult(decision);
	});
}

/** 卡片上的回答，换成协议的三种之一。 */
export function elicitResult(decision: ApprovalDecision): ElicitResult {
	if (typeof decision === "object" && "values" in decision) return { action: "accept", content: decision.values };
	if (decision === "reject") return { action: "decline" };
	return { action: "cancel" };
}
