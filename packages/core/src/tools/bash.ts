import { beforeCommand, afterCommand } from "./command-changes.ts";
import { createOutputLog } from "./output-log.ts";
import { randomUUID } from "node:crypto";
import { backgroundJobs, type BackgroundJob } from "./background-jobs.ts";
import { rerouteShellCommand, TOOL_NAMES_KEY } from "./reroute.ts";
import { getSandbox, looksDenied, looksNetworkDenied, selectRunner } from "../sandbox/index.ts";
import {
	approveEscalation,
	escalationHint,
	ESCALATION_TARGETS,
	networkDenialMarker,
	sandboxDenialMarker,
	validateEscalationArgs,
} from "./escalation.ts";
import { errorResult } from "../agent/tool-run.ts";
import { OutputBuffer } from "./bash-output.ts";
import { FRESH_RESULT_MAX_CHARS } from "../runtime/prune.ts";
import { authorizeCommandReads } from "./read-access.ts";
import { describeStatus, readExit } from "./exit-status.ts";
import { commandShell, type CommandShell } from "../platform.ts";
import type { SandboxProcess } from "../kernel/services.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** 界面上跟随后台任务时显示多少（`job.output`）。不发给模型，所以不受下面那条线约束。 */
const MAX_OUTPUT_CHARS = 60_000;
/**
 * 发给模型的输出上限，压在 `FRESH_RESULT_MAX_CHARS` 以内。
 *
 * 超过那条线的新结果会被 `AgedToolPruner` 在模型看到之前剪成前 4k、后 1k，`OutputBuffer` 专门从
 * 中段摘出来的错误行正好落在被剪掉的那一段。留 2000 字符给续读提示和截断标记。
 */
const MODEL_OUTPUT_CHARS = FRESH_RESULT_MAX_CHARS - 2000;
/** How often streaming output is forwarded to whoever is watching. See `execute`'s ticker. */
const PROGRESS_INTERVAL_MS = 100;

interface BashArgs {
	command: string;
	description?: string;
	timeout?: number;
	run_in_background?: boolean;
	/** The wider sandbox mode this command needs; only valid retrying one the sandbox denied. */
	escalate?: string;
	/** Why that wider mode is needed, in one sentence, shown to the user verbatim. */
	justification?: string;
}

/**
 * Commands that are never worth an approval prompt: they read state and cannot mutate the
 * workspace. Anything not on this list goes through `requestApproval`.
 *
 * Read this as the strongest claim in the file, because that is what it is. A `true` from
 * `isReadOnlyCommand` does not mean "probably fine" — it means the command never reaches
 * `requestApproval` at all, so it is not judged by `assessCommand` either, in any permission mode.
 * It is the one path around the whole risk classifier, and it had no tests.
 *
 * So the bar for being on this list is that the program cannot change anything *whatever its
 * arguments are*. Four kinds of entry were on it that do not meet that bar:
 *
 *   `env`      — `env FOO=1 rm -rf ~` is `rm`, and the first word is `env`
 *   `find`     — `find . -delete` deletes, and `-exec` runs anything
 *   `node` and every other interpreter — they run a file, which can do anything
 *   `npm run`  — runs whatever the package says; `git stash` moves the working tree
 *
 * None of them needs a shell metacharacter, so the guard below never saw any of them.
 */
const READ_ONLY_COMMANDS = new Set([
	"ls", "pwd", "echo", "cat", "head", "tail", "wc", "which", "whoami", "date",
	"grep", "rg", "fd", "tree", "du", "df", "stat", "file", "basename", "dirname",
]);

const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
	// `stash` is gone: it takes the working tree away, which is the thing `git reset` is asked
	// about. `config` stays only for the forms that read — see `WRITES_ANYWAY`.
	git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "rev-parse", "blame"]),
	// `run` is gone: `npm run build` executes whatever `package.json` names.
	npm: new Set(["ls", "view", "outdated"]),
	pnpm: new Set(["ls", "view", "outdated", "why"]),
	docker: new Set(["ps", "images", "logs"]),
};

/**
 * Programs that only have a read-only use when they are being asked about themselves.
 *
 * `node --version` cannot do anything; `node build.js` can do everything. They were on the list
 * above with no distinction drawn, which made every script this agent runs invisible to the
 * approval path. Keeping the informational form is worth it — checking a toolchain version is
 * something the agent does constantly, and it is genuinely nothing.
 */
const VERSION_ONLY = new Set(["node", "python", "python3", "go", "cargo", "rustc", "tsc", "deno", "bun", "java", "ruby", "perl", "php"]);
const INFORMATIONAL = /^(--version|-v|-V|--help|-h|version)$/;

/**
 * Arguments that turn one of the programs above into something that writes.
 *
 * A veto rather than more entries in the sets: the sets say what a program is for, and this says
 * when it is being used for something else.
 */
const WRITES_ANYWAY: Record<string, RegExp> = {
	// `find -delete` and `-exec` are the two that matter; the `-f*` family writes files too.
	find: /^(-delete|-exec|-execdir|-ok|-okdir|-fls|-fprint|-fprintf|-fprint0)$/,
	// Everything except reading it back is a write to a config file.
	git: /^(--replace-all|--add|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/,
	// A pager that can shell out is not a reader.
	docker: /^(--format=.*exec.*)$/,
};

export function isReadOnlyCommand(command: string): boolean {
	/*
	 * Any shell metacharacter can chain a mutating command onto a safe one.
	 *
	 * `\n` and `\r` included. They separate commands exactly as `;` does, and their absence here
	 * was a complete bypass: `ls\nrm -rf ~` has `ls` as its first word, no metacharacter from the
	 * old set, and so skipped the approval prompt while running both halves.
	 */
	if (/[;&|><`$(){}\n\r]/.test(command)) return false;
	const parts = command.trim().split(/\s+/);
	const head = parts[0];
	if (!head) return false;
	const args = parts.slice(1);

	const veto = WRITES_ANYWAY[head];
	if (veto && args.some((arg) => veto.test(arg))) return false;

	if (READ_ONLY_COMMANDS.has(head)) return true;

	/*
	 * `env` prints the environment, which is read-only — right up until it is given something to
	 * run. With assignments and nothing else, there is nothing to run.
	 */
	if (head === "env") return args.every((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));

	if (VERSION_ONLY.has(head)) return args.length > 0 && args.every((arg) => INFORMATIONAL.test(arg));

	const sub = READ_ONLY_SUBCOMMANDS[head];
	if (head === "git" && args[0] === "config") return gitConfigReads(args.slice(1));
	return sub ? sub.has(args[0] ?? "") : false;
}

/**
 * `git config` 只有读的形式算只读：`git config k v` 是赋值，没有任何旗标，`WRITES_ANYWAY` 看不见它。
 * 这不是无害的赋值——`core.fsmonitor`、`filter.*`、`core.hooksPath` 写进去，之后在沙箱外跑的每一个
 * git 都会替它执行程序。带值的旗标（`--file x`）会被数成第二个位置参数，按写处理，宁可多问一次。
 */
function gitConfigReads(args: string[]): boolean {
	if (args.some((arg) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/.test(arg))) return true;
	const positional = args.filter((arg) => !arg.startsWith("-"));
	if (positional[0] === "get" || positional[0] === "list") return true;
	return positional.length === 1 && !/^(set|unset|edit|rename-section|remove-section)$/.test(positional[0]);
}

export const bashTool: Tool<BashArgs> = {
	name: "bash",
	/*
	 * What the model has to know about the shell itself is not here: it depends on the session's
	 * permission mode (a confined command on Windows runs in PowerShell — see `commandShell`), which
	 * a tool shared by every session cannot know. The system prompt names it in the environment;
	 * see `shellGuidance`.
	 */
	description:
		"Run a shell command in the workspace. Prefer the dedicated tools over their shell equivalents: read over `cat`/`head`/`tail`, " +
		"edit over `sed`, glob over `find`, grep over shell `grep`. Quote paths that may contain spaces. " +
		"Every call starts fresh in the workspace root: a `cd`, variables " +
		"and functions do not carry over, so chain dependent steps in one command (`cd sub && make`). Use `run_in_background: true` for long-running processes such as dev servers, " +
		"then read their output with `bash_output`. A command still running when the default timeout passes is moved " +
		"to the background instead of being killed; an explicit `timeout` is a hard limit. " +
		"Commands may run under a file sandbox. A blocked write is reported as a policy denial, not a bug in the " +
		"command — do not retry it another way. When one is denied and a wider mode would let it through, retry that " +
		"exact command once with `escalate` and `justification`; the user is asked, and the grant covers only that call. " +
		"Never escalate up front: only after this session has actually denied the same access.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "The command to run." },
			description: { type: "string", description: "5-10 word description shown to the user." },
			timeout: {
				type: "number",
				description:
					"Hard limit in milliseconds, max 600000: the command is killed when it passes. Without it, a command " +
					"still running after 120000 ms keeps running as a background job.",
			},
			run_in_background: { type: "boolean", description: "Detach the process and return immediately." },
			escalate: {
				type: "string",
				enum: [...ESCALATION_TARGETS],
				description:
					"Only valid as a one-shot retry of a command the sandbox just denied. The narrowest mode that would " +
					"let it through. Requires justification, and asks the user.",
			},
			justification: {
				type: "string",
				description: "One sentence on why the wider mode is needed. Shown to the user verbatim.",
			},
		},
		required: ["command"],
		additionalProperties: false,
	},
	mutating: true,
	/*
	 * Only a command that provably writes nothing may overlap others. Two writers at once race on
	 * the files, and each one's before/after git snapshot would claim the other's changes as its own.
	 */
	executionModeFor: (args) => (typeof args.command === "string" && !args.escalate && isReadOnlyCommand(args.command) ? "parallel" : "sequential"),
	summarize: (args) => args.description ?? args.command.split("\n")[0].slice(0, 80),

	async execute(args, ctx): Promise<ToolResult> {
		if (typeof args.command !== "string" || !args.command.trim()) {
			return errorResult("`command` is required.");
		}

		/*
		 * 裸的 `cat` / `grep` / `find` / `ls` 改道到专用工具。
		 *
		 * 在提权和审批之前：一条要被改道的命令不该先问用户「允许吗」再说「其实别用这个」。
		 * 见 `reroute.ts`——有管道、重定向、串联的一律放行，那是真的在组合。
		 */
		const reroute = rerouteShellCommand(args.command, ctx.state.get(TOOL_NAMES_KEY) as ReadonlySet<string> | undefined);
		/*
		 * An error to the model, a redirection to everyone counting.
		 *
		 * `isError` stays because that is what makes the model pick the other tool — a劝告 it can
		 * skim does not. But nothing ran, nothing broke, and nothing needs looking into, so the
		 * record says which of the two this was. Without the marker these land in the same bucket as
		 * a failing build when anyone asks how a session went, and 「工具大量失败」 is a very
		 * different report from 「模型用了 cat，被改道到 read」.
		 */
		if (reroute) return { ...errorResult(reroute.message), details: { kind: "reroute", tool: reroute.tool } };

		/*
		 * The escalation, resolved before anything runs.
		 *
		 * A refused request never reaches the user: asking for a mode that is not wider grants
		 * nothing, so there is nothing to decide. What does reach them is the model's own sentence
		 * about why — which is the difference between a prompt somebody can answer and one they
		 * can only guess at.
		 */
		let mode = ctx.sandboxMode;
		try {
			validateEscalationArgs(args.escalate, args.justification);
			if (args.escalate) {
				mode = await approveEscalation(
					{
						requested: args.escalate,
						justification: args.justification!,
						current: ctx.sandboxMode ?? "danger-full-access",
						subject: "命令",
					},
					ctx.requestApproval
						? async (reason, target) =>
								(await ctx.requestApproval!({
									kind: "bash",
									title: `提权运行：${args.description ?? args.command.split("\n")[0].slice(0, 60)}`,
									detail: args.command,
									subject: `escalate:${args.escalate}:${args.command}`,
									reason,
									escalation: target,
								})) === "reject"
									? "reject"
									: "once"
						: undefined,
				);
			}
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}

		/*
		 * What this command reads, judged the way the file tools judge it.
		 *
		 * Above the read-only table on purpose. That table decides whether a command is *changing*
		 * anything, and it answers "no" for `cat` whatever `cat` is pointed at — which made this
		 * tool the way around `read`'s workspace boundary and around the credential rule both.
		 * Asking here means one answer to "may this be read", wherever the reading starts.
		 */
		const refusedRead = await authorizeCommandReads(args.command, ctx);
		if (refusedRead) return errorResult(refusedRead);

		if (ctx.requestApproval && !args.escalate && !isReadOnlyCommand(args.command)) {
			const decision = await ctx.requestApproval({
				kind: "bash",
				title: args.description ?? "Run shell command",
				detail: args.command,
				subject: args.command,
			});
			if (decision !== "once" && decision !== "always") return errorResult("The user rejected this command.");
		}

		/*
		 * The shell the model was told it writes for: the session's mode picks it, not the mode this
		 * one call was escalated to. A PowerShell command granted full access is still PowerShell.
		 */
		const shell = commandShell(ctx.sandboxMode);

		if (args.run_in_background) return startBackground(args, { ...ctx, sandboxMode: mode }, shell);

		/*
		 * A timeout the model asked for is a limit; the default one is only a point to stop waiting.
		 *
		 * Killing at the default threw away work that was nearly done — `bun install && bun test &&
		 * bun run build` was two minutes in, and the retry started from nothing — and gave a watcher
		 * like `gh run watch` a red cross for doing its job. Past the default the command keeps
		 * running as a background job the model can read or stop. A `timeout` in the call still
		 * kills, because then the model has said how long this may take.
		 */
		const hardLimit = args.timeout !== undefined;
		const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
		let baseline: Awaited<ReturnType<typeof beforeCommand>> = null;
		let changeWarning: string | undefined;
		try { baseline = await beforeCommand(ctx); } catch (error) { changeWarning = String(error); }
		const outputLog = await createOutputLog(ctx.scratchDir);
		/** Set when the command outlives this call: its log then stays open for the job that continues it. */
		let handedOff = false;
		const result = await new Promise<ToolResult>((resolve) => {
			/*
			 * `mode` may have been widened by an escalation just now; `network` never is.
			 *
			 * The file modes are a scale, so `escalate` has somewhere to move along. The network is
			 * one switch with one position, and `escalation.ts` deliberately offers no grant for it
			 * — so this reads the turn's setting rather than anything decided above.
			 */
			let child: SandboxProcess;
			try {
				child = getSandbox().run(args.command, { cwd: ctx.cwd, mode, network: ctx.sandboxNetwork, shell });
			} catch (error) {
				// A sandbox that cannot confine says so by throwing; the model gets the sentence, not a crash.
				resolve(errorResult(`Failed to start command: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}

			// 累计的原始输出；给模型看的那一份每次都从它截一次，见 `bash-output.ts`。
			const buffer = new OutputBuffer();
			const output = () => buffer.render(MODEL_OUTPUT_CHARS);
			let settled = false;
			/*
			 * Progress is coalesced rather than forwarded per chunk.
			 *
			 * Every one of these crosses a process boundary and replaces the whole card: the payload
			 * is the accumulated output, so a command that prints steadily sends `MODEL_OUTPUT_CHARS`
			 * again for each chunk. A build printing its asset list a line at a time — 192 KB over
			 * 2000 chunks — put 193 MB through the bridge to say 192 KB, a 515× amplification, and
			 * the window spent it re-rendering 60,000 characters of monospace text two thousand
			 * times. That is what "the command is stuck" looked like: the command was fine, the
			 * window could not keep up with being told about it.
			 *
			 * Ten frames a second is faster than anyone reads and bounds the cost by wall-clock
			 * instead of by how chatty the command is. The trailing edge matters as much as the
			 * rate: without it the last chunk before exit is the one nobody sees.
			 */
			let pending = false;
			let ticker: ReturnType<typeof setInterval> | undefined;
			const flush = () => {
				if (!pending) return;
				pending = false;
				ctx.onProgress?.({ content: [{ type: "text", text: output() }] });
			};
			const stopTicking = () => {
				if (ticker === undefined) return;
				clearInterval(ticker);
				ticker = undefined;
			};
			child.onOutput((chunk) => {
				// Once the call has answered, the output belongs to whatever took the command over.
				if (settled) return;
				outputLog?.append(chunk);
				buffer.append(chunk);
				pending = true;
				if (ticker === undefined && ctx.onProgress) {
					ticker = setInterval(flush, PROGRESS_INTERVAL_MS);
					// Never a reason to hold the process open: the result is what the turn waits on.
					ticker.unref?.();
				}
			});

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				stopTicking();
				ctx.signal?.removeEventListener("abort", onAbort);
				if (hardLimit) {
					child.kill();
					resolve({
						content: [{ type: "text", text: `${output()}${fullLogHint(buffer, outputLog?.path)}\n\n[timed out after ${timeout}ms]` }],
						details: { kind: "bash", command: args.command, timedOut: true },
						isError: true,
					});
					return;
				}
				handedOff = true;
				const id = adoptJob(ctx, args.command, child, outputLog, buffer);
				resolve({
					content: [{
						type: "text",
						text:
							`${output().trim() || "(no output yet)"}${fullLogHint(buffer, outputLog?.path)}\n\n[still running after ${Math.round(timeout / 1000)}s — ` +
							`now background job ${id}. Read its output with bash_output({ id: "${id}" }); ` +
							`stop it with bash_output({ id: "${id}", kill: true }).]`,
					}],
					details: { kind: "bash", command: args.command, backgrounded: true, jobId: id },
				});
			}, timeout);

			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				stopTicking();
				child.kill();
				resolve({
					content: [{ type: "text", text: `${output()}\n\n[cancelled]` }],
					details: { kind: "bash", command: args.command, cancelled: true },
					isError: true,
				});
			};
			ctx.signal?.addEventListener("abort", onAbort, { once: true });

			child.onError((error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				stopTicking();
				ctx.signal?.removeEventListener("abort", onAbort);
				resolve(errorResult(`Failed to start command: ${error.message}`));
			});

			child.onExit((code, signal, lingering) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				stopTicking();
				ctx.signal?.removeEventListener("abort", onAbort);
				const text = output().trim();
				/*
				 * Say when it was the sandbox, not the command.
				 *
				 * A denied write fails the way a full disk or a wrong path fails — some non-zero
				 * code and a message about permission — and a model that cannot tell the two apart
				 * does the worst possible thing: it tries the same write another way, three times,
				 * and reports that the tool is broken. The marker turns "it failed" into "it was
				 * refused", and the hint beside it is the sanctioned way forward.
				 */
				const ranUnder = mode;
				const denied =
					ranUnder !== undefined &&
					ranUnder !== "danger-full-access" &&
					looksDenied(output(), selectRunner({}, ctx.sandboxNetwork ?? "allow"));
				/*
				 * And the same for the network, which needs it more.
				 *
				 * A write denial at least prints something recognisable; a denied socket prints
				 * `Could not resolve host`, so without this the model spends its remaining turns
				 * retrying, switching registries and blaming DNS. The policy is what identifies it
				 * — see `looksNetworkDenied`, which will not answer without being told the policy.
				 */
				const cutOff = looksNetworkDenied(output(), ctx.sandboxNetwork);
				/*
				 * Whether it failed, read the way a person reads it — see `exit-status.ts`. `grep`
				 * finding nothing and `gh pr checks` reporting pending checks are answers.
				 *
				 * And the status always reaches the model in words. It used to be said only when
				 * there was no output, and only providers with an `is_error` field carry the flag —
				 * so behind an OpenAI-compatible endpoint a failed build and a passing one looked the
				 * same whenever either printed anything.
				 */
				const reading = readExit(args.command, code, output(), shell.kind);
				const status =
					code === 0 ? undefined : `[${describeStatus(code, signal)}${reading.meaning ? ` — ${reading.meaning}; not a failure` : ""}]`;
				const leftBehind = lingering ? adoptJob(ctx, args.command, lingering, undefined) : undefined;
				const markers = [
					...(denied ? [sandboxDenialMarker(ranUnder), escalationHint("command")] : []),
					...(cutOff ? [networkDenialMarker()] : []),
					...(leftBehind
						? [
								`[processes it started in the background are still running and holding its output — background job ${leftBehind}. ` +
									`Read it with bash_output({ id: "${leftBehind}" }); stop it with bash_output({ id: "${leftBehind}", kill: true }). ` +
									"They are stopped when the session ends.]",
							]
						: []),
				];
				const body = [`${text || "(no output)"}${fullLogHint(buffer, outputLog?.path)}`, ...(status ? [status] : []), ...markers].join("\n\n");
				resolve({
					content: [{ type: "text", text: body }],
					details: {
						kind: "bash",
						command: args.command,
						exitCode: code,
						...(signal ? { signal } : {}),
						...(reading.meaning && !reading.failed ? { exitMeaning: reading.meaning } : {}),
						...(denied ? { denied: true } : {}),
						...(cutOff ? { networkDenied: true } : {}),
						...(leftBehind ? { jobId: leftBehind } : {}),
					},
					isError: reading.failed || denied || cutOff,
				});
			});
		});
		const outputDetails = handedOff ? { outputPath: outputLog?.path } : await outputLog?.close();
		let changeIds: string[] = [];
		try { changeIds = await afterCommand(ctx, baseline); } catch (error) { changeWarning = String(error); }
		const details = result.details && typeof result.details === "object" ? result.details : {};
		return { ...result, details: { ...details, ...outputDetails, changeIds, changeWarning } };
	},
};

/**
 * Keep a process that is still running as a background job of this session.
 *
 * For a command that outlived the default timeout, and for what a finished command left running
 * with its output still attached. Either way it can be read and stopped like one started with
 * `run_in_background`, and `dispose` stops it with the session.
 *
 * `seen` 是模型在这次调用的结果里已经看过的输出：之后 `bash_output` 只给它后面的部分。
 */
function adoptJob(
	ctx: ToolContext,
	command: string,
	process: SandboxProcess,
	outputLog: Awaited<ReturnType<typeof createOutputLog>> | undefined,
	seen?: OutputBuffer,
): string {
	const id = randomUUID();
	const job: BackgroundJob = {
		id,
		command,
		startedAt: Date.now(),
		exitCode: null,
		output: "",
		outputPath: outputLog?.path,
		pid: process.pid,
		status: "running",
	};
	track(job, process, outputLog, seen);
	backgroundJobs(ctx.state).add(job, process);
	return id;
}

/**
 * 一个后台任务的两份输出：`all` 是从头累计的（桌面端从里面找服务地址），`unread` 是模型上次
 * `bash_output` 之后的。以前每次轮询都把 `all` 整份重发，一个开发服务器轮询十次就是十份同样的日志。
 */
interface JobStream {
	all: OutputBuffer;
	unread: OutputBuffer;
}
const streams = new WeakMap<BackgroundJob, JobStream>();

/** Follow a job's output and exit, whoever started it. */
function track(job: BackgroundJob, process: SandboxProcess, outputLog: Awaited<ReturnType<typeof createOutputLog>> | undefined, seen?: OutputBuffer): void {
	const all = seen ?? new OutputBuffer();
	const stream: JobStream = { all, unread: new OutputBuffer(all.end) };
	streams.set(job, stream);
	Object.defineProperty(job, "output", { get: () => all.render(MAX_OUTPUT_CHARS), enumerable: true, configurable: true });
	process.onOutput((chunk) => {
		outputLog?.append(chunk);
		stream.all.append(chunk);
		stream.unread.append(chunk);
	});
	process.onExit((code) => {
		void outputLog?.close().then((details) => Object.assign(job, details));
		job.exitCode = code;
		job.finishedAt = Date.now();
		job.status = code !== null && code !== 0 ? "failed" : "exited";
	});
	process.onError((error) => {
		void outputLog?.close().then((details) => Object.assign(job, details));
		job.error = error.message;
		job.status = "failed";
		if (!job.pid) job.finishedAt = Date.now();
	});
}

async function startBackground(args: BashArgs, ctx: ToolContext, shell: CommandShell): Promise<ToolResult> {
	const outputLog = await createOutputLog(ctx.scratchDir);
	const id = randomUUID();
	let child: SandboxProcess;
	try {
		child = getSandbox().run(args.command, { cwd: ctx.cwd, mode: ctx.sandboxMode, network: ctx.sandboxNetwork, shell });
	} catch (error) {
		await outputLog?.close();
		return errorResult(`Failed to start command: ${error instanceof Error ? error.message : String(error)}`);
	}

	const job: BackgroundJob = {
		id,
		command: args.command,
		startedAt: Date.now(),
		exitCode: null,
		output: "",
		outputPath: outputLog?.path,
		pid: child.pid,
		status: "running",
	};
	track(job, child, outputLog);

	backgroundJobs(ctx.state).add(job, child);
	return {
		content: [{ type: "text", text: `Started background job ${id}. Read its output with bash_output({ id: "${id}" }).` }],
		details: { kind: "bash_background", id, command: args.command, outputPath: outputLog?.path },
	};
}

interface BashOutputArgs {
	id: string;
	kill?: boolean;
}

export const bashOutputTool: Tool<BashOutputArgs> = {
	name: "bash_output",
	description: "Read a background job's new output since your last bash_output call (the first call returns everything so far), and optionally kill it.",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "Job id returned by bash." },
			kill: { type: "boolean", description: "Terminate the job after reading its output." },
		},
		required: ["id"],
		additionalProperties: false,
	},
	summarize: (args) => `Check job ${args.id}`,

	async execute(args, ctx): Promise<ToolResult> {
		const job = backgroundJobs(ctx.state).get(args.id);
		if (!job) return errorResult(`No background job with id "${args.id}".`);
		if (args.kill) backgroundJobs(ctx.state).stop(args.id, true);
		const status = job.finishedAt === undefined ? job.status : job.exitCode === null ? "terminated" : `exited with code ${job.exitCode}`;
		// 只给上次读过之后的部分；读完游标移到末尾。更早的部分模型已经看过，要回看就读完整日志。
		const stream = streams.get(job);
		let text = job.output;
		let hint = "";
		if (stream) {
			text = stream.unread.render(MODEL_OUTPUT_CHARS);
			hint = fullLogHint(stream.unread, job.outputPath);
			stream.unread = new OutputBuffer(stream.all.end);
		}
		return {
			content: [{ type: "text", text: `[job ${job.id} ${status}]\n${text || "(no new output)"}${hint}` }],
			details: { kind: "bash_output", id: job.id, exitCode: job.exitCode, command: job.command, outputPath: job.outputPath, outputComplete: job.outputComplete, outputError: job.outputError },
		};
	},
};

/**
 * 输出被截过时，告诉模型完整日志在哪。以前只放在 `details` 里，模型看不到，标记里的 `char_offset`
 * 于是无处可用。日志在 scratch 下，`read` 不需要授权；标记里的行号就是这个文件的行号。
 */
function fullLogHint(buffer: OutputBuffer, path: string | undefined): string {
	if (!path || !buffer.clipped(MODEL_OUTPUT_CHARS)) return "";
	return `\n\n[full output: ${path} — read it with offset/char_offset for the omitted lines]`;
}
