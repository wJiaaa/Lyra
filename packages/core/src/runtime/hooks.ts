/**
 * 钩子接进一轮对话的地方。
 *
 * 七个事件各有各的挂点：SessionStart 和 UserPromptSubmit 在一轮开始前（`session-turn.ts`），
 * PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure 围着每一次工具调用
 * （`agent/tool-run.ts`），Stop 在模型不再调用工具、准备收尾的那一刻（`agent/loop.ts`）。
 * 这里把 `HookRunner` 的结论翻译成这几处各自听得懂的形状。
 */

import type { AgentEvent } from "../agent/events.ts";
import type { AfterToolCall, BeforeToolCall, PermissionRequestHook, StopHook } from "../agent/run-config.ts";
import { appendHookContexts } from "../agent/tool-run.ts";
import type { Settings } from "../config/settings.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import { hookEntries, normalizeHooksConfig, readProjectHooks } from "../hooks/config.ts";
import { createHookRunner, hookMatchValues, type HookInput, type HookRunner } from "../hooks/runner.ts";
import { trustedHookDigests } from "../hooks/trust.ts";
import type { Message } from "../types.ts";

const MAX_STOP_HOOK_CONTINUATIONS = 3;
const HOOK_CONTEXT_MAX_CHARS = 24_000;

export interface TurnHooks {
	runner: HookRunner;
	cwd: string;
	sessionId: string;
	agentName?: string;
	permissionMode?: string;
	signal?: AbortSignal;
}

/**
 * 这一轮的钩子：用户级的全部，加上这个项目的——没被信任的那些也带上，跑到它们时只记一笔「被拦下」。
 *
 * 每轮现读，不缓存：在设置页改了、信任了，下一轮就生效，不用重开会话。
 */
export async function loadHookRunner(input: {
	settings: Settings;
	cwd: string;
	emit?: (event: AgentEvent) => Promise<void> | void;
}): Promise<HookRunner> {
	// 再规范化一次：设置可能是渲染进程刚存下来的那份，没经过读盘时的那道 `normalizeSettings`。
	const userConfig = normalizeHooksConfig(input.settings.hooks);
	const user = { config: userConfig, entries: hookEntries(userConfig, "user") };
	const project = await readProjectHooks(input.cwd).catch(() => null);
	const projectEntries = project ? hookEntries(project.config, "project") : [];
	const trusted = projectEntries.length > 0 ? await trustedHookDigests(input.cwd).catch(() => new Set<string>()) : new Set<string>();
	return createHookRunner({
		user,
		...(project ? { project: { config: project.config, entries: projectEntries, trusted } } : {}),
		emit: input.emit ? (run) => input.emit!({ type: "hook_run", run }) : undefined,
	});
}

function base(scope: TurnHooks, event: HookInput["hookEventName"]): HookInput {
	return {
		hookEventName: event,
		sessionId: scope.sessionId,
		cwd: scope.cwd,
		timestamp: new Date().toISOString(),
		...(scope.agentName ? { agentName: scope.agentName } : {}),
		...(scope.permissionMode ? { permissionMode: scope.permissionMode } : {}),
	};
}

/** 写给模型的一段附加上下文。模型读得到，界面上不画（`synthetic`）。 */
export function hookContextMessage(event: HookInput["hookEventName"], contexts: readonly string[]): Message | null {
	if (contexts.length === 0) return null;
	const body = contexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
	const text = `${event} hook additional context:\n${body}`;
	return {
		role: "user",
		content: [{ type: "text", text: `<system-reminder>\n${text.length > HOOK_CONTEXT_MAX_CHARS ? `${text.slice(0, HOOK_CONTEXT_MAX_CHARS)}...` : text}\n</system-reminder>` }],
		timestamp: Date.now(),
		synthetic: true,
	};
}

export async function runSessionStartHooks(scope: TurnHooks, source: "startup" | "resume", model?: string) {
	if (!scope.runner.has("SessionStart")) return { additionalContexts: [] };
	return scope.runner.run({ ...base(scope, "SessionStart"), source, ...(model ? { model } : {}) }, { matchValues: [source], signal: scope.signal });
}

export async function runUserPromptSubmitHooks(scope: TurnHooks, prompt: string, attachmentsSummary?: string) {
	if (!scope.runner.has("UserPromptSubmit")) return { additionalContexts: [] };
	return scope.runner.run({ ...base(scope, "UserPromptSubmit"), prompt, ...(attachmentsSummary ? { attachmentsSummary } : {}) }, { signal: scope.signal });
}

/**
 * 给循环的 `onStop`：Stop 钩子要求接着干、并且说了为什么，就把原因交回去让循环再跑一圈。
 *
 * 只要原因不为空才继续——一个只说「别停」却不说还差什么的钩子，接着跑只会得到同一句收尾。
 * 连续三次封顶，防止一条永远不满意的钩子把这一轮拖成死循环。
 */
export function makeOnStop(scope: TurnHooks): StopHook {
	let continuations = 0;
	return async ({ responseText, toolCallCount }) => {
		if (!scope.runner.has("Stop")) return undefined;
		const result = await scope.runner.run(
			{ ...base(scope, "Stop"), responseText, responsePreview: responseText.slice(0, 4000), toolCallCount, stopHookActive: continuations > 0 },
			{ signal: scope.signal },
		);
		if (result.stopShouldContinue !== true || result.additionalContexts.length === 0 || continuations >= MAX_STOP_HOOK_CONTINUATIONS) return undefined;
		continuations += 1;
		return hookContextMessage("Stop", result.additionalContexts) ?? undefined;
	};
}

/**
 * 工具调用前：先问扩展，再跑 PreToolUse。
 *
 * 扩展在前是有意的：钩子是用户自己为这台机器写的命令，扩展是别人写的代码。两者都要拦的时候，
 * 值得说出来的是用户没写的那个——自己的钩子做了什么，用户已经知道。
 */
export function makeBeforeToolCall(scope: TurnHooks, extensions?: ExtensionHost): BeforeToolCall {
	return async ({ toolName, args, toolCallId }) => {
		if (extensions) {
			const verdict = await extensions.intercept("tool_call", { toolName, args, cwd: scope.cwd });
			if (verdict.block) return { block: true, reason: `一个扩展拦下了 "${toolName}"：${verdict.block}` };
		}
		if (!scope.runner.has("PreToolUse")) return undefined;
		const result = await scope.runner.run(
			{ ...base(scope, "PreToolUse"), toolName, toolInput: args, toolCallId },
			{ matchValues: hookMatchValues(toolName), signal: scope.signal },
		);
		const contexts = result.additionalContexts;
		if (result.permissionBehavior === "deny" || result.preventContinuation) {
			return { block: true, reason: result.hookPermissionDecisionReason ?? result.stopReason ?? "Blocked by PreToolUse hook", contexts };
		}
		const updated = result.updatedInput !== undefined && typeof result.updatedInput === "object" && result.updatedInput !== null && !Array.isArray(result.updatedInput)
			? (result.updatedInput as Record<string, unknown>)
			: undefined;
		return {
			...(updated ? { args: updated } : {}),
			...(result.permissionBehavior === "allow" || result.permissionBehavior === "ask" ? { approval: result.permissionBehavior, approvalReason: result.hookPermissionDecisionReason } : {}),
			...(contexts.length > 0 ? { contexts } : {}),
		};
	};
}

/**
 * 工具要人确认的时候，先让 PermissionRequest 钩子答。答了就不弹窗；没答（或者这条钩子坏了）才问人。
 *
 * 顺序执行而不是和弹窗赛跑：Plume 的确认卡片没有「被别人答掉了」这种收场，先弹再撤比晚弹一会儿更糟。
 */
export function makePermissionRequest(scope: TurnHooks): PermissionRequestHook {
	return async ({ toolName, args, toolCallId }, request) => {
		if (!scope.runner.has("PermissionRequest")) return undefined;
		const result = await scope.runner.run(
			{ ...base(scope, "PermissionRequest"), toolName, toolInput: args, toolCallId, reason: request.reason ?? request.title, requestId: toolCallId },
			{ matchValues: hookMatchValues(toolName), signal: scope.signal },
		);
		const decision = result.permissionRequestResult;
		if (result.preventContinuation || decision?.behavior === "deny" || (!decision && result.permissionBehavior === "deny")) return "reject";
		if (decision?.behavior === "allow" || (!decision && result.permissionBehavior === "allow")) return "once";
		return undefined;
	};
}

/** 工具调用后：扩展的 `tool_result` 只观察；PostToolUse / PostToolUseFailure 的附加上下文接在结果后面。 */
export function makeAfterToolCall(scope: TurnHooks, extensions?: ExtensionHost): AfterToolCall {
	return async ({ toolName, args, result, toolCallId, contexts = [] }) => {
		void extensions?.dispatch("tool_result", { toolName, args, ok: !result.isError }).catch(() => {});
		const failed = result.isError === true;
		const event = failed ? "PostToolUseFailure" : "PostToolUse";
		let added: string[] = [];
		if (scope.runner.has(event)) {
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const input = failed
				? { ...base(scope, event), toolName, toolInput: args, toolCallId, error: { message: text.slice(0, 4000), type: "ToolError" }, isInterrupt: (result.details as { cancelled?: boolean } | undefined)?.cancelled === true }
				: { ...base(scope, event), toolName, toolInput: args, toolCallId, toolResponse: { content: result.content, details: result.details }, toolResultPreview: text.slice(0, 4000) };
			added = (await scope.runner.run(input, { matchValues: hookMatchValues(toolName), signal: scope.signal })).additionalContexts;
		}
		return appendHookContexts(result, [...contexts, ...added]);
	};
}
