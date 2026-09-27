/**
 * 子代理的并发上限，有没有真的接到会话上。
 *
 * 算得对跟接上了是两件事——这个仓库里「代码在、功能不在」出现过十几次，每一次都是一个纯函数
 * 配着它自己的绿灯，产品里没有人调用。
 *
 * 所以这里从 `AgentSession` 这一头问：起一个真会话，跑一轮，把送到模型面前的那份 system prompt
 * 原样接下来，看里面写着什么；再把会话自己那道闸门掏出来，看它有多宽。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { DispatchGate } from "../src/runtime/dispatch-guard.ts";
import { SessionStore } from "../src/session/store.ts";
import { currentSections } from "../src/prompt/update.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig, type ThinkingLevel } from "../src/types.ts";

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

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

const SETTINGS: Settings = {
	...DEFAULT_SETTINGS,
	providers: [PROVIDER],
	defaultModelId: MODEL.id,
	mcpServers: [],
	permissionMode: "full",
	maxConcurrentSubAgents: 4,
};

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "fake",
		model: "gpt-6-astra",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function harness(settings: Settings = SETTINGS) {
	const root = await mkdtemp(join(tmpdir(), "ly-deleg-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.LYRA_HOME = home;

	const prompts: string[] = [];
	const session = new AgentSession({
		cwd: root,
		settings,
		store: new SessionStore(join(root, "sessions")),
		emit: () => {},
		streamFn: async (context) => {
			/*
			 * 模型此刻读到的各段：会话内冻结的开头，叠上历史里接在末尾的增量（`prompt/update.ts`）。
			 * 并发上限随设置变时走的是增量，开头的字节不动。
			 */
			const frozen = await session.log.frozenPrompt();
			prompts.push(frozen?.systemPrompt === context.systemPrompt ? [...currentSections(frozen, context.messages).values()].join("") : context.systemPrompt);
			return reply();
		},
	});
	await session.initialize();

	return {
		session,
		/** 最后一轮送出去的那份 system prompt。 */
		last: () => prompts[prompts.length - 1] ?? "",
		/** 会话自己那道闸门现在有多宽。 */
		width: () => {
			const gate = (session as unknown as { can: { state: Map<string, unknown> } }).can.state.get("dispatchGate");
			return gate instanceof DispatchGate ? gate.width : null;
		},
		cleanup: async () => {
			delete process.env.LYRA_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

async function turnAt(h: Awaited<ReturnType<typeof harness>>, level: ThinkingLevel) {
	await h.session.setThinking(level);
	await h.session.prompt([{ type: "text", text: "hi" }]);
	return h.last();
}

test("提示词里列出子代理，说出的并发数字就是闸门真正拦人的那个", async () => {
	const h = await harness();
	try {
		await turnAt(h, "high");
		assert.match(h.last(), /<available_subagents>/, "有 task 工具时要列出名单");
		assert.match(h.last(), /最多 4 个子代理同时跑/);
		assert.equal(h.width(), 4);
	} finally {
		await h.cleanup();
	}
});

test("推理等级不再影响派活：提示词和闸门宽度都不跟着变", async () => {
	const h = await harness();
	try {
		const high = await turnAt(h, "high");
		const low = await turnAt(h, "low");
		assert.equal(h.width(), 4);
		assert.equal(low, high, "换等级不该改动提示词里的任何一段");
		await turnAt(h, "off");
		assert.equal(h.width(), 4);
	} finally {
		await h.cleanup();
	}
});

test("会话中途改了并发上限，闸门和提示词当场跟上", async () => {
	const h = await harness();
	try {
		await turnAt(h, "high");
		assert.equal(h.width(), 4);

		h.session.updateSettings({ ...SETTINGS, maxConcurrentSubAgents: 2 });
		await turnAt(h, "high");
		assert.equal(h.width(), 2, "闸门是会话级的，但宽度必须每轮重算");
		assert.match(h.last(), /最多 2 个子代理同时跑/, "说出去的和拦人的必须是同一个数");
	} finally {
		await h.cleanup();
	}
});

test("配置里写得再大，也不越过 8", async () => {
	const h = await harness({ ...SETTINGS, maxConcurrentSubAgents: 16 });
	try {
		await turnAt(h, "high");
		assert.equal(h.width(), 8);
		assert.match(h.last(), /最多 8 个子代理同时跑/);
	} finally {
		await h.cleanup();
	}
});
