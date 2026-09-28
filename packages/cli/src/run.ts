/**
 * One task, start to finish, with nobody at the keyboard.
 *
 * Built for evaluation runs: the same `AgentSession` the desktop drives, with the desktop's settings,
 * so what is measured is the product and not a second implementation of it. Progress goes to one
 * sink and the answer to another, so a harness can keep stdout clean and still log what happened.
 */

import {
	AgentSession,
	listCommands,
	parseInvocation,
	parseSkillMention,
	resolveInvocation,
	resolveModel,
	type AgentEvent,
	type AgentSessionOptions,
	type SessionStorage,
	type Settings,
	type Usage,
} from "@plume/core";

type RunStatus = "done" | "aborted" | "error" | "max_turns" | "stalled";

export interface RunOptions {
	prompt: string;
	cwd: string;
	settings: Settings;
	store: SessionStorage;
	/** Progress, one line at a time: tool calls, failures, refusals, notices. */
	log: (line: string) => void;
	signal?: AbortSignal;
	/** Replaces the provider call — the seam core keeps for exercising a session without a network. */
	streamFn?: AgentSessionOptions["streamFn"];
}

export interface RunResult {
	status: RunStatus;
	/** The last thing the model said that was not on the way to a tool call. */
	answer: string;
	error?: string;
	sessionId: string;
	usage: Usage;
}

/** A problem with the invocation or the settings, not with the run: nothing was sent. */
export class SetupError extends Error {}

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() ?? "";

export async function runOnce(options: RunOptions): Promise<RunResult> {
	if (!resolveModel(options.settings, options.settings.defaultModelId)) {
		throw new SetupError("没有可用的默认模型。在 Plume 桌面端的设置里添加模型供应商并选好默认模型。");
	}

	// `/命令 参数` and `/skill:名字` mean what they mean in the desktop composer; anything else is sent as typed.
	let text = options.prompt;
	let promptOptions: Parameters<AgentSession["prompt"]>[1] = {};
	const invocation = parseInvocation(text) ?? parseSkillMention(text);
	if (invocation) {
		const catalogue = await listCommands(options.cwd, options.settings, []);
		const resolved = resolveInvocation(invocation, catalogue);
		if (resolved) {
			text = resolved.outgoing;
			promptOptions = {
				...(resolved.displayText !== undefined ? { displayText: resolved.displayText } : {}),
				...(resolved.skillRef ? { skillRef: resolved.skillRef } : {}),
			};
		}
	}

	let status: RunStatus = "error";
	let error: string | undefined;
	let answer = "";
	let lastSaid = "";

	const session: AgentSession = new AgentSession({
		cwd: options.cwd,
		settings: options.settings,
		store: options.store,
		...(options.streamFn ? { streamFn: options.streamFn } : {}),
		emit: (event: AgentEvent) => {
			switch (event.type) {
				case "tool_start":
					options.log(`→ ${event.toolName}  ${firstLine(event.summary)}`);
					break;
				case "tool_end":
					if (event.isError) options.log(`✗ ${event.toolName}  ${firstLine(event.result.content.map((part) => part.type === "text" ? part.text : "").join("\n"))}`);
					break;
				case "approval_request": {
					/*
					 * Nobody is here to ask. Refused rather than left to time out: a wait would only
					 * spend the run's wall clock and end in the same refusal. What the agent may do
					 * without asking is the permission mode set in the desktop app.
					 */
					const skip = event.kind === "interactive" && event.allowSkip === true;
					session.resolveApproval(event.requestId, skip ? "skip" : "reject");
					options.log(`⚑ ${skip ? "跳过" : "拒绝"}：${event.title} · ${firstLine(event.detail)}（非交互运行，没有人可以回答）`);
					break;
				}
				case "notice":
					options.log(`${event.level === "info" ? "·" : "!"} ${event.message}`);
					break;
				case "retry":
					options.log(`! 请求中断（${event.reason}），第 ${event.attempt} 次重试`);
					break;
				case "message_end": {
					if (event.message.role !== "assistant") break;
					const said = event.message.content.map((part) => part.type === "text" ? part.text : "").join("").trim();
					if (said) lastSaid = said;
					if (said && !event.message.content.some((part) => part.type === "toolCall")) answer = said;
					break;
				}
				case "agent_end":
					status = event.reason === "done" ? "done" : event.reason;
					error = event.error;
					break;
			}
		},
	});

	const stop = () => session.abort();
	options.signal?.addEventListener("abort", stop, { once: true });
	try {
		await session.initialize();
		if (options.signal?.aborted) return { status: "aborted", answer: "", sessionId: session.meta.id, usage: session.meta.usage };
		await session.prompt([{ type: "text", text }], promptOptions).catch((reason: unknown) => {
			status = "error";
			error = reason instanceof Error ? reason.message : String(reason);
		});
		return { status, answer: answer || lastSaid, ...(error ? { error } : {}), sessionId: session.meta.id, usage: session.meta.usage };
	} finally {
		options.signal?.removeEventListener("abort", stop);
		// MCP servers are child processes; without this they outlive the run.
		await session.dispose();
	}
}
