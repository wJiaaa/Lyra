/**
 * 钩子交回来的东西怎么读：stdout 上的 JSON，按事件取出决定，再把几条钩子的结论并成一个。
 *
 * 语义：`continue: false` / `decision: "block"` 是拦，PreToolUse 的 `permissionDecision`
 * 几条之间取最严（deny > ask > allow），Stop 上的 block 是「别停，接着干」。
 */

import type { HookEventName } from "./config.ts";

type HookPermissionDecision = "allow" | "ask" | "deny";

type PermissionRequestHookDecision =
	| { behavior: "allow"; updatedInput?: unknown }
	| { behavior: "deny"; message?: string; interrupt?: boolean };

export interface HookJSONOutput {
	continue?: boolean;
	stopReason?: string;
	decision?: "approve" | "block";
	reason?: string;
	systemMessage?: string;
	suppressOutput?: boolean;
	additionalContext?: string;
	additional_context?: string;
	hookSpecificOutput?: {
		hookEventName: HookEventName;
		additionalContext?: string;
		permissionDecision?: HookPermissionDecision;
		permissionDecisionReason?: string;
		updatedInput?: unknown;
		decision?: PermissionRequestHookDecision;
	};
}

export interface HookRunResult {
	additionalContexts: string[];
	blockRequested?: boolean;
	preventContinuation?: boolean;
	permissionBehavior?: HookPermissionDecision;
	hookPermissionDecisionReason?: string;
	permissionRequestResult?: PermissionRequestHookDecision;
	stopShouldContinue?: boolean;
	stopReason?: string;
	updatedInput?: unknown;
}

export class HookOutputError extends Error {}

const TOP_LEVEL = new Set(["continue", "stopReason", "decision", "reason", "systemMessage", "suppressOutput", "additionalContext", "additional_context", "hookSpecificOutput"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: Record<string, unknown>, key: string, type: "string" | "boolean"): void {
	if (value[key] !== undefined && typeof value[key] !== type) throw new HookOutputError(`${key} must be a ${type}`);
}

/**
 * stdout 读成钩子输出。
 *
 * 不是 `{` 开头、或者根本不是 JSON 的，当作诊断文本忽略——钩子打一行日志不该让当前动作失败。
 * 是 JSON 但形状不对的，报错：那是一条想表达决定却写错了的钩子，照常放行等于替它做了决定。
 */
export function parseHookStdout(stdout: string): HookJSONOutput | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	for (const key of Object.keys(parsed)) if (!TOP_LEVEL.has(key)) throw new HookOutputError(`unknown field "${key}"`);
	optional(parsed, "continue", "boolean");
	optional(parsed, "suppressOutput", "boolean");
	for (const key of ["stopReason", "reason", "systemMessage", "additionalContext", "additional_context"]) optional(parsed, key, "string");
	if (parsed.decision !== undefined && parsed.decision !== "approve" && parsed.decision !== "block") throw new HookOutputError('decision must be "approve" or "block"');
	const specific = parsed.hookSpecificOutput;
	if (specific !== undefined) {
		if (!isRecord(specific) || typeof specific.hookEventName !== "string") throw new HookOutputError("hookSpecificOutput.hookEventName is required");
		optional(specific, "additionalContext", "string");
		optional(specific, "permissionDecisionReason", "string");
		if (specific.permissionDecision !== undefined && !["allow", "ask", "deny"].includes(specific.permissionDecision as string)) {
			throw new HookOutputError('permissionDecision must be "allow", "ask" or "deny"');
		}
		if (specific.decision !== undefined) {
			const decision = specific.decision;
			if (!isRecord(decision) || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
				throw new HookOutputError('decision.behavior must be "allow" or "deny"');
			}
		}
	}
	return parsed as HookJSONOutput;
}

function isPermissionEvent(event: HookEventName): boolean {
	return event === "PreToolUse" || event === "PermissionRequest";
}

function preventsContinuation(event: HookEventName): boolean {
	return event === "PreToolUse" || event === "PermissionRequest" || event === "UserPromptSubmit";
}

export function processHookOutput(event: HookEventName, output: HookJSONOutput | undefined): HookRunResult {
	const result: HookRunResult = { additionalContexts: [] };
	if (!output) return result;

	if (output.continue === false && event !== "Stop") {
		result.blockRequested = true;
		result.stopReason = output.stopReason ?? output.reason;
		if (preventsContinuation(event)) result.preventContinuation = true;
		if (isPermissionEvent(event)) result.permissionBehavior = "deny";
	}
	if (event === "Stop" && output.continue === true) {
		result.stopShouldContinue = true;
		result.stopReason = output.stopReason ?? output.reason;
	}
	if (output.decision === "approve" && isPermissionEvent(event)) result.permissionBehavior = "allow";
	if (output.decision === "block") {
		result.blockRequested = true;
		result.stopReason = output.stopReason ?? output.reason ?? output.systemMessage;
		if (isPermissionEvent(event)) result.permissionBehavior = "deny";
		if (preventsContinuation(event)) result.preventContinuation = true;
		if (event === "Stop") {
			result.stopShouldContinue = true;
			if (output.systemMessage) result.additionalContexts.push(output.systemMessage);
			if (output.reason) result.additionalContexts.push(output.reason);
		}
	}
	if (output.additionalContext) result.additionalContexts.push(output.additionalContext);
	if (output.additional_context) result.additionalContexts.push(output.additional_context);

	const specific = output.hookSpecificOutput;
	if (!specific) return result;
	if (specific.hookEventName !== event) throw new HookOutputError(`hookSpecificOutput is for ${specific.hookEventName}, not ${event}`);
	if (event === "PreToolUse") {
		if (specific.permissionDecision) {
			result.permissionBehavior = specific.permissionDecision;
			result.hookPermissionDecisionReason = specific.permissionDecisionReason;
		}
		if (specific.updatedInput !== undefined) result.updatedInput = specific.updatedInput;
	}
	if (event === "PermissionRequest" && specific.decision) result.permissionRequestResult = specific.decision;
	if (event !== "PermissionRequest" && specific.additionalContext) result.additionalContexts.push(specific.additionalContext);
	return result;
}

function strictest(current: HookPermissionDecision | undefined, next: HookPermissionDecision): HookPermissionDecision {
	if (current === "deny" || next === "deny") return "deny";
	if (current === "ask" || next === "ask") return "ask";
	return next;
}

export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
	target.additionalContexts.push(...next.additionalContexts);
	if (next.blockRequested) {
		target.blockRequested = true;
		target.stopReason = next.stopReason ?? target.stopReason;
	}
	if (next.preventContinuation) {
		target.preventContinuation = true;
		target.stopReason = next.stopReason;
	}
	if (next.stopShouldContinue !== undefined) {
		target.stopShouldContinue = next.stopShouldContinue;
		target.stopReason = next.stopReason ?? target.stopReason;
	}
	if (next.updatedInput !== undefined) target.updatedInput = next.updatedInput;
	if (next.permissionRequestResult) target.permissionRequestResult = next.permissionRequestResult;
	if (next.hookPermissionDecisionReason) target.hookPermissionDecisionReason = next.hookPermissionDecisionReason;
	if (next.permissionBehavior) target.permissionBehavior = strictest(target.permissionBehavior, next.permissionBehavior);
}

/**
 * 空或 `*` 匹配全部；只由字母、数字、`_`、`|` 组成的按名字精确匹配；其余当正则，写错了的正则不匹配。
 */
export function matchesHookMatcher(value: string | undefined, matcher: string | undefined): boolean {
	if (!matcher || matcher === "*") return true;
	if (!value) return false;
	if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) return matcher.split("|").includes(value);
	try {
		return new RegExp(matcher).test(value);
	} catch {
		return false;
	}
}

const SENSITIVE_KEY = "(?:access[_-]?token|api[_-]?key|credential|password|private[_-]?key|secret|token)";
const SENSITIVE_IDENTIFIER = `(?:[A-Za-z0-9]+[_-])*${SENSITIVE_KEY}(?:[_-][A-Za-z0-9]+)*`;
const MASK = "••••";

/** 命令和原因要画到会话里、写进会话记录，里面的口令先盖住。 */
export function sanitizeHookDisplayText(value: string): string {
	if (!value) return value;
	return value
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}:${MASK}@`)
		.replace(/(authorization\s*:\s*(?:basic|bearer)\s+)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu, `$1${MASK}`)
		.replace(new RegExp(`([?&](?:authorization|${SENSITIVE_IDENTIFIER})=)[^&\\s"']+`, "giu"), `$1${MASK}`)
		.replace(/(\bauthorization\b\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,"']+)/giu, `$1${MASK}`)
		.replace(new RegExp(`((?:"${SENSITIVE_IDENTIFIER}"|'${SENSITIVE_IDENTIFIER}')\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`, "giu"), `$1${MASK}`)
		.replace(new RegExp(`(^|[^A-Za-z0-9_])(${SENSITIVE_IDENTIFIER}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,"']+)`, "gimu"), `$1$2${MASK}`)
		.replace(new RegExp(`((?:--)?${SENSITIVE_IDENTIFIER})(\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "giu"), `$1$2${MASK}`);
}
