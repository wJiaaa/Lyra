/**
 * 应用退出时子代理还在跑；重新打开、人说「继续」——续上的是原来那一个，带着它读过的东西。
 *
 * 从前登记簿只在内存里：重开之后名单是空的，主会话那条 `task` 只剩一句「Plume exited while this
 * call was running」，没有 id；就算有，`resume` 也只能得到「上下文已经不在了」。模型只好从零重派。
 *
 * 「进程退出」在这里是关掉第一个会话的 store：调用的登记随之作废，跟换了一个进程打开同一个库时
 * 看到的一样（`SessionStore.close`）。第二个会话走的是桌面端打开旧会话的那条路：`load` → `restore`
 * → `initialize`。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-responses", apiKey: "x", enabled: true, models: [MODEL] };

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", subAgentDelegation: "eager" };

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", content: parts, api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now() };
}
const says = (text: string) => assistant([{ type: "text", text }]);
const calls = (name: string, args: Record<string, unknown>) => assistant([{ type: "toolCall", id: `c-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args, argumentsText: JSON.stringify(args) }], "toolUse");
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const isSub = (context: LlmContext) => !context.tools.some((tool) => tool.name === "task");

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("a sub-agent running when the app quit is back on the roster after reopening, and 继续 resumes that one with what it had read", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-sub-restart-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	await writeFile(join(root, "a.ts"), "export const LOGIN_ENTRY = 42;\n");
	const sessions = join(root, "sessions");

	// 第一个进程：派一个子代理，它读完 a.ts，卡在下一次请求上——这时应用退出。
	let hung = false;
	const before = new SessionStore(sessions);
	const first = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: before,
		emit: () => {},
		streamFn: async (context) => {
			if (isSub(context)) {
				if (!context.messages.some((message) => message.role === "toolResult")) return calls("read", { path: "a.ts" });
				hung = true;
				return new Promise<AssistantMessage>(() => {});
			}
			if (!context.messages.some((message) => message.role === "toolResult")) return calls("task", { description: "梳理登录入口", prompt: "读 a.ts，说出登录入口在哪", subagent_type: "general" });
			return says("不该走到这里");
		},
	});
	await first.initialize();
	void first.prompt([{ type: "text", text: "梳理一下登录入口" }]);
	await until(() => hung, "子代理读完 a.ts、卡在下一次请求上");
	const sessionId = first.meta.id;
	const subId = first.subAgents.list()[0]!.id;
	before.close();

	// 第二个进程：打开同一个会话。
	const after = new SessionStore(sessions);
	const subRequests: LlmContext[] = [];
	const mainRequests: LlmContext[] = [];
	let dispatchedAgain = 0;
	try {
		const loaded = await after.load(sessionId);
		assert.ok(loaded);
		const interrupted = loaded.messages.at(-1)!;
		assert.equal(interrupted.role, "toolResult");
		assert.match(textOf(interrupted), /Plume exited while this call was running/, "the call is still said to have been cut off by the exit");
		assert.match(textOf(interrupted), new RegExp(`resume: "${subId}"`), "and now says which sub-agent to resume");
		assert.equal((interrupted as { details?: { subAgentId?: string } }).details?.subAgentId, subId);

		const second = new AgentSession({
			cwd: root,
			settings: SETTINGS,
			store: after,
			meta: loaded.meta,
			emit: () => {},
			streamFn: async (context) => {
				if (isSub(context)) {
					subRequests.push({ ...context, messages: [...context.messages] });
					return says("SUB-DONE 登录入口是 a.ts 里的 LOGIN_ENTRY。");
				}
				mainRequests.push(context);
				const results = context.messages.filter((message) => message.role === "toolResult").map(textOf);
				if (results.some((text) => text.includes("SUB-DONE"))) return says("MAIN-DONE");
				const id = results.join("\n").match(/resume: "([^"]+)"/)?.[1];
				if (id) return calls("task", { description: "接着梳理", prompt: "接着说出登录入口", resume: id });
				dispatchedAgain += 1;
				return calls("task", { description: "梳理登录入口", prompt: "读 a.ts，说出登录入口在哪", subagent_type: "general" });
			},
		});
		second.restore(loaded.messages, loaded.compaction, loaded.compactions);
		await second.initialize();

		const [row] = second.subAgents.list();
		assert.equal(second.subAgents.list().length, 1);
		assert.deepEqual({ id: row!.id, status: row!.status, resumable: row!.resumable }, { id: subId, status: "aborted", resumable: true }, "stopped by the exit, and resumable");

		await second.prompt([{ type: "text", text: "继续" }]);

		assert.equal(dispatchedAgain, 0, "the main session resumed rather than dispatching the same work again");
		assert.equal(second.subAgents.list().length, 1, "still one row");
		assert.equal(second.subAgents.list()[0]!.status, "done");
		assert.equal(subRequests.length, 1);
		const resumed = subRequests[0]!.messages;
		assert.match(textOf(resumed[0]!), /读 a\.ts/, "its history opens on what it was first asked");
		assert.ok(resumed.some((message) => message.role === "toolResult" && textOf(message).includes("LOGIN_ENTRY")), "what it read before the exit is still in its context");
		assert.match(textOf(resumed.at(-1)!), /接着说出登录入口/, "and ends on what it was told to do next");
		assert.equal(textOf(second.messages.at(-1)!), "MAIN-DONE");

		// 人把它从名单上拿掉之后再重开：不再回来。
		assert.equal(await second.dismissSubAgent(subId), "removed");
		second.abort();
		after.close();
		const again = new SessionStore(sessions);
		try {
			const reloaded = await again.load(sessionId);
			const third = new AgentSession({ cwd: root, settings: SETTINGS, store: again, meta: reloaded!.meta, emit: () => {}, streamFn: async () => says("不该走到这里") });
			third.restore(reloaded!.messages, reloaded!.compaction, reloaded!.compactions);
			await third.initialize();
			assert.deepEqual(third.subAgents.list(), [], "taken off by hand, it stays off after reopening");
		} finally {
			again.close();
		}
	} finally {
		after.close();
		delete process.env.PLUME_HOME;
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
