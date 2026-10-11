import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { StreamFn } from "../src/agent/run-config.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const model: ModelConfig = { id: "qa/model", modelId: "model", providerId: "qa", name: "QA", contextWindow: 128000, maxOutputTokens: 4096, supportsThinking: true, supportsImages: true, supportsTools: true };
const provider: ProviderConfig = { id: "qa", name: "QA", api: "anthropic-messages", baseUrl: "http://localhost", apiKey: "test", enabled: true, models: [model] };
const otherModel: ModelConfig = { ...model, id: "other/model", providerId: "other", contextWindow: 256_000 };
const other: ProviderConfig = { ...provider, id: "other", api: "openai-responses", models: [otherModel] };
const settings: Settings = { ...DEFAULT_SETTINGS, providers: [provider, other], defaultModelId: model.id };

function reply(content: AssistantMessage["content"] = [{ type: "text", text: "Answer" }], request?: { provider: ProviderConfig; model: ModelConfig }): AssistantMessage {
	const from = request ?? { provider, model };
	return { role: "assistant", content, api: from.provider.api, provider: from.provider.id, model: from.model.modelId, stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop", usage: emptyUsage(), timestamp: Date.now() };
}
const say = (text: string) => [{ type: "text" as const, text }];
/** Everything the request carried, as one searchable string. */
const sent = (context: LlmContext) => JSON.stringify(context.messages);
/** The `<main-session>` block attached to the question being answered. */
const latestMainContext = (context: LlmContext) => sent(context).match(/<main-session>(?:(?!<main-session>).)*$/)?.[0] ?? "";

async function fixture(t: TestContext, streamFn: StreamFn, sideStream: StreamFn = streamFn) {
	const root = await mkdtemp(join(tmpdir(), "plume-side-session-"));
	const store = new SessionStore(join(root, "sessions"));
	const main = new AgentSession({ cwd: root, store, meta: await store.create(root, model.id), settings, emit: () => {}, streamFn });
	await main.initialize();
	// 人在侧边聊天里点「允许」：审批卡片出现在它自己那里，和主会话一样。
	const side: AgentSession = new AgentSession({
		cwd: root, store, meta: await store.create(root, "", "", { parentId: main.meta.id, sideId: "default" }), settings, streamFn: sideStream, parent: main,
		emit: (event) => { if (event.type === "approval_request") queueMicrotask(() => side.resolveApproval(event.requestId, "once")); },
	});
	await side.initialize();
	t.after(async () => { await side.dispose(); await main.dispose(); await rm(root, { recursive: true, force: true }); });
	return { root, store, main, side };
}

test("第一问附上主会话到目前为止的记录，之后每问只附新增的那一段", async (t) => {
	const requests: LlmContext[] = [];
	const { main, side } = await fixture(t, async (context) => { requests.push(context); return reply(); });
	await main.log.commit({ role: "user", content: say("FIRST_MAIN_FACT"), timestamp: 1 });
	await side.prompt(say("what happened?"));
	assert.match(latestMainContext(requests.at(-1)!), /FIRST_MAIN_FACT/);

	await main.log.commit({ role: "user", content: say("SECOND_MAIN_FACT"), timestamp: 2 });
	await side.prompt(say("and now?"));
	const latest = latestMainContext(requests.at(-1)!);
	assert.match(latest, /SECOND_MAIN_FACT/);
	assert.doesNotMatch(latest, /FIRST_MAIN_FACT/, "what was already attached is not attached again");
	assert.equal(sent(requests.at(-1)!).split("FIRST_MAIN_FACT").length - 1, 1, "the earlier attachment stays in the side history once");

	await side.prompt(say("anything else?"));
	assert.match(latestMainContext(requests.at(-1)!), /Nothing new in the main chat/);
});

test("主会话撤回、同一位置换了别的消息，下一问整段重读", async (t) => {
	const requests: LlmContext[] = [];
	const { main, side } = await fixture(t, async (context) => { requests.push(context); return reply(); });
	await main.log.commit({ role: "user", content: say("OLD_MAIN_FACT"), timestamp: 1 });
	await side.prompt(say("first"));
	await main.log.truncateFrom(0);
	await main.log.commit({ role: "user", content: say("REPLACED_MAIN_FACT"), timestamp: 5 });
	await side.prompt(say("second"));
	const latest = latestMainContext(requests.at(-1)!);
	assert.match(latest, /rewound or rewritten/);
	assert.match(latest, /REPLACED_MAIN_FACT/);
});

test("侧边聊天只拿一小组工具和自己的一份提示词，不是主会话那一套", async (t) => {
	let seen: LlmContext | undefined;
	const { root, side } = await fixture(t, async (context) => { seen = context; return reply(); });
	await writeFile(join(root, "AGENTS.md"), "PROJECT_RULE_MARKER");
	await side.prompt(say("hi"));
	const names = seen!.tools?.map((tool) => tool.name).sort() ?? [];
	assert.deepEqual(names, ["bash", "bash_output", "control_main", "dispatch_task", "edit", "glob", "grep", "ls", "read", "read_main_chat", "web_fetch", "web_search", "write"]);
	const prompt = seen!.systemPrompt ?? "";
	// 只有它自己的身份，而且在最前面——它从前读到的是「You are Plume, a coding agent」，于是自称编程助手。
	assert.ok(prompt.startsWith("You are Plume's side assistant"), prompt.slice(0, 120));
	assert.doesNotMatch(prompt, /You are Plume, a coding agent/);
	assert.doesNotMatch(prompt, /PROJECT_RULE_MARKER/, "project instructions are read before editing, not carried on every question");
	assert.match(prompt, /Boundaries:/, "the boundaries hold here as everywhere");
	assert.match(prompt, /Interface blocks:/, "the panel draws them, preview or not");
	assert.doesNotMatch(prompt, /用中文/, "the side chat answers in the person's language, not a fixed one");
});

test("没定模型和思考强度的侧边聊天跟着主会话，每次提问时现取", async (t) => {
	const used: { model: string; thinking?: string }[] = [];
	const { main, side } = await fixture(t, async (_context, request) => { used.push({ model: request.model.id, thinking: request.thinking }); return reply(undefined, request); });
	await main.setThinking("high");
	await side.prompt(say("one"));
	await main.setModel(otherModel.id);
	await side.prompt(say("two"));
	await side.setModel(model.id);
	await side.prompt(say("three"));
	assert.deepEqual(used.map((entry) => entry.model), [model.id, otherModel.id, model.id]);
	assert.equal(used[0].thinking, "high");
});

test("跟着主会话的侧边聊天，上下文用量按主会话那个模型的窗口量", async (t) => {
	const { main, side } = await fixture(t, async (_context, request) => reply(undefined, request));
	await main.setModel(otherModel.id);
	assert.equal((await side.contextBreakdown())?.limit, otherModel.contextWindow);
});

test("跟着主会话换了一家模型，上一家的推理句柄不再发出去", async (t) => {
	const requests: LlmContext[] = [];
	const { main, side } = await fixture(t, async (context, request) => {
		requests.push(context);
		return reply([{ type: "thinking", thinking: "Visible reasoning", signature: "private-signature" }, { type: "text", text: "Answer" }], request);
	});
	await side.prompt(say("same provider"));
	await side.prompt(say("still same"));
	assert.match(sent(requests.at(-1)!), /private-signature/);
	await main.setModel(otherModel.id);
	await side.prompt(say("followed the switch"));
	assert.doesNotMatch(sent(requests.at(-1)!), /private-signature/);
	assert.match(sent(requests.at(-1)!), /Visible reasoning/);
});

test("侧边聊天自己改了文件，主会话下一轮开头被告知一次", async (t) => {
	const mainRequests: LlmContext[] = [];
	let sideCalls = 0;
	const { root, main, side } = await fixture(
		t,
		async (context) => { mainRequests.push(context); return reply(); },
		async () => ++sideCalls === 1
			? reply([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "notes.txt", content: "written by side" } }])
			: reply(),
	);
	await side.prompt(say("write the notes file"));
	assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "written by side");

	await main.prompt(say("carry on"));
	assert.match(sent(mainRequests.at(-1)!), /<side-chat-changes>[^]*notes\.txt/);
	await main.prompt(say("and again"));
	assert.equal(sent(mainRequests.at(-1)!).split("<side-chat-changes>").length - 1, 1, "said once, not every turn");
});

test("侧边聊天以第一句提问为标题，不请模型概括", async (t) => {
	let calls = 0;
	const { side } = await fixture(t, async () => { calls++; return reply(); });
	await side.prompt(say("为什么这里报错？\n后面是细节"));
	await side.prompt(say("second question"));
	assert.equal(side.meta.title, "为什么这里报错？");
	assert.equal(calls, 2, "one request per question, none for a title");
});

test("侧边聊天不出现在会话列表里，跟着父会话一起删除", async (t) => {
	const { store, main, side } = await fixture(t, async () => reply());
	assert.deepEqual((await store.listSessions()).map((meta) => meta.id), [main.meta.id]);
	assert.ok((await store.listSessions({ children: true })).some((meta) => meta.id === side.meta.id && meta.parentId === main.meta.id && meta.sideId === "default"));
	await store.deleteMany([main.meta.id]);
	assert.equal(await store.get(side.meta.id), null);
});
