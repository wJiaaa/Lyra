/**
 * One task, start to finish, with nobody at the keyboard.
 *
 * Built for evaluation runs: the same `AgentSession` the desktop drives, with the desktop's settings,
 * so what is measured is the product and not a second implementation of it. Progress goes to one
 * sink and the answer to another, so a harness can keep stdout clean and still log what happened.
 */

import {
	AgentSession,
	bindPromptArguments,
	findPrompt,
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
	type UserContent,
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

/**
 * `/mcp__<服务器>__<prompt> 参数`：取服务器展开的那段话，作为这次的任务发出去。
 *
 * 不认识的名字返回 null，和桌面端一样原样发送。认识却缺参数、或服务器取不出来，是这次调用本身
 * 有误——什么都还没发，所以是 `SetupError`，不是一次失败的运行。
 */
async function mcpPrompt(session: AgentSession, invocation: NonNullable<ReturnType<typeof parseInvocation>>): Promise<UserContent[] | null> {
	const prompt = findPrompt(session.can.mcp.allPrompts(), invocation);
	if (!prompt) return null;
	const bound = bindPromptArguments(prompt, invocation.rest);
	if (!bound.ok) throw new SetupError(`/${prompt.name} 缺少参数：${bound.missing.join("、")}。写法：/${prompt.name} ${prompt.arguments.map((argument) => `${argument.name}=…`).join(" ")}`);
	try {
		return await session.can.mcp.getPrompt(prompt.name, bound.args);
	} catch (error) {
		throw new SetupError(`取不到 MCP prompt /${prompt.name}：${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function runOnce(options: RunOptions): Promise<RunResult> {
	if (!resolveModel(options.settings, options.settings.defaultModelId)) {
		throw new SetupError("没有可用的默认模型。在 Plume 桌面端的设置里添加模型供应商并选好默认模型。");
	}

	// `/命令 参数` and `/skill:名字` mean what they mean in the desktop composer; anything else is sent as typed.
	let text = options.prompt;
	let promptOptions: Parameters<AgentSession["prompt"]>[1] = {};
	const invocation = parseInvocation(text) ?? parseSkillMention(text);
	/** 命令和 skill 都不是：可能是一个 MCP prompt，要等会话连上服务器才知道。 */
	let unresolved = invocation;
	if (invocation) {
		const catalogue = await listCommands(options.cwd, options.settings, []);
		const resolved = resolveInvocation(invocation, catalogue);
		if (resolved) {
			unresolved = null;
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
		// 没有人可问：MCP 服务器不会被告知这边能填表，硬要问也一律回 decline。
		elicitation: false,
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
		/*
		 * 会话不等 MCP 服务器就打开了（桌面端不该为一台慢服务器卡住窗口），第一轮只等它们几秒。命令行
		 * 没有人在对着窗口等，而评测要的是可复现：一台冷启动要一分钟的服务器，这次赶上、下次没赶上，
		 * 同一道题就有两种工具表。所以这里等到每台都有结果（每台各自仍受连接超时约束）。
		 */
		await session.can.mcp.settled();
		// 命令行开不了浏览器，登录只能去桌面端；说清楚，免得人以为是服务器挂了。工具少了它照样跑。
		for (const server of session.can.mcpStatuses) if (server.state === "needs-login" && server.error) options.log(`! ${server.error}`);
		const content = (unresolved && (await mcpPrompt(session, unresolved))) || [{ type: "text" as const, text }];
		await session.prompt(content, promptOptions).catch((reason: unknown) => {
			status = "error";
			error = reason instanceof Error ? reason.message : String(reason);
		});
		// 派了子代理的话，第一轮在派完时就收了尾：结果一个个送回来、各开一轮，最后那一轮说的才是回答。
		// 出错或被停的会话手上没有这些东西，当场就闲。
		await session.whenIdle();
		return { status, answer: answer || lastSaid, ...(error ? { error } : {}), sessionId: session.meta.id, usage: session.meta.usage };
	} finally {
		options.signal?.removeEventListener("abort", stop);
		// MCP servers are child processes; without this they outlive the run.
		await session.dispose("exit");
	}
}
