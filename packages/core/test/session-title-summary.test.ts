import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import type { AssistantMessage, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { cleanTitleSummary } from "../src/runtime/title-summary.ts";

const SESSION_MODEL: ModelConfig = {
	id: "test/session-model",
	providerId: "test-p",
	modelId: "session-model",
	name: "Session Model",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const OTHER_MODEL: ModelConfig = {
	id: "test/other-model",
	providerId: "test-p",
	modelId: "other-model",
	name: "Other Model",
	contextWindow: 50_000,
	maxOutputTokens: 2048,
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
	models: [SESSION_MODEL, OTHER_MODEL],
};

function reply(text = "ok"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test-p",
		model: "session-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "ly-title-summary-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const store = new SessionStore(home);
	return {
		root,
		store,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("cleanTitleSummary strips quotes, prefixes and trailing punctuation", () => {
	assert.equal(cleanTitleSummary("《重构登录逻辑》"), "重构登录逻辑");
	assert.equal(cleanTitleSummary('"Fix authentication bug"'), "Fix authentication bug");
	assert.equal(cleanTitleSummary("标题：优化数据库查询。"), "优化数据库查询");
	assert.equal(cleanTitleSummary("Title: Refactor API endpoints!"), "Refactor API endpoints");
	assert.equal(cleanTitleSummary("```\n构建脚本修复\n```"), "构建脚本修复");
});

test("short prompt (<= 12 chars) uses immediate title and does not trigger LLM summary", async () => {
	const { store, cleanup } = await harness();
	try {
		let summarizeCalls = 0;
		const meta = await store.create(process.cwd(), SESSION_MODEL.id);
		const emittedTitles: string[] = [];

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
			},
			emit: (event: AgentEvent) => {
				if (event.type === "title") emittedTitles.push(event.title);
			},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					summarizeCalls++;
					return reply("总结出的标题");
				})();
			},
			streamFn: async () => reply("好的"),
		});

		// 10 chars, <= 12
		await session.prompt([{ type: "text", text: "写一个快速排序" }]);

		assert.equal(summarizeCalls, 0, "Should not call LLM for short prompt");
		assert.equal(emittedTitles.length, 1);
		assert.equal(emittedTitles[0], "写一个快速排序");
		assert.equal(session.log.meta.title, "写一个快速排序");

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("long prompt (> 12 chars) uses immediate fallback then rewrites with summary", { timeout: 5000 }, async () => {
	const { store, cleanup } = await harness();
	try {
		let summarizeCalls = 0;
		const meta = await store.create(process.cwd(), SESSION_MODEL.id);
		const emittedTitles: string[] = [];
		const summaryApplied = Promise.withResolvers<void>();
		let resolveSummary: (value: AssistantMessage) => void;
		const summaryPromise = new Promise<AssistantMessage>((r) => {
			resolveSummary = r;
		});

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
			},
			emit: (event: AgentEvent) => {
				if (event.type === "title") emittedTitles.push(event.title);
				if (event.type === "title" && event.title === "重构用户权限验证") summaryApplied.resolve();
			},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					summarizeCalls++;
					return summaryPromise;
				})();
			},
			streamFn: async () => reply("分析完毕"),
		});

		const longText = "请帮我重构一下这个项目的用户权限验证中间件以及错误边界处理";
		await session.prompt([{ type: "text", text: longText }]);

		// Immediate fallback title should be present right away
		assert.equal(emittedTitles.length, 1);
		assert.equal(emittedTitles[0], longText.slice(0, 60));
		assert.equal(summarizeCalls, 1);

		// Now complete the async summary
		resolveSummary!(reply("重构用户权限验证"));
		await summaryApplied.promise;

		assert.equal(emittedTitles.length, 2);
		assert.equal(emittedTitles[1], "重构用户权限验证");
		assert.equal(session.log.meta.title, "重构用户权限验证");

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("the title model chosen in settings outranks the session's model", { timeout: 5000 }, async () => {
	const { store, cleanup } = await harness();
	try {
		const modelsUsed: string[] = [];
		const meta = await store.create(process.cwd(), OTHER_MODEL.id);
		const summaryApplied = Promise.withResolvers<void>();

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: OTHER_MODEL.id,
				titleModelId: SESSION_MODEL.id,
			},
			emit: (event) => { if (event.type === "title" && event.title === "指定模型总结") summaryApplied.resolve(); },
			titleSummaryStream: (_provider, model) => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					modelsUsed.push(model.id);
					return reply("指定模型总结");
				})();
			},
			streamFn: async () => reply("日常回复"),
		});

		await session.prompt([{ type: "text", text: "这是一条超过十二个字符的非常长的提示词内容" }]);
		await summaryApplied.promise;

		assert.deepEqual(modelsUsed, [SESSION_MODEL.id]);

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("does not overwrite title if user renamed session before summary completes", { timeout: 5000 }, async () => {
	const { store, cleanup } = await harness();
	try {
		const meta = await store.create(process.cwd(), SESSION_MODEL.id);
		const lateSummaryFinished = Promise.withResolvers<void>();
		let resolveSummary: (value: AssistantMessage) => void;
		const summaryPromise = new Promise<AssistantMessage>((r) => {
			resolveSummary = r;
		});

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
			},
			emit: () => {},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				const iterator = (async function* () {
					return summaryPromise;
				})();
				const next = iterator.next.bind(iterator);
				iterator.next = (...args) => next(...args).then((result) => {
					if (result.done) lateSummaryFinished.resolve();
					return result;
				});
				return iterator;
			},
			streamFn: async () => reply("好的"),
		});

		await session.prompt([{ type: "text", text: "这是一个需要总结的非常长的主人提问内容" }]);

		// User explicitly renames the session
		await session.rename("主人指定的名称");
		assert.equal(session.log.meta.title, "主人指定的名称");

		// Async summary finishes after rename
		resolveSummary!(reply("迟到的自动总结"));
		await lateSummaryFinished.promise;

		// Must not overwrite
		assert.equal(session.log.meta.title, "主人指定的名称");

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("model error degrades silently to fallback title", { timeout: 5000 }, async () => {
	const { store, cleanup } = await harness();
	try {
		const meta = await store.create(process.cwd(), SESSION_MODEL.id);
		const emittedTitles: string[] = [];
		const summaryFailed = Promise.withResolvers<void>();

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
			},
			emit: (event: AgentEvent) => {
				if (event.type === "title") emittedTitles.push(event.title);
			},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					summaryFailed.resolve();
					throw new Error("Network connection refused");
				})();
			},
			streamFn: async () => reply("正常回复"),
		});

		const text = "这是一个长句子超过十二个字符但大模型抛错的场景";
		await session.prompt([{ type: "text", text }]);
		await summaryFailed.promise;

		// Emitted only once (fallback), didn't crash
		assert.equal(emittedTitles.length, 1);
		assert.equal(emittedTitles[0], text.slice(0, 60));
		assert.equal(session.log.meta.title, text.slice(0, 60));

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("when autoSummarizeTitle is false, long prompt does not trigger summary", async () => {
	const { store, cleanup } = await harness();
	try {
		const meta = await store.create(process.cwd(), SESSION_MODEL.id);
		let summarizeCalls = 0;
		const emittedTitles: string[] = [];

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
				autoSummarizeTitle: false,
			},
			emit: (event: AgentEvent) => {
				if (event.type === "title") emittedTitles.push(event.title);
			},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					summarizeCalls++;
					return reply("不应出现的总结");
				})();
			},
			streamFn: async () => reply("正常回复"),
		});

		const text = "这是一条非常长的提问，但由于设置里关闭了智能标题总结所以不总结";
		await session.prompt([{ type: "text", text }]);

		assert.equal(summarizeCalls, 0, "Must not invoke title summary when autoSummarizeTitle is false");
		assert.equal(emittedTitles.length, 1);
		assert.equal(emittedTitles[0], text.slice(0, 60));
		assert.equal(session.log.meta.title, text.slice(0, 60));

		await session.dispose();
	} finally {
		await cleanup();
	}
});

test("session initialized via pendingPrompt (desktop new session flow) summarizes title", { timeout: 5000 }, async () => {
	const { store, cleanup } = await harness();
	try {
		const emittedTitles: string[] = [];
		const summaryApplied = Promise.withResolvers<void>();
		let summarizeCalls = 0;
		let resolveSummary: (value: AssistantMessage) => void;
		const summaryPromise = new Promise<AssistantMessage>((r) => {
			resolveSummary = r;
		});

		const text = "查看plume的mcp连接设置和管理，例如现在的sqlcl mcp在各个会话是怎么初始化管理的";
		const fallbackTitle = text.slice(0, 60);
		// Simulate desktop electron createStoredSession
		let meta = await store.create(process.cwd(), SESSION_MODEL.id, fallbackTitle);
		meta = await store.append(meta, {
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
		});
		meta = await store.append(meta, {
			type: "meta",
			meta: { ...meta, pendingPrompt: true },
		});

		const session = new AgentSession({
			cwd: process.cwd(),
			store,
			meta,
			settings: {
				...DEFAULT_SETTINGS,
				providers: [PROVIDER],
				defaultModelId: SESSION_MODEL.id,
			},
			emit: (event: AgentEvent) => {
				if (event.type === "title") emittedTitles.push(event.title);
				if (event.type === "title" && event.title === "MCP 连接设置与会话管理") summaryApplied.resolve();
			},
			titleSummaryStream: () => {
				// oxlint-disable-next-line require-yield
				return (async function* () {
					summarizeCalls++;
					return summaryPromise;
				})();
			},
			streamFn: async () => reply("正在查询 MCP 管理机制"),
		});

		const loaded = await store.load(meta.id);
		assert.ok(loaded);
		session.restore(loaded.messages);

		// Desktop runs resumePendingPrompt()
		const pendingRun = session.resumePendingPrompt();
		// Resumption must persist pendingPrompt and the fallback before starting the summary.
		await pendingRun;

		assert.equal(summarizeCalls, 1, "Should trigger summary for long pending prompt");

		// Resolve summary
		resolveSummary!(reply("MCP 连接设置与会话管理"));
		await summaryApplied.promise;

		assert.ok(emittedTitles.includes("MCP 连接设置与会话管理"));
		assert.equal(session.log.meta.title, "MCP 连接设置与会话管理");

		await session.dispose();
	} finally {
		await cleanup();
	}
});
