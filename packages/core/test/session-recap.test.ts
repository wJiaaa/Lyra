import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { cleanRecap, recapCovers, recapSource, writeRecap } from "../src/runtime/session-recap.ts";
import { spendOf } from "../src/session/spend.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "test/model",
	providerId: "test-p",
	modelId: "model",
	name: "Model",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "test-p",
	name: "Test Provider",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

const SETTINGS = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id };

function user(text: string, timestamp: number, synthetic = false): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp, ...(synthetic ? { synthetic } : {}) };
}

function assistant(text: string, timestamp: number, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "test-p", model: "model", usage: emptyUsage(), stopReason: "stop", timestamp, ...extra };
}

function stream(reply: AssistantMessage, seen?: string[]) {
	return ((_provider: unknown, _model: unknown, context: { messages: Message[] }) => {
		const first = context.messages[0];
		if (seen && first.role === "user") seen.push(first.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
		// oxlint-disable-next-line require-yield
		return (async function* () {
			return reply;
		})();
	}) as unknown as Parameters<typeof writeRecap>[0]["stream"];
}

test("cleanRecap strips list marks and prefixes, and keeps at most three lines", () => {
	assert.equal(cleanRecap("回顾：\n- 拆了 SessionCard\n2. 补了测试\n• 剩 Windows 路径\n* 第四行"), "拆了 SessionCard\n补了测试\n剩 Windows 路径");
	assert.equal(cleanRecap("<think>想一想</think>Recap: fixed the login bug"), "fixed the login bug");
	assert.equal(cleanRecap("   \n\n"), "");
});

test("recapCovers compares the length and the last timestamp, so a rewound transcript is not covered", () => {
	const messages = [user("a", 1), assistant("b", 2)];
	assert.equal(recapCovers({ text: "x", covered: 2, coveredAt: 2, at: 0 }, messages), true);
	assert.equal(recapCovers({ text: "x", covered: 2, coveredAt: 9, at: 0 }, messages), false);
	assert.equal(recapCovers({ text: "x", covered: 1, coveredAt: 1, at: 0 }, messages), false);
	assert.equal(recapCovers(undefined, messages), false);
});

test("recapSource reads what was said, not runtime messages or tool calls", () => {
	const messages: Message[] = [
		user("把侧栏卡片拆开", 1),
		user("[系统注入]", 2, true),
		assistant("", 3, { content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/SessionCard.tsx" } }] }),
		{ role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "patched" }], isError: false, timestamp: 4 },
		assistant("拆好了，测试也补了", 5),
	];
	const source = recapSource(messages);
	assert.ok(source);
	assert.match(source.material, /用户：把侧栏卡片拆开/);
	assert.match(source.material, /助手：拆好了/);
	assert.doesNotMatch(source.material, /系统注入|patched/);
	assert.match(source.state, /改过的文件：src\/SessionCard\.tsx/);
	assert.equal(source.previous, undefined);
});

test("recapSource continues from the previous recap only while it is still a prefix", () => {
	const messages = [user("第一件事", 1), assistant("做完了", 2), user("第二件事", 3), assistant("也做完了", 4)];
	const continued = recapSource(messages, { text: "旧回顾", covered: 2, coveredAt: 2, at: 0 });
	assert.equal(continued?.previous, "旧回顾");
	assert.doesNotMatch(continued?.material ?? "", /第一件事/);
	assert.match(continued?.material ?? "", /第二件事/);

	// 撤回之后又长回来：旧回顾讲的那段对话已经不在了，从头写。
	const rewound = recapSource(messages, { text: "旧回顾", covered: 2, coveredAt: 99, at: 0 });
	assert.equal(rewound?.previous, undefined);
	assert.match(rewound?.material ?? "", /第一件事/);

	assert.equal(recapSource(messages, { text: "旧回顾", covered: 4, coveredAt: 4, at: 0 }), null);
});

test("recapSource reports the plan and a stopped last turn", () => {
	const messages: Message[] = [
		user("做三件事", 1),
		assistant("", 2, { content: [{ type: "toolCall", id: "t", name: "todo_write", arguments: {} }] }),
		{ role: "toolResult", toolCallId: "t", toolName: "todo_write", content: [], isError: false, timestamp: 3, details: { kind: "todo", todos: [{ content: "甲", status: "completed" }, { content: "乙", status: "pending" }] } },
		assistant("做到一半", 4, { stopReason: "error" }),
	];
	const source = recapSource(messages);
	assert.match(source?.state ?? "", /计划：1\/2 完成；未完成：乙/);
	assert.match(source?.state ?? "", /最后一轮出错停下/);
});

test("writeRecap returns a billed record, with text only when the reply is usable", async () => {
	const messages = [user("修登录", 10), assistant("修好了", 20)];
	const usage = { ...emptyUsage(), input: 100, output: 20 };
	const seen: string[] = [];
	const ok = await writeRecap({ messages, settings: SETTINGS, modelId: "", stream: stream(assistant("- 修好了登录", 0, { usage }), seen) });
	assert.ok("record" in ok);
	assert.equal(ok.record.text, "修好了登录");
	assert.equal(ok.record.covered, 2);
	assert.equal(ok.record.coveredAt, 20);
	assert.deepEqual(ok.record.usage, usage);
	assert.match(seen[0], /上一版回顾：\n（无）/);

	const failed = await writeRecap({ messages, settings: SETTINGS, modelId: "", stream: stream(assistant("半句", 0, { usage, stopReason: "error" })) });
	assert.ok("record" in failed);
	assert.equal(failed.record.text, undefined);
	assert.deepEqual(failed.record.usage, usage);

	assert.deepEqual(await writeRecap({ messages: [], settings: SETTINGS, modelId: "" }), { skipped: "empty" });
	assert.deepEqual(await writeRecap({ messages, settings: { ...SETTINGS, providers: [] }, modelId: "" }), { skipped: "model" });
});

test("a recap record keeps the list order, counts its cost, and an empty one keeps the old recap", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-recap-"));
	try {
		const store = new SessionStore(root);
		const meta = await store.create(process.cwd(), MODEL.id);
		const before = (await store.append(meta, { type: "message", message: user("hi", 1) }))!;
		const usage = { ...emptyUsage(), input: 50, output: 10 };
		// 隔开几毫秒，`updatedAt` 没动才说明是规则在起作用，不是同一毫秒里写的。
		await new Promise((resolve) => setTimeout(resolve, 5));
		const record = { type: "recap" as const, covered: 1, coveredAt: 1, providerId: "test-p", modelId: "model", usage };
		const written = (await store.append(meta, { ...record, text: "打了个招呼" }))!;
		assert.equal(written.updatedAt, before.updatedAt);
		assert.equal(written.recap?.text, "打了个招呼");
		assert.equal(written.usage.input, before.usage.input + 50);

		const empty = (await store.append(meta, record))!;
		assert.equal(empty.recap?.text, "打了个招呼");
		assert.equal(empty.usage.input, before.usage.input + 100);
		assert.equal((await store.get(meta.id))?.recap?.text, "打了个招呼");

		assert.deepEqual(spendOf({ ...record, text: "x" }, 5).map((entry) => entry.source), ["recap"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
