/**
 * 钩子：配置怎么读写、钩子交回来的东西怎么算、以及它们在一次工具调用前后真的起作用。
 *
 * 钩子进程多数用 `process` 类型跑 `node -e`，不经过 shell——断言的是协议，不是某个 shell 的方言，
 * 这样同一份测试在 Windows 上也成立。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { HookRun } from "../src/agent/events.ts";
import type { AgentToolContext } from "../src/agent/loop.ts";
import { runTools } from "../src/agent/tool-run.ts";
import { loadProjectLayer } from "../src/config/layers.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import {
	addHook,
	hookEntries,
	normalizeHooksConfig,
	readProjectHooks,
	removeHook,
	setHookEnabled,
	updateHook,
	writeProjectHooks,
	type HookDefinition,
	type HookEventName,
	type HooksConfig,
} from "../src/hooks/config.ts";
import { matchesHookMatcher, sanitizeHookDisplayText } from "../src/hooks/output.ts";
import { createHookRunner, HookRunner } from "../src/hooks/runner.ts";
import { trustHookDigests } from "../src/hooks/trust.ts";
import { loadHookRunner, makeAfterToolCall, makeBeforeToolCall, makeOnStop, makePermissionRequest, type TurnHooks } from "../src/runtime/hooks.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type Message, type Tool } from "../src/types.ts";
import { runConfig } from "./run-config.ts";

/** What `runTools` borrows from the run: who is asking, no stop, a fresh session state. */
const runScope = () => ({ sessionId: "s", signal: undefined, state: new Map<string, unknown>() });

let root: string;
const home = process.env.PLUME_HOME;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-hooks-"));
	// 信任记录写在 `~/.plume` 下，测试不能碰真的那份。
	process.env.PLUME_HOME = join(root, "home");
});
after(async () => {
	if (home === undefined) delete process.env.PLUME_HOME;
	else process.env.PLUME_HOME = home;
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

/** 一条跑 `node -e <script>` 的钩子；脚本从 stdin 读输入。 */
function node(script: string): HookDefinition {
	return { type: "process", command: process.execPath, args: ["-e", script] };
}

const READ_STDIN = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const input=JSON.parse(s);";

function config(event: HookEventName, definitions: HookDefinition[], matcher?: string): HooksConfig {
	return { events: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: definitions }] } };
}

function scope(hooks: HooksConfig, runs: HookRun[] = []): TurnHooks {
	const runner = createHookRunner({ user: { config: hooks, entries: hookEntries(hooks, "user") }, emit: (run) => void runs.push(run) });
	return { runner, cwd: root, sessionId: "s1" };
}

test("配置读进来时丢掉写错的部分，旧版的数组形状当作空", () => {
	const normalized = normalizeHooksConfig({
		events: {
			PreToolUse: [
				{ matcher: "Bash", hooks: [{ type: "command", command: "echo ok", timeout: 5 }, { type: "command" }, { type: "weird", command: "x" }] },
				{ hooks: [] },
			],
			NotAnEvent: [{ hooks: [{ type: "command", command: "x" }] }],
		},
	});
	assert.deepEqual(normalized, { events: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ok", timeout: 5 }] }] } });
});

test("增删改和开关都落在对的那一组里", () => {
	let hooks: HooksConfig = { events: {} };
	hooks = addHook(hooks, { event: "PreToolUse", matcher: "Bash", type: "command", command: "a" });
	hooks = addHook(hooks, { event: "PreToolUse", matcher: "Bash", type: "command", command: "b" });
	hooks = addHook(hooks, { event: "Stop", type: "process", command: "c", args: ["--x"], timeout: 3 });
	assert.deepEqual(hooks.events.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] }]);
	assert.deepEqual(hooks.events.Stop, [{ hooks: [{ type: "process", command: "c", args: ["--x"], timeoutMs: 3000 }] }]);

	const [first] = hookEntries(hooks, "user");
	hooks = setHookEnabled(hooks, first.id, false);
	assert.equal(hooks.events.PreToolUse![0].hooks[0].enabled, false);
	// 开关不改变指纹：信任过的项目钩子关掉再打开，不用重新审。
	assert.equal(hookEntries(hooks, "user")[0].digest, first.digest);

	hooks = updateHook(hooks, first.id, { event: "PreToolUse", matcher: "Edit", type: "command", command: "a2" });
	assert.deepEqual(hooks.events.PreToolUse, [
		{ matcher: "Bash", hooks: [{ type: "command", command: "b" }] },
		{ matcher: "Edit", hooks: [{ type: "command", command: "a2" }] },
	]);
	hooks = removeHook(hooks, hookEntries(hooks, "user").find((entry) => entry.event === "Stop")!.id);
	assert.equal(hooks.events.Stop, undefined);
});

test("项目钩子写回时只动 hooks 这个键，而且不参与设置合并", async () => {
	const cwd = join(root, "project-write");
	await mkdir(join(cwd, ".plume"), { recursive: true });
	await writeFile(join(cwd, ".plume", "config.json"), JSON.stringify({ thinking: "high" }));
	await writeProjectHooks(cwd, config("Stop", [{ type: "command", command: "echo done" }]));
	const written = JSON.parse(await readFile(join(cwd, ".plume", "config.json"), "utf8"));
	assert.equal(written.thinking, "high");
	assert.equal((await readProjectHooks(cwd)).config.events.Stop?.[0].hooks[0].command, "echo done");
	const layer = await loadProjectLayer(cwd);
	assert.equal("hooks" in layer.config, false, "项目钩子不能靠合并进设置来运行");
	assert.deepEqual(layer.refused, []);
});

test("matcher：名字列表、正则，以及 Claude Code 风格的工具名", async () => {
	assert.equal(matchesHookMatcher("bash", "bash|edit"), true);
	assert.equal(matchesHookMatcher("read", "bash|edit"), false);
	assert.equal(matchesHookMatcher("mcp__fs__read", "mcp__.*"), true);
	assert.equal(matchesHookMatcher("x", "(["), false, "写错的正则不匹配，而不是抛出去");

	const runs: HookRun[] = [];
	const before = makeBeforeToolCall(scope(config("PreToolUse", [node("process.exit(2)")], "Bash"), runs));
	const decision = await before({ toolName: "bash", args: {}, toolCallId: "c1" });
	assert.equal(decision?.block, true, "Bash 匹配 Plume 的 bash");
});

test("退出码 2 拦下调用、原因取 stderr；其他非零只记失败，不替它拦", async () => {
	const runs: HookRun[] = [];
	const blocking = makeBeforeToolCall(scope(config("PreToolUse", [node("process.stderr.write('不许动 lockfile');process.exit(2)")]), runs));
	const blocked = await blocking({ toolName: "write", args: { path: "pnpm-lock.yaml" }, toolCallId: "c1" });
	assert.equal(blocked?.block, true);
	assert.equal(blocked?.reason, "不许动 lockfile");
	assert.deepEqual(runs.map((run) => run.status), ["running", "blocked"]);

	runs.length = 0;
	const broken = makeBeforeToolCall(scope(config("PreToolUse", [node("process.exit(1)")]), runs));
	assert.equal((await broken({ toolName: "write", args: {}, toolCallId: "c2" }))?.block, undefined);
	assert.equal(runs.at(-1)?.status, "failed");
});

test("stdout 上的 JSON：几条之间取最严，能改参数，形状不对的算失败", async () => {
	const allow = node(`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'ls -la'}}}))`);
	const ask = node(`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'ask',permissionDecisionReason:'看一眼'}}))`);
	const before = makeBeforeToolCall(scope(config("PreToolUse", [allow, ask])));
	const decision = await before({ toolName: "bash", args: { command: "ls" }, toolCallId: "c1" });
	assert.equal(decision?.approval, "ask");
	assert.equal(decision?.approvalReason, "看一眼");
	assert.deepEqual(decision?.args, { command: "ls -la" });

	const runs: HookRun[] = [];
	const wrong = makeBeforeToolCall(scope(config("PreToolUse", [node(`console.log(JSON.stringify({decision:'maybe'}))`)]), runs));
	assert.equal((await wrong({ toolName: "bash", args: {}, toolCallId: "c2" }))?.block, undefined);
	assert.equal(runs.at(-1)?.status, "failed");
	assert.match(runs.at(-1)?.reason ?? "", /invalid hook output/);
});

test("stdin 带着输入，也带着 Claude Code 的字段名；不读 stdin 的钩子不会拖垮进程", async () => {
	const escaped: Error[] = [];
	const onUncaught = (error: Error) => escaped.push(error);
	process.on("uncaughtException", onUncaught);
	try {
		const echo = node(`${READ_STDIN}process.stdout.write(JSON.stringify({additionalContext:input.tool_name+':'+input.hook_event_name+':'+input.session_id}))})`);
		const after = makeAfterToolCall(scope(config("PostToolUse", [echo, node("process.exit(0)")])));
		// 远大于 64KB 的管道缓冲：第二条钩子不读就退出，写入会 EPIPE。
		const big = { content: "x".repeat(200_000) };
		const out = await after({ toolName: "write", args: big, toolCallId: "c1", result: { content: [{ type: "text", text: "ok" }] } });
		assert.match(JSON.stringify(out?.result.content), /write:PostToolUse:s1/);
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.deepEqual(escaped, []);
	} finally {
		process.off("uncaughtException", onUncaught);
	}
});

test("没信任的项目钩子不运行，只记一笔「被拦下」；信任之后按内容生效", async () => {
	const cwd = join(root, "project-trust");
	const marker = join(cwd, "ran.txt");
	await mkdir(cwd, { recursive: true });
	await writeProjectHooks(cwd, config("PreToolUse", [node(`require('fs').writeFileSync(${JSON.stringify(marker)},'1')`)]));

	const runs: HookRun[] = [];
	const settings = { ...DEFAULT_SETTINGS, hooks: { events: {} } };
	const untrusted: TurnHooks = { runner: await loadHookRunner({ settings, cwd, emit: (event) => void (event.type === "hook_run" && runs.push(event.run)) }), cwd, sessionId: "s1" };
	await makeBeforeToolCall(untrusted)({ toolName: "bash", args: {}, toolCallId: "c1" });
	await assert.rejects(readFile(marker, "utf8"));
	assert.deepEqual(runs.map((run) => [run.source, run.status]), [["project", "blocked"]]);

	const { config: projectHooks } = await readProjectHooks(cwd);
	const digests = hookEntries(projectHooks, "project").map((entry) => entry.digest);
	await trustHookDigests(cwd, digests, digests);
	const trusted: TurnHooks = { runner: await loadHookRunner({ settings, cwd }), cwd, sessionId: "s1" };
	await makeBeforeToolCall(trusted)({ toolName: "bash", args: {}, toolCallId: "c2" });
	assert.equal(await readFile(marker, "utf8"), "1");

	// 改了命令，旧的信任不算数。
	await writeProjectHooks(cwd, config("PreToolUse", [node("process.exit(0)")]));
	const changed = await loadHookRunner({ settings, cwd, emit: (event) => void (event.type === "hook_run" && runs.push(event.run)) });
	runs.length = 0;
	await makeBeforeToolCall({ runner: changed, cwd, sessionId: "s1" })({ toolName: "bash", args: {}, toolCallId: "c3" });
	assert.deepEqual(runs.map((run) => run.status), ["blocked"]);
});

test("工具调用：改过的参数真的被用上，allow 预先答掉工具自己的确认，PermissionRequest 能拒绝", async () => {
	const seen: Record<string, unknown>[] = [];
	const asked: string[] = [];
	const tool: Tool = {
		name: "bash",
		snippet: "bash",
		description: "bash",
		parameters: { type: "object", properties: {} },
		execute: async (args, ctx) => {
			seen.push(args);
			const decision = await ctx.requestApproval!({ kind: "bash", title: "run", detail: "", subject: "run" });
			return { content: [{ type: "text", text: decision === "reject" ? "rejected" : "ran" }] };
		},
	};
	const base: AgentToolContext = runConfig({
		tools: { available: [tool], env: { cwd: root }, requestApproval: async (request) => { asked.push(request.title); return "once"; } },
	}).tools;
	const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "ls" } };

	const allow = scope(config("PreToolUse", [node(`console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'ls -la'}}}))`)]));
	const [allowed] = await runTools([call], { ...base, beforeToolCall: makeBeforeToolCall(allow), permissionRequest: makePermissionRequest(allow) }, runScope(), async () => {});
	assert.deepEqual(seen.at(-1), { command: "ls -la" });
	assert.deepEqual(asked, [], "PreToolUse 放行过的调用不再问人");
	assert.match(JSON.stringify(allowed.content), /ran/);

	const deny = scope(config("PermissionRequest", [node("process.stderr.write('no');process.exit(2)")]));
	const [denied] = await runTools([call], { ...base, beforeToolCall: makeBeforeToolCall(deny), permissionRequest: makePermissionRequest(deny) }, runScope(), async () => {});
	assert.match(JSON.stringify(denied.content), /rejected/);
	assert.deepEqual(asked, [], "钩子答了就不弹窗");
});

test("提权只由人批：钩子的放行答不掉提权，钩子的拒绝照样算", async () => {
	const asked: string[] = [];
	const tool: Tool = {
		name: "bash",
		snippet: "bash",
		description: "bash",
		parameters: { type: "object", properties: {} },
		execute: async (_args, ctx) => {
			const confined = await ctx.requestApproval!({ kind: "bash", title: "run", detail: "", subject: "run" });
			const unconfined = await ctx.requestApproval!({ kind: "bash", title: "escalate", detail: "", subject: "escalate:danger-full-access:rm -rf build", escalation: "danger-full-access" });
			return { content: [{ type: "text", text: `${confined} ${unconfined}` }] };
		},
	};
	const base: AgentToolContext = runConfig({
		tools: { available: [tool], env: { cwd: root }, requestApproval: async (request) => { asked.push(request.title); return "reject"; } },
	}).tools;
	const call = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "rm -rf build" } };

	const [preAllowed] = await runTools([call], { ...base, beforeToolCall: async () => ({ approval: "allow" }) }, runScope(), async () => {});
	assert.match(JSON.stringify(preAllowed.content), /once reject/, "PreToolUse 放行只答掉沙箱里的那次");
	assert.deepEqual(asked, ["escalate"]);

	asked.length = 0;
	const [hookAllowed] = await runTools([call], { ...base, permissionRequest: async () => "once" }, runScope(), async () => {});
	assert.match(JSON.stringify(hookAllowed.content), /once reject/, "PermissionRequest 放行同样答不掉提权");
	assert.deepEqual(asked, ["escalate"]);

	asked.length = 0;
	const [hookDenied] = await runTools([call], { ...base, permissionRequest: async () => "reject" }, runScope(), async () => {});
	assert.match(JSON.stringify(hookDenied.content), /reject reject/);
	assert.deepEqual(asked, [], "钩子拒绝提权不必再问人");
});

test("Stop 钩子要求接着干时给出原因，连续三次封顶", async () => {
	const onStop = makeOnStop(scope(config("Stop", [node("process.stderr.write('测试还没跑');process.exit(2)")])))!;
	const results = [];
	for (let i = 0; i < 4; i++) results.push(await onStop({ responseText: "做完了", toolCallCount: 0 }));
	assert.equal(results.filter(Boolean).length, 3);
	assert.match(JSON.stringify(results[0]?.content), /测试还没跑/);
	assert.equal(results[0]?.role === "user" && results[0].synthetic, true, "模型看得见，界面不画");
});

test("后台钩子不挡路，结局照样记下来", async () => {
	const runs: HookRun[] = [];
	const hooks = config("PostToolUse", [{ type: "command", command: "exit 0", async: true }]);
	const runner = new HookRunner({ hooks: hookEntries(hooks, "user").map((entry) => ({ entry, trusted: true })), emit: (run) => void runs.push(run) });
	const result = await runner.run({ hookEventName: "PostToolUse", sessionId: "s", cwd: root, toolName: "bash" }, { matchValues: ["bash"] });
	assert.deepEqual(result.additionalContexts, []);
	for (let i = 0; i < 50 && runs.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(runs.map((run) => run.status), ["running", "success"]);
});

test("显示出来的命令盖掉口令", () => {
	assert.equal(sanitizeHookDisplayText("curl -H 'Authorization: Bearer abc123' https://u:p@host/x?token=zzz"), "curl -H 'Authorization: Bearer ••••' https://••••:••••@host/x?token=••••");
});

test("UserPromptSubmit 查的是人刚发的那句，不是同一轮先注入的 SessionStart 上下文", async () => {
	const cwd = join(root, "prompt-submit");
	await mkdir(cwd, { recursive: true });
	const model = { id: "p/m", modelId: "m", providerId: "p", name: "m", contextWindow: 100_000, maxOutputTokens: 1000, supportsThinking: false, supportsImages: false, supportsTools: true };
	const provider = { id: "p", name: "p", baseUrl: "http://localhost", api: "openai-responses" as const, apiKey: "x", enabled: true, models: [model] };
	const hooks: HooksConfig = { events: {
		SessionStart: [{ hooks: [node("console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'START_CONTEXT'}}))")] }],
		UserPromptSubmit: [{ hooks: [node(`${READ_STDIN}if(String(input.prompt).includes('BLOCK_ME')){process.stderr.write('不许发');process.exit(2)}});`)] }],
	} };
	const requests: Message[][] = [];
	const session = new AgentSession({
		cwd,
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id, mcpServers: [], hooks },
		store: new SessionStore(join(cwd, "sessions")),
		emit: () => {},
		streamFn: async (context) => {
			// 只记主会话的回合（带工具的那种）；起标题之类的旁路请求不算。
			if (context.tools.length > 0) requests.push([...context.messages]);
			return { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-responses", provider: "p", model: "m", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
		},
	});
	const said = (text: string) => (messages: readonly Message[]) => messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(text));
	try {
		await session.initialize();
		await session.prompt([{ type: "text", text: "请把 BLOCK_ME 发出去" }]);
		assert.ok(!requests.some(said("BLOCK_ME")), "被拦下的那句不该进任何模型请求");
		assert.ok(!said("BLOCK_ME")(session.messages), "也不该留在历史里");

		// 拦下的是开场那句：SessionStart 的上下文跟着一起撤了，下一轮要重新补上，而不是就此丢掉。
		await session.prompt([{ type: "text", text: "正常的一句" }]);
		const last = requests.at(-1)!;
		assert.ok(said("正常的一句")(last));
		assert.ok(said("START_CONTEXT")(last), "SessionStart 的上下文还在");
	} finally {
		await session.dispose();
	}
});
