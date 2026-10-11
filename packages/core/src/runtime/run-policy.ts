/**
 * 会话定下的规矩，落到每一种运行上——主会话的一轮、侧边聊天、委派出去的子代理，都从这里拿。
 *
 * 全仓只有两处构造 `AgentRunConfig`：`turn-config.ts` 和 `sub-agent-config.ts`。从前两边各自展开
 * 工具策略、各自装钩子、各自拼工具环境，`Stated<T>` 逼得两边写出每个字段，却防不住两边写得不一样：
 * 子代理曾经在会话选定的沙箱外跑命令、绕过已配置的钩子，都是「它那份漏了一个字段，而缺省意味着
 * 不限制」。
 *
 * 所以这里只放两边**必须一致**的那一半。子代理真正不同的地方（自己的思考等级、自己的 cacheKey、
 * 不跟主会话换模型……）留在它自己的构造处，每一处旁边写着理由。
 */

import type { AgentEvent } from "../agent/events.ts";
import type { AfterToolCall, BeforeToolCall, PermissionRequestHook, ToolEnvironment } from "../agent/run-config.ts";
import type { Settings } from "../config/settings.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import { plumeHome } from "../session/store.ts";
import type { Message } from "../types.ts";
import { loadHookRunner, makeAfterToolCall, makeBeforeToolCall, makePermissionRequest, type TurnHooks } from "./hooks.ts";
import { writePreview } from "./previews.ts";
import { toolPolicy, type ToolPolicy } from "./tool-policy.ts";

/** 工具环境里跟着会话走的那几项；其余（派生、资源、scratch、等人开口）由各自的构造方补齐。 */
type InheritedToolEnv = Pick<ToolEnvironment, "cwd" | keyof ToolPolicy | "allowedPaths" | "transcript" | "writePreview">;

export function inheritedToolEnv(input: {
	settings: Settings;
	cwd: string;
	/** 预览记在哪个会话名下。子代理给的是派它的那个会话，理由见 `sub-agent-config.ts`。 */
	sessionId: string;
	allowedPaths: ReadonlySet<string> | undefined;
	transcript: (() => Promise<Message[]>) | undefined;
}): InheritedToolEnv {
	return {
		cwd: input.cwd,
		// Decided once per run, the same way for every kind of run; see `tool-policy.ts`.
		...toolPolicy(input.settings, input.cwd),
		allowedPaths: input.allowedPaths,
		/*
		 * Previews are written under the app's directory, keyed by the session.
		 *
		 * The workspace is the user's project; a page produced to demonstrate an idea
		 * is not part of it and should never turn up in `git status`. Keyed by session
		 * so it can be thrown away with the conversation that produced it.
		 */
		writePreview: (preview) => writePreview(plumeHome(), { ...preview, sessionId: input.sessionId }),
		transcript: input.transcript,
	};
}

/**
 * 这一次运行的钩子：读当前的钩子配置，并说清楚是谁在问。
 *
 * `agentName`、`agentId` 只有子代理给——同一个 `bash` 调用，钩子要分得出是主对话还是哪个子代理发的；
 * 同一种子代理并行派了几个，`agentId` 分得出是哪一个。
 * `emit` 把每次钩子运行作为 `hook_run` 交出去：主会话直接进它的日志，子代理包进 `subagent_event`。
 */
export async function loadTurnHooks(input: {
	settings: Settings;
	cwd: string;
	sessionId: string;
	signal: AbortSignal | undefined;
	agentName?: string;
	agentId?: string;
	emit?: (event: AgentEvent) => Promise<void>;
}): Promise<TurnHooks> {
	return {
		runner: await loadHookRunner({ settings: input.settings, cwd: input.cwd, emit: input.emit }),
		cwd: input.cwd,
		sessionId: input.sessionId,
		agentName: input.agentName,
		agentId: input.agentId,
		permissionMode: input.settings.permissionMode,
		signal: input.signal,
	};
}

/** 围着每一次工具调用的三个钩子。一轮开始和收尾的钩子不在这里：那属于拥有这一轮的对话。 */
export function toolHooks(
	hooks: TurnHooks,
	extensions?: ExtensionHost,
): { beforeToolCall: BeforeToolCall; afterToolCall: AfterToolCall; permissionRequest: PermissionRequestHook } {
	return {
		beforeToolCall: makeBeforeToolCall(hooks, extensions),
		afterToolCall: makeAfterToolCall(hooks, extensions),
		permissionRequest: makePermissionRequest(hooks),
	};
}
