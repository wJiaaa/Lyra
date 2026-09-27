/**
 * 跑钩子。
 *
 * 一次 `run` 对应一个事件：挑出匹配的钩子，按配置顺序一条条跑（`async` 的放到后台），把它们交回来
 * 的决定并成一个。每条钩子的开始和结局各发一个 `hook_run`，会话里那个锚点按钮读的就是它们。
 *
 * 约定和 Claude Code / ZCode 一致：退出码 0 读 stdout 上的 JSON；2 是拦，原因取 stderr；其他非零
 * 是这条钩子自己坏了——记为失败，不替它做拦截的决定。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemShell } from "../platform.ts";
import { commandEnv } from "../sandbox/login-path.ts";
import type { HookRun } from "../agent/events.ts";
import {
	DEFAULT_HOOK_MAX_OUTPUT_BYTES,
	DEFAULT_HOOK_TIMEOUT_MS,
	hookTimeoutMs,
	type HookEntry,
	type HookEventName,
	type HooksConfig,
} from "./config.ts";
import {
	HookOutputError,
	matchesHookMatcher,
	mergeHookRunResult,
	parseHookStdout,
	processHookOutput,
	sanitizeHookDisplayText,
	type HookJSONOutput,
	type HookRunResult,
} from "./output.ts";

/** 交给钩子的输入。事件自己的字段（`toolName`、`prompt`……）挂在上面。 */
export interface HookInput {
	hookEventName: HookEventName;
	sessionId: string;
	cwd: string;
	agentName?: string;
	permissionMode?: string;
	[key: string]: unknown;
}

export interface HookRegistration {
	entry: HookEntry;
	/** 项目钩子没被信任时为 false：照样出现在记录里，标成被拦下，但不执行。 */
	trusted: boolean;
}

export interface HookRunnerOptions {
	hooks: HookRegistration[];
	timeoutMs?: number;
	maxOutputBytes?: number;
	emit?: (run: HookRun) => Promise<void> | void;
}

/**
 * Lyra 的工具名是小写的（`bash`、`edit`），照 Claude Code 写的 matcher 是 `Bash|Edit`。两种都认，
 * 同一份配置搬过来不用改。
 */
const TOOL_ALIASES: Record<string, string[]> = {
	bash: ["Bash"],
	bash_output: ["BashOutput"],
	read: ["Read"],
	write: ["Write"],
	edit: ["Edit", "MultiEdit"],
	glob: ["Glob"],
	grep: ["Grep"],
	ls: ["LS"],
	task: ["Task", "Agent"],
	todo_write: ["TodoWrite"],
	web_fetch: ["WebFetch"],
	web_search: ["WebSearch"],
	ask_user: ["AskUserQuestion"],
};

export function hookMatchValues(toolName: string): string[] {
	return [toolName, ...(TOOL_ALIASES[toolName] ?? [])];
}

const PREVIEW_MAX = 4000;

function preview(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= PREVIEW_MAX ? trimmed : `${trimmed.slice(0, PREVIEW_MAX)}...`;
}

export function hookCommandDisplay(entry: HookEntry): string {
	const { definition } = entry;
	const text = definition.type === "process"
		? [definition.command, ...(definition.args ?? [])].map((part) => (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part) ? part : JSON.stringify(part))).join(" ")
		: definition.command;
	return sanitizeHookDisplayText(text);
}

class HookFailure extends Error {
	readonly status: "failed" | "timed_out" | "cancelled";
	constructor(status: "failed" | "timed_out" | "cancelled", message: string) {
		super(message);
		this.status = status;
	}
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

function expandVariables(value: string, input: HookInput): string {
	const replacements: Record<string, string> = {
		CLAUDE_PROJECT_DIR: input.cwd,
		LYRA_PROJECT_DIR: input.cwd,
		CLAUDE_SESSION_ID: input.sessionId,
		CLAUDE_CODE_SESSION_ID: input.sessionId,
		LYRA_SESSION_ID: input.sessionId,
	};
	return value.replace(/\$\{(CLAUDE_PROJECT_DIR|LYRA_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_CODE_SESSION_ID|LYRA_SESSION_ID)\}/gu, (_match, key: string) => replacements[key]);
}

/**
 * stdin：Lyra 自己的 camelCase 字段，加上 Claude Code 脚本认的 snake_case 别名。`transcript_path`
 * 指向一份临时文件，只装着这次事件涉及的那条消息。
 */
async function compatibleStdin(input: HookInput): Promise<{ value: string; cleanup: () => Promise<void> }> {
	const compatible: Record<string, unknown> = {
		...input,
		hook_event_name: input.hookEventName,
		session_id: input.sessionId,
		permission_mode: input.permissionMode,
		agent_type: input.agentName,
	};
	if (typeof input.toolName === "string") {
		compatible.tool_name = input.toolName;
		compatible.tool_input = input.toolInput;
		compatible.tool_use_id = input.toolCallId;
	}
	if (input.hookEventName === "PostToolUse") compatible.tool_response = input.toolResponse;
	if (input.hookEventName === "PostToolUseFailure") {
		compatible.error = (input.error as { message?: string } | undefined)?.message;
		compatible.error_details = input.error;
	}
	if (input.hookEventName === "Stop") {
		compatible.last_assistant_message = input.responseText;
		compatible.stop_hook_active = input.stopHookActive;
	}
	const dir = await mkdtemp(join(tmpdir(), "lyra-hook-"));
	const transcriptPath = join(dir, "transcript.jsonl");
	const line = (role: "user" | "assistant", text: unknown) => `${JSON.stringify({ message: { role, content: [{ type: "text", text: String(text ?? "") }] } })}\n`;
	await writeFile(
		transcriptPath,
		input.hookEventName === "Stop" ? line("assistant", input.responseText) : input.hookEventName === "UserPromptSubmit" ? line("user", input.prompt) : "",
		"utf8",
	);
	compatible.transcript_path = transcriptPath;
	compatible.transcriptPath = transcriptPath;
	return { value: `${JSON.stringify(compatible)}\n`, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function spawnArgs(entry: HookEntry, input: HookInput): { file: string; args: string[] } {
	const { definition } = entry;
	if (definition.type === "process") {
		return { file: expandVariables(definition.command, input), args: (definition.args ?? []).map((arg) => expandVariables(arg, input)) };
	}
	const command = expandVariables(definition.command, input);
	if (typeof definition.shell === "string") return { file: definition.shell, args: ["-c", command] };
	// 和智能体自己的命令同一个 shell、同一套登录环境——GUI 启动的应用没有用户的 PATH，钩子里的 `jq` 就找不到。
	const shell = systemShell();
	return { file: shell.file, args: shell.args(command) };
}

function execute(entry: HookEntry, input: HookInput, stdin: string, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		if (!existsSync(input.cwd)) {
			reject(new HookFailure("failed", `working directory does not exist: ${input.cwd}`));
			return;
		}
		if (signal?.aborted) {
			reject(new HookFailure("cancelled", "cancelled"));
			return;
		}
		const { file, args } = spawnArgs(entry, input);
		const child = spawn(file, args, {
			cwd: input.cwd,
			// 自己一个进程组，超时时能把钩子派生出来的进程一起收掉。
			detached: process.platform !== "win32",
			windowsHide: true,
			env: {
				...commandEnv(process.env),
				CLAUDE_PROJECT_DIR: input.cwd,
				LYRA_PROJECT_DIR: input.cwd,
				CLAUDE_SESSION_ID: input.sessionId,
				CLAUDE_CODE_SESSION_ID: input.sessionId,
				LYRA_SESSION_ID: input.sessionId,
			},
		});
		const killTree = () => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "win32") {
				execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
				return;
			}
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		};

		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { if (stdout.length < maxBytes) stdout += chunk.slice(0, maxBytes - stdout.length); });
		child.stderr.on("data", (chunk: string) => { if (stderr.length < maxBytes) stderr += chunk.slice(0, maxBytes - stderr.length); });

		const timer = setTimeout(() => {
			killTree();
			finish(() => reject(new HookFailure("timed_out", `timed out after ${Math.round(timeoutMs / 1000)}s`)));
		}, timeoutMs);
		const onAbort = () => {
			killTree();
			finish(() => reject(new HookFailure("cancelled", "cancelled")));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => finish(() => reject(new HookFailure("failed", error.message))));
		child.on("close", (code) => finish(() => resolve({ exitCode: code, stdout, stderr })));

		// 钩子不一定读 stdin；读者早早退出时写入会 EPIPE，那不是错误——它不读，是它的事。
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

/** 退出码 2 换成等价的「拦」的输出，原因取 stderr。 */
function exitCodeBlock(event: HookEventName, result: ProcessResult): HookJSONOutput {
	const reason = preview(result.stderr) ?? preview(result.stdout) ?? "Hook blocked execution";
	if (event === "PreToolUse") {
		return { continue: false, reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
	}
	if (event === "PermissionRequest") {
		return { continue: false, reason, hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
	}
	if (event === "Stop") return { decision: "block", reason };
	return { continue: false, reason };
}

async function runOne(entry: HookEntry, input: HookInput, timeoutMs: number, maxBytes: number, signal?: AbortSignal): Promise<HookJSONOutput | undefined> {
	const stdin = await compatibleStdin(input);
	try {
		const result = await execute(entry, input, stdin.value, timeoutMs, maxBytes, signal);
		if (result.exitCode === 0) {
			try {
				return parseHookStdout(result.stdout);
			} catch (error) {
				throw new HookFailure("failed", `invalid hook output: ${(error as Error).message}`);
			}
		}
		if (result.exitCode === 2) return exitCodeBlock(input.hookEventName, result);
		throw new HookFailure("failed", preview(result.stderr) ?? `exited with status ${result.exitCode}`);
	} finally {
		await stdin.cleanup().catch(() => {});
	}
}

export class HookRunner {
	private readonly hooks: HookRegistration[];
	private readonly timeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly emit?: HookRunnerOptions["emit"];

	constructor(options: HookRunnerOptions) {
		this.hooks = options.hooks;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HOOK_MAX_OUTPUT_BYTES;
		this.emit = options.emit;
	}

	/** 这个事件上有没有任何会被考虑的钩子——没有就连输入都不必拼。 */
	has(event: HookEventName): boolean {
		return this.hooks.some(({ entry }) => entry.event === event && entry.definition.enabled !== false);
	}

	async run(input: HookInput, options: { matchValues?: readonly string[]; signal?: AbortSignal } = {}): Promise<HookRunResult> {
		const result: HookRunResult = { additionalContexts: [] };
		const values = options.matchValues ?? [];
		const matching = this.hooks.filter(
			({ entry }) =>
				entry.event === input.hookEventName &&
				entry.definition.enabled !== false &&
				(values.length === 0 ? matchesHookMatcher(undefined, entry.matcher) : values.some((value) => matchesHookMatcher(value, entry.matcher))),
		);
		if (matching.length === 0) return result;
		const invocationId = crypto.randomUUID();

		for (const { entry, trusted } of matching) {
			const base: HookRun = {
				id: crypto.randomUUID(),
				invocationId,
				event: input.hookEventName,
				source: entry.scope,
				command: hookCommandDisplay(entry),
				...(entry.matcher ? { matcher: entry.matcher } : {}),
				...(typeof input.toolName === "string" ? { toolName: input.toolName } : {}),
				...(entry.definition.statusMessage ? { statusMessage: entry.definition.statusMessage } : {}),
				status: "running",
				startedAt: Date.now(),
				at: 0,
			};
			if (!trusted) {
				await this.report({ ...base, status: "blocked", reason: "项目钩子尚未信任，未运行。到设置 → 钩子里审核。", durationMs: 0 });
				continue;
			}
			await this.report(base);
			const timeoutMs = hookTimeoutMs(entry.definition, this.timeoutMs);

			if (entry.definition.type === "command" && entry.definition.async) {
				// 后台钩子的结局不能回头改变已经继续往下走的动作，所以它的输出只进记录。
				void runOne(entry, input, timeoutMs, this.maxOutputBytes, options.signal).then(
					() => this.report({ ...base, status: "success", durationMs: Date.now() - base.startedAt }),
					(error) => this.report(this.failed(base, error)),
				);
				continue;
			}

			try {
				const output = await runOne(entry, input, timeoutMs, this.maxOutputBytes, options.signal);
				const processed = processHookOutput(input.hookEventName, output);
				mergeHookRunResult(result, processed);
				const blocked =
					processed.permissionBehavior === "deny" ||
					processed.permissionRequestResult?.behavior === "deny" ||
					processed.preventContinuation === true ||
					processed.blockRequested === true;
				const reason = blocked
					? processed.stopReason ??
						processed.hookPermissionDecisionReason ??
						(processed.permissionRequestResult?.behavior === "deny" ? processed.permissionRequestResult.message : undefined) ??
						"Hook blocked execution"
					: undefined;
				await this.report({
					...base,
					status: blocked ? "blocked" : "success",
					durationMs: Date.now() - base.startedAt,
					...(reason ? { reason: sanitizeHookDisplayText(reason).slice(0, PREVIEW_MAX) } : {}),
				});
			} catch (error) {
				await this.report(this.failed(base, error));
			}
		}
		return result;
	}

	private failed(base: HookRun, error: unknown): HookRun {
		const status = error instanceof HookFailure ? error.status : "failed";
		const message = error instanceof HookOutputError || error instanceof Error ? error.message : String(error);
		return { ...base, status, durationMs: Date.now() - base.startedAt, reason: sanitizeHookDisplayText(message).slice(0, PREVIEW_MAX) };
	}

	private async report(run: HookRun): Promise<void> {
		try {
			await this.emit?.(run);
		} catch {
			// 记录失败不该让钩子本身的结论作废。
		}
	}
}

/** 用户钩子全部上场；项目钩子带着信任状态上场，没信任的只会被记成「被拦下」。 */
export function createHookRunner(input: {
	user: { config: HooksConfig; entries: HookEntry[] };
	project?: { config: HooksConfig; entries: HookEntry[]; trusted: Set<string> };
	emit?: HookRunnerOptions["emit"];
}): HookRunner {
	const hooks: HookRegistration[] = [
		...input.user.entries.map((entry) => ({ entry, trusted: true })),
		...(input.project?.entries ?? []).map((entry) => ({ entry, trusted: input.project!.trusted.has(entry.digest) })),
	];
	// 项目层的默认值覆盖用户层，和设置的其他键一样。
	const timeoutMs = input.project?.config.timeoutMs ?? input.user.config.timeoutMs;
	const maxOutputBytes = input.project?.config.maxOutputBytes ?? input.user.config.maxOutputBytes;
	return new HookRunner({ hooks, timeoutMs, maxOutputBytes, emit: input.emit });
}
