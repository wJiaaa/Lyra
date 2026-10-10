/**
 * `deliver: "interrupt"`——排队条上的「现在就发」：停下正在跑的那一轮，拿这句话重新开始。
 *
 * 要守的是三件事：被停掉的那条回复写到哪儿就留到哪儿、排在这句话前面；这句话打上 `interrupting`；
 * 下一次请求里模型既看得到自己的半截回复，也被告知这句话是在它工作时说的、打断了它。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgentSession } from "../src/runtime/session.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AssistantMessage, LlmContext, ModelConfig, ProviderConfig } from "../src/types.ts";

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
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full" };

const message = (text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: {},
		stopReason,
		timestamp: Date.now(),
	}) as AssistantMessage;

const STORE = (id: string) =>
	({
		create: async () => ({ id, projectId: "p", cwd: root, title: "", updatedAt: 1 }),
		listSessions: async () => [],
		messages: async () => [],
		append: async (meta: unknown) => meta,
		beginPartial: async () => {},
		appendPartial: async () => {},
		dropPartial: async () => {},
	}) as never;

let root: string;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "ly-interrupt-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
});

const words = (context: LlmContext) =>
	context.messages.map((m) => `${m.role}:${m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("|")}`);

async function until(done: () => boolean): Promise<void> {
	// 有上限：前置条件不成立时该失败，而不是挂到测试超时。
	for (let waited = 0; !done() && waited < 400; waited += 1) await new Promise((r) => setTimeout(r, 5));
	assert.ok(done(), "等的事没有发生");
}

test("打断正在写的回复：半截留在前面，新的一句接在后面重新开始，模型知道自己被打断了", async () => {
	const requests: LlmContext[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: STORE("s1"),
		emit: async () => {},
		streamFn: async (context, request) => {
			requests.push(context);
			if (requests.length > 1) return message("好，改用测试库", "stop");
			// 第一轮一直写不完，直到被停下——和真实流一样，停下时交回已经写出来的那一截。
			await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
			return message("我先把迁移脚本跑在生产库上", "aborted");
		},
	});
	await session.initialize();

	const first = session.prompt([{ type: "text", text: "把迁移跑一遍" }]);
	await until(() => requests.length === 1);

	await session.prompt([{ type: "text", text: "别动生产库" }], { deliver: "interrupt" });
	await first;
	await until(() => !session.running);

	const log = session.log.messages;
	assert.deepEqual(
		log.map((m) => `${m.role}:${m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")}`),
		["user:把迁移跑一遍", "assistant:我先把迁移脚本跑在生产库上", "user:别动生产库", "assistant:好，改用测试库"],
	);
	assert.equal(log[1]!.role === "assistant" && log[1]!.stopReason, "aborted");
	assert.equal(log[2]!.role === "user" && log[2]!.interrupting, true);
	assert.equal(log[2]!.role === "user" && log[2]!.steered, undefined, "它开的是新的一轮，不是插进旧的那一轮");

	// 第二次请求：半截回复原样在，打断它的那句话带着说明。
	const second = words(requests[1]!);
	assert.equal(second.at(-2), "assistant:我先把迁移脚本跑在生产库上");
	const said = second.at(-1)!;
	assert.match(said, /^user:（打断）用户在你工作时发来了这条消息/);
	assert.match(said, /\|别动生产库\|/);
	assert.match(said, /停在了半截/);
});

test("会话闲着时 interrupt 就是一句普通的话", async () => {
	const requests: LlmContext[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: STORE("s2"),
		emit: async () => {},
		streamFn: async (context) => {
			requests.push(context);
			return message("好", "stop");
		},
	});
	await session.initialize();

	await session.prompt([{ type: "text", text: "你好" }], { deliver: "interrupt" });
	await until(() => !session.running);

	const said = session.log.messages[0]!;
	assert.equal(said.role === "user" && said.interrupting, undefined, "没打断什么，就不说打断了");
	const sent = words(requests[0]!);
	assert.ok(sent.includes("user:你好"), JSON.stringify(sent));
	assert.ok(!sent.some((each) => each.includes("（打断）")), JSON.stringify(sent));
});
