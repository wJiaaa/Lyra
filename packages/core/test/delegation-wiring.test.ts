/**
 * 派活的积极程度，有没有真的接到会话上。
 *
 * `delegation.test.ts` 测的是那几个函数算得对，而算得对跟接上了是两件事——这个仓库里
 * 「代码在、功能不在」出现过十几次，每一次都是一个纯函数配着它自己的绿灯，产品里没有人调用。
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
			 * 派活说明随档位变时走的是增量，开头的字节不动。
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

test("提示词里确实有一段派活倾向，而且跟着等级换", async () => {
	const h = await harness();
	try {
		assert.match(await turnAt(h, "low"), /自己做完/, "低档要劝退");
		assert.match(h.last(), /<available_subagents>/, "这一段本来就该在有 task 工具时出现");

		assert.match(await turnAt(h, "medium"), /挑着派/, "中档要挑");
		assert.doesNotMatch(h.last(), /自己做完/, "换了档就不该还留着上一档的话");

		assert.match(await turnAt(h, "high"), /可以主动派活/);
		assert.match(await turnAt(h, "ultra"), /放开编排/);
	} finally {
		await h.cleanup();
	}
});

test("提示词里说的并发数字，就是闸门真正拦人的那个", async () => {
	const h = await harness();
	try {
		// 设置里的天花板是 4。
		await turnAt(h, "high");
		assert.match(h.last(), /最多 4 个子代理同时跑/);
		assert.equal(h.width(), 4);

		await turnAt(h, "medium");
		assert.match(h.last(), /最多 2 个子代理同时跑/, "中档收一半");
		assert.equal(h.width(), 2, "说出去的和拦人的必须是同一个数");

		await turnAt(h, "low");
		assert.match(h.last(), /最多 1 个子代理同时跑/);
		assert.equal(h.width(), 1);
	} finally {
		await h.cleanup();
	}
});

test("对话中途改等级，闸门当场跟上——不用重开会话", async () => {
	const h = await harness();
	try {
		await turnAt(h, "ultra");
		assert.equal(h.width(), 4);

		await turnAt(h, "low");
		assert.equal(h.width(), 1, "闸门是会话级的，但宽度必须每轮重算");

		await turnAt(h, "xhigh");
		assert.equal(h.width(), 4, "调回去也要跟上");
	} finally {
		await h.cleanup();
	}
});

test("用户把天花板调低，等级再高也不越过", async () => {
	const h = await harness({ ...SETTINGS, maxConcurrentSubAgents: 2 });
	try {
		await turnAt(h, "ultra");
		assert.equal(h.width(), 2, "天花板是用户写下的那个数字");
		assert.match(h.last(), /最多 2 个子代理同时跑/);

		await turnAt(h, "medium");
		assert.equal(h.width(), 1, "2 的一半，向上取整还是 1");
	} finally {
		await h.cleanup();
	}
});

test("关掉思考的会话，派活也跟着收到最省", async () => {
	const h = await harness();
	try {
		await turnAt(h, "off");
		assert.equal(h.width(), 1);
		assert.match(h.last(), /派活也要跟着省着来/);
	} finally {
		await h.cleanup();
	}
});
