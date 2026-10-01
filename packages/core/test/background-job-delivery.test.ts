/**
 * 后台命令结束时，结果自己送回会话——模型不用拿 `bash_output` 一遍遍去问。
 *
 * 本机一个真实会话起了 3 个后台任务，为此调了 6 次 `bash_output`，每次都是一整轮请求。这里从
 * `AgentSession` 这一头验整条路：闲着时叫醒、跑着时插进这一轮、读过的不再送、停下的不叫醒。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { useSandbox } from "../src/sandbox/index.ts";
import { backgroundJobs } from "../src/tools/background-jobs.ts";
import { bashOutputTool, bashTool } from "../src/tools/bash.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "gpt-6-astra",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: true,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: parts, api: "openai-responses", provider: "fake", model: "gpt-6-astra", usage: emptyUsage(), stopReason, timestamp: Date.now() };
}
const says = (text: string) => assistant([{ type: "text", text }]);
const startsBuild = () =>
	assistant([{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "pnpm build", description: "构建项目", run_in_background: true }, argumentsText: "{}" }], "toolUse");
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const delivered = (messages: Message[]) => messages.filter((message) => message.role === "user" && message.delivery?.some((report) => report.kind === "job"));

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

/** 一个假的后台进程：测试决定它什么时候打印、什么时候退出。 */
function fakeProcess() {
	let output: (chunk: string) => void = () => {};
	let exit: (code: number | null) => void = () => {};
	// oxlint-disable-next-line react-hooks/rules-of-hooks -- `useSandbox` binds the sandbox seam; it is not a React hook
	useSandbox({
		run: () => ({
			pid: 4242,
			onOutput(listener) { output = listener; },
			onExit(listener) { exit = listener; },
			onError() {},
			kill() {},
		}),
	});
	return { print: (chunk: string) => output(chunk), exit: (code: number | null) => exit(code) };
}

async function harness(reply: (context: LlmContext, requests: LlmContext[]) => Promise<AssistantMessage> | AssistantMessage) {
	const root = await mkdtemp(join(tmpdir(), "ly-job-delivery-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	const requests: LlmContext[] = [];
	const events: AgentEvent[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		emit: (event) => void events.push(event),
		streamFn: async (context) => {
			requests.push(context);
			return reply(context, requests);
		},
	});
	await session.initialize();
	return {
		session,
		requests,
		runs: () => events.filter((event) => event.type === "agent_start").length,
		jobId: () => backgroundJobs(session.can.state).list()[0]?.id ?? "",
		cleanup: async () => {
			session.abort();
			// oxlint-disable-next-line react-hooks/rules-of-hooks -- `useSandbox` binds the sandbox seam; it is not a React hook
			useSandbox(null);
			delete process.env.PLUME_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

/** 起一个后台构建，然后收尾；看到送达就说一句结论。 */
const startThenStop = (context: LlmContext) => {
	if (delivered(context.messages).length > 0) return says("构建通过了。");
	if (!context.messages.some((message) => message.role === "toolResult")) return startsBuild();
	return says("构建在后台跑着。");
};

test("闲着时后台命令结束：结果作为一条送达回来，开一轮新的接上，不用轮询", async () => {
	const job = fakeProcess();
	const h = await harness(startThenStop);
	try {
		await h.session.prompt([{ type: "text", text: "后台跑一下构建" }]);
		assert.equal(h.runs(), 1);
		const started = h.session.messages.find((message) => message.role === "toolResult");
		assert.match(started ? textOf(started) : "", /delivered to you as a message when it ends, so do not poll/, "起任务时就告诉模型不用轮询");

		job.print("built in 3.2s\n");
		job.exit(0);
		await until(() => h.runs() === 2 && !h.session.running, "送达之后开新回合");

		const [message] = delivered(h.session.messages);
		assert.ok(message && message.role === "user" && message.synthetic, "送达是运行时说的话，不是人说的");
		assert.deepEqual(message.role === "user" ? message.delivery : null, [{ id: h.jobId(), kind: "job", agent: "", description: "构建项目", command: "pnpm build", exitCode: 0, status: "done" }]);
		assert.match(textOf(message), /<background_job id="[^"]+" command="pnpm build" status="exited with code 0">\nbuilt in 3\.2s/);
		assert.match(textOf(h.session.messages.at(-1)!), /构建通过了/);

		const after = await bashOutputTool.execute({ id: h.jobId() }, { cwd: process.cwd(), sessionId: "x", state: h.session.can.state });
		assert.match(after.content.map((part) => ("text" in part ? part.text : "")).join(""), /\(no new output\)/, "送达替模型读过了，再读不重发");
	} finally {
		await h.cleanup();
	}
});

test("这一轮还在干别的时命令结束：插进同一轮，不另开一轮", async () => {
	const job = fakeProcess();
	const h = await harness(async (context, requests) => {
		if (delivered(context.messages).length > 0) return says("构建通过了，接着做完。");
		if (requests.length === 1) return startsBuild();
		// 模型在干别的的时候，命令结束了。
		job.exit(1);
		await settle();
		return says("我先去改文档。");
	});
	try {
		await h.session.prompt([{ type: "text", text: "后台构建，同时改文档" }]);
		assert.equal(h.runs(), 1, "没有为送达另开一轮");
		assert.equal(h.requests.length, 3, "送达在这一轮里被读到，循环接着跑了一个请求");
		const [message] = delivered(h.session.messages);
		assert.equal(message?.role === "user" ? message.delivery?.[0]?.status : null, "failed");
		assert.equal(message?.role === "user" ? message.delivery?.[0]?.exitCode : null, 1, "界面要靠它说出「退出码 1」");
		assert.match(textOf(message!), /status="exited with code 1"/);
	} finally {
		await h.cleanup();
	}
});

test("结束之后模型自己读到了，或任务被停掉、人按了停止：都不再叫醒会话", async (t) => {
	await t.test("已经读过结局", async () => {
		const job = fakeProcess();
		const h = await harness(startThenStop);
		try {
			await h.session.prompt([{ type: "text", text: "后台跑一下构建" }]);
			job.exit(0);
			await bashOutputTool.execute({ id: h.jobId() }, { cwd: process.cwd(), sessionId: "x", state: h.session.can.state });
			await settle();
			assert.equal(h.runs(), 1);
			assert.equal(delivered(h.session.messages).length, 0);
		} finally {
			await h.cleanup();
		}
	});
	await t.test("服务面板上点了停止", async () => {
		const job = fakeProcess();
		const h = await harness(startThenStop);
		try {
			await h.session.prompt([{ type: "text", text: "后台跑一下构建" }]);
			backgroundJobs(h.session.can.state).stop(h.jobId());
			job.exit(null);
			await settle();
			assert.equal(h.runs(), 1);
			assert.equal(delivered(h.session.messages).length, 0);
		} finally {
			await h.cleanup();
		}
	});
	await t.test("人按了停止，命令自己还在跑", async () => {
		const job = fakeProcess();
		const h = await harness(startThenStop);
		try {
			await h.session.prompt([{ type: "text", text: "后台跑一下构建" }]);
			h.session.abort();
			assert.equal(backgroundJobs(h.session.can.state).get(h.jobId())?.status, "running", "停止不杀后台命令");
			job.exit(0);
			await settle();
			assert.equal(h.runs(), 1, "刚说完「已停止」，不能又动起来");
			assert.equal(delivered(h.session.messages).length, 0);
		} finally {
			await h.cleanup();
		}
	});
});

test("没人订阅结束的地方（子代理自己的状态图）照旧告诉模型去读", async () => {
	fakeProcess();
	try {
		const result = await bashTool.execute({ command: "pnpm build", run_in_background: true }, { cwd: process.cwd(), sessionId: "sub", state: new Map() });
		const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
		assert.match(text, /Read its output with bash_output/);
		assert.doesNotMatch(text, /do not poll/, "没人送达的地方不能说「不用轮询」");
	} finally {
		useSandbox(null);
	}
});
