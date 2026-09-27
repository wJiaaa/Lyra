/**
 * Running the tools a turn asked for.
 *
 * Separate from the loop because it answers a different question. The loop decides whether there is
 * another round; this decides what one round of tool use does — in parallel or in order, with
 * approval and hooks around each call, and with the guarantee that pressing stop ends the turn
 * whatever a tool is doing about it.
 */

import type { AgentEventSink } from "./events.ts";
import type { AgentRunConfig } from "./loop.ts";
import { coerceArguments, resolveTool, unknownToolMessage, withParameterHint } from "./tool-args.ts";
import { runTool } from "./tool-pipeline.ts";
import { skillRefusal } from "../skills/tool.ts";
import { translatedShellCommand, TOOL_NAMES_KEY } from "../tools/reroute.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	AssistantContent,
	Tool,
	ToolContext,
	ToolResult,
	ToolResultMessage,
	UserContent,
} from "../types.ts";

/** A tool call as it appears in an assistant message. */
type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

export async function runTools(
	toolCalls: ToolCall[],
	config: AgentRunConfig,
	state: Map<string, unknown>,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const byName = new Map(config.tools.map((t) => [t.name, t]));

	/*
	 * Normalised before anything looks at the call — scheduling, hooks, approval and the tool all
	 * see the same arguments, so what a person approves is what runs.
	 */
	const planned = toolCalls.map((call) => {
		const tool = resolveTool(byName, call.name);
		if (!tool) return { call, tool };
		const args = coerceArguments(call.arguments, tool.parameters);
		return { call: tool.name === call.name && args === call.arguments ? call : { ...call, name: tool.name, arguments: args }, tool };
	});

	const execute = async ({ call, tool }: (typeof planned)[number]): Promise<ToolResultMessage> => {
		const startedAt = Date.now();
		await emit({
			type: "tool_start",
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
			summary: tool?.summarize?.(call.arguments) ?? call.name,
		});

		const result = await executeOne(tool, call, config, state, emit);
		await emit({
			type: "tool_end",
			toolCallId: call.id,
			toolName: call.name,
			result,
			isError: result.isError === true,
		});

		const finishedAt = Date.now();
		const message: ToolResultMessage = {
			startedAt,
			durationMs: finishedAt - startedAt,
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			details: result.details,
			isError: result.isError === true,
			/* An error is always worth keeping, whatever else the tool said about itself. */
			uneventful: result.isError !== true && result.uneventful === true,
			/*
			 * 只有说了才带上，没说的一律不写这个字段。
			 *
			 * 每条工具结果都要落进会话日志，而绝大多数工具永远不会想终止这一轮——给它们每人添一个
			 * `"terminate":false`，是拿一个空值去换一次对称。
			 *
			 * 出错的那次不算数：`yield` 校验没过时返回的就是一条 `isError`，那是「重填一次」的意思，
			 * 不是「交完了」。
			 */
			...(result.isError !== true && result.terminate === true ? { terminate: true } : {}),
			timestamp: finishedAt,
		};
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		return message;
	};

	const results: ToolResultMessage[] = [];
	const groups = batches(planned, (entry) => entry.tool !== undefined && executionMode(entry.tool, entry.call.arguments) === "parallel");
	for (const [index, group] of groups.entries()) {
		if (config.signal?.aborted) {
			// Every call still gets its answer; none of these ever started.
			const rest = groups.slice(index).flat().map((entry) => entry.call);
			results.push(...(await failTruncatedCalls(rest, emit, "the turn was stopped before it could run")));
			break;
		}
		results.push(...(await Promise.all(group.map(execute))));
	}
	return results;
}

function executionMode(tool: Tool, args: Record<string, unknown>): "parallel" | "sequential" {
	if (!tool.executionModeFor) return tool.executionMode ?? "parallel";
	try {
		return tool.executionModeFor(args);
	} catch {
		// Arguments the tool cannot even classify are not ones to run beside anything else.
		return "sequential";
	}
}

/**
 * Split calls into runs that can share a moment, keeping call order.
 *
 * Neighbouring parallel calls form one run; a sequential call is a run of its own. The old rule —
 * one sequential call anywhere made the whole batch sequential — held five reads hostage to an edit,
 * while two writing commands side by side still ran at once because `bash` never said anything.
 */
export function batches<T>(items: readonly T[], parallel: (item: T) => boolean): T[][] {
	const out: T[][] = [];
	let open = false;
	for (const item of items) {
		const shared = parallel(item);
		if (shared && open) out[out.length - 1].push(item);
		else out.push([item]);
		open = shared;
	}
	return out;
}

/**
 * Resolves when the signal fires, and never otherwise.
 *
 * Never-resolving is the point: in a race with real work it is inert until the moment it matters,
 * and the listener is removed as soon as it does so a long turn does not accumulate one per call.
 */
function cancelled(signal: AbortSignal | undefined): Promise<ToolResult> {
	if (!signal) return new Promise<ToolResult>(() => {});
	if (signal.aborted) return Promise.resolve(cancelledResult());
	return new Promise<ToolResult>((resolve) => {
		signal.addEventListener("abort", () => resolve(cancelledResult()), { once: true });
	});
}

function cancelledResult(): ToolResult {
	return { ...errorResult("Tool execution was cancelled. Anything it had already done may have taken effect."), details: { cancelled: true } };
}

async function executeOne(
	tool: Tool | undefined,
	call: ToolCall,
	config: AgentRunConfig,
	state: Map<string, unknown>,
	emit: AgentEventSink,
): Promise<ToolResult> {
	if (!tool) return errorResult(unknownToolMessage(call.name, config.tools));

	/*
	 * A loaded skill's `allowed-tools`, enforced.
	 *
	 * Checked here rather than by filtering the tool list, because the restriction arrives in the
	 * middle of a turn — the model already has the schemas — and a tool that vanishes mid-turn is
	 * harder to explain than one that refuses with a reason.
	 */
	const refusal = skillRefusal(state, call.name);
	if (refusal) return errorResult(refusal);

	// A tool call whose JSON never parsed would silently run with no arguments.
	if (call.argumentsText && Object.keys(call.arguments).length === 0 && call.argumentsText.trim() !== "{}") {
		return errorResult(
			`Arguments for "${call.name}" were not valid JSON, so the call was not executed. Re-issue it with complete arguments.`,
		);
	}

	/*
	 * 钩子围着这一次调用的三件事：PreToolUse 可以改参数、预先放行或要求确认；工具自己要确认时，
	 * PermissionRequest 钩子先答；它们给模型的附加上下文，最后接在结果后面。
	 */
	let preApproved = false;
	let hookContexts: string[] = [];
	const requestApproval = config.requestApproval;
	const ctx: ToolContext = {
		cwd: config.cwd,
		sessionId: config.sessionId,
		signal: config.signal,
		state,
		requestApproval: requestApproval
			? async (request) => {
				if (request.kind !== "interactive") {
					if (preApproved) return "once";
					const answered = await config.permissionRequest?.({ toolName: call.name, args: call.arguments, toolCallId: call.id }, request).catch(() => undefined);
					if (answered) return answered;
				}
				return requestApproval(request);
			}
			: undefined,
		sandboxMode: config.sandboxMode,
		sandboxNetwork: config.sandboxNetwork,
		allowedHosts: config.allowedHosts,
		searchProviderId: config.searchProviderId,
		allowedPaths: config.allowedPaths,
		projectRoots: config.projectRoots,
		writePreview: config.writePreview,
		spawnSubAgent: config.spawnSubAgent,
		resources: config.resources,
		scratchDir: config.scratchDir,
		onProgress: (partial) => void emit({ type: "tool_update", toolCallId: call.id, partial }),
	};

	if (config.beforeToolCall) {
		try {
			const decision = await config.beforeToolCall({ toolName: call.name, args: call.arguments, toolCallId: call.id });
			hookContexts = decision?.contexts ?? [];
			if (decision?.block) {
				const blocked = errorResult(decision.reason || `A hook blocked "${call.name}".`);
				return appendHookContexts(blocked, hookContexts)?.result ?? blocked;
			}
			if (decision?.args) {
				const args = coerceArguments(decision.args, tool.parameters);
				call = { ...call, arguments: args, argumentsText: JSON.stringify(args) };
			}
			if (decision?.approval === "allow") preApproved = true;
			if (decision?.approval === "ask" && requestApproval) {
				const answer = await requestApproval(hookApprovalRequest(call.name, call.arguments, decision.approvalReason));
				if (!approved(answer)) return errorResult(`The user declined "${call.name}".`);
				preApproved = true;
			}
		} catch (error) {
			// A broken hook must not take the tool down with it.
			void emit({
				type: "notice",
				level: "warn",
				message: `PreToolUse handling failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	/*
	 * bash 改道成原生工具：只换执行的那一下，钩子仍按模型调用的 `bash` 跑一遍。
	 *
	 * 这里曾经是再调一次 `executeOne`，于是扩展拦截、PreToolUse、PostToolUse 各跑两遍（先按
	 * `bash`、再按改道后的名字），外层 PreToolUse 的放行也传不进里层。按 `bash` 跑，因为转录里、
	 * 模型眼里、人写钩子时对着的都是那条命令；改道是执行细节，跟「这条命令直接由 bash 跑」应当
	 * 对钩子毫无区别。PreToolUse 改过的命令也要在改道之前生效——上面已经换进 `call` 了。
	 *
	 * 反过来只按原生名字跑不行：守 `Bash` 的钩子是拦命令的那道闸，改道会让 `cat .env` 从它眼皮底下
	 * 溜走——这是不改道就不存在的缺口。而守 `Read` 的钩子从来挡不住 bash（`cat .env | head` 不改道，
	 * 照样绕过它），少跑它不打开任何新的口子。
	 *
	 * 当前技能不许用的工具不改道：那等于借 bash 的名义绕过技能的 `allowed-tools`。
	 */
	let runnable = tool;
	let runArgs = call.arguments;
	let rerouted: string | undefined;
	if (state.has(TOOL_NAMES_KEY) && call.name === "bash" && typeof call.arguments.command === "string" && !call.arguments.escalate && !call.arguments.run_in_background) {
		const translated = translatedShellCommand(call.arguments.command);
		const target = translated && config.tools.find((candidate) => candidate.name === translated.name);
		if (translated && target && !skillRefusal(state, translated.name)) {
			runnable = target;
			runArgs = translated.args;
			rerouted = translated.name;
		}
	}

	let result: ToolResult;
	try {
		/*
		 * Stop must not depend on the tool agreeing to stop.
		 *
		 * A tool is given the signal and is expected to honour it, but "expected to" is not a
		 * guarantee: an `executeJavaScript` against a wedged page, a socket with no timeout, a
		 * child process ignoring SIGKILL. Any one of them used to hold the turn open forever —
		 * the loop was awaiting a promise that would never settle, so pressing stop did nothing
		 * and the run could not even reach its own turn limit.
		 *
		 * Racing the signal here makes the button mean what it says. Whatever the tool is doing
		 * carries on in the background and its result is discarded; the turn is over.
		 */
		result = await Promise.race([runTool({ tool: runnable, args: runArgs, ctx }), cancelled(config.signal)]);
	} catch (error) {
		if (config.signal?.aborted) return cancelledResult();
		return errorResult(error instanceof Error ? error.message : String(error));
	}
	if (rerouted) result = { ...result, content: [...result.content, { type: "text", text: `[Executed with ${rerouted}; use that tool directly next time.]` }] };
	else result = withParameterHint(result, tool, call.arguments);

	if (config.afterToolCall) {
		try {
			const patched = await config.afterToolCall({ toolName: call.name, args: call.arguments, result, toolCallId: call.id, contexts: hookContexts });
			if (patched?.result) result = patched.result;
		} catch (error) {
			void emit({
				type: "notice",
				level: "warn",
				message: `PostToolUse handling failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	return result;
}

/**
 * When the model hits its output limit mid-call, streamed arguments may parse yet still be
 * missing fields. Executing them is worse than failing them, so every call in the message is
 * rejected with an explanation the model can act on.
 *
 * The same shape answers a call the model never finished saying — a stream cut off by a dropped
 * socket, or by the user stopping the turn. Nothing is executed in either case; what matters is
 * that a call which was opened gets closed. Anthropic rejects any request carrying a `tool_use`
 * with no `tool_result` after it, so one orphan does not spoil a turn, it spoils the conversation:
 * every later request fails on the same 400, including the one meant to recover the work.
 */
export async function failTruncatedCalls(
	toolCalls: ToolCall[],
	emit: AgentEventSink,
	reason = "the response hit the output token limit, so its arguments may be incomplete",
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	for (const call of toolCalls) {
		const startedAt = Date.now();
		const result = errorResult(`"${call.name}" was not executed: ${reason}. Re-issue the call.`);
		await emit({ type: "tool_start", toolCallId: call.id, toolName: call.name, args: call.arguments, summary: call.name });
		await emit({ type: "tool_end", toolCallId: call.id, toolName: call.name, result, isError: true });
		const finishedAt = Date.now();
		const message: ToolResultMessage = {
			startedAt,
			durationMs: finishedAt - startedAt,
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: result.content,
			isError: true,
			timestamp: finishedAt,
		};
		await emit({ type: "message_start", message });
		await emit({ type: "message_end", message });
		results.push(message);
	}
	return results;
}

export function errorResult(text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

export function textResult(text: string, details?: unknown): ToolResult {
	const content: UserContent[] = [{ type: "text", text }];
	return { content, details };
}

export function appendHookContexts(result: ToolResult, contexts: readonly string[]): { result: ToolResult } | undefined {
	if (contexts.length === 0) return undefined;
	const text = ["[Hook additional context]", ...contexts.map((context, index) => `#${index + 1}\n${context}`)].join("\n");
	return { result: { ...result, content: [...result.content, { type: "text" as const, text: `\n${text}` }] } };
}

/** PreToolUse 说「要问」时，替它向人要一次确认。 */
function hookApprovalRequest(toolName: string, args: Record<string, unknown>, reason?: string): ApprovalRequest {
	const kind: ApprovalRequest["kind"] =
		toolName === "bash" ? "bash"
		: toolName === "write" ? "write"
		: toolName === "edit" ? "edit"
		: ["read", "ls", "grep", "glob"].includes(toolName) ? "read"
		: toolName === "web_fetch" || toolName === "web_search" ? "network"
		: "mcp";
	return {
		kind,
		title: toolName,
		detail: JSON.stringify(args, null, 2).slice(0, 4000),
		reason: reason ?? "PreToolUse 钩子要求确认这次调用",
		subject: toolName,
	};
}

function approved(decision: ApprovalDecision): boolean {
	return decision === "once" || decision === "always";
}
