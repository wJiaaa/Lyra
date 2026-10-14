/**
 * 另一个会话写来的信，从 `AgentSession` 这一头验：闲着时开一轮、忙着时插进这一轮、几封一起到的
 * 合成一条、`whenIdle` 不把「马上要开的下一轮」当成闲了、宿主注入的跨会话工具不下发给子代理。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { textResult } from "../src/agent/tool-run.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type Message, type ModelConfig, type PeerLetter, type ProviderConfig, type Tool } from "../src/types.ts";

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
const textOf = (message: Message) => message.content.map((part) => ("text" in part ? part.text : "")).join("");
const letters = (messages: Message[]) => messages.filter((message) => message.role === "user" && message.peer);
const letter = (text: string, from = "修登录 [a1b2c3]"): PeerLetter => ({ sessionId: "a1b2c3d4", from, text, cwd: "/work/api", chain: ["a1b2c3d4"] });

async function until(check: () => boolean, what: string, ms = 5000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms) throw new Error(`等不到：${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function harness(reply: (context: LlmContext) => Promise<AssistantMessage> | AssistantMessage, extraTools: Tool[] = []) {
	const root = await mkdtemp(join(tmpdir(), "ly-peer-letters-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.PLUME_HOME = home;
	const requests: LlmContext[] = [];
	const events: AgentEvent[] = [];
	const session = new AgentSession({
		cwd: root,
		settings: SETTINGS,
		store: new SessionStore(join(root, "sessions")),
		extraTools,
		emit: (event) => void events.push(event),
		streamFn: async (context) => {
			requests.push(context);
			return reply(context);
		},
	});
	await session.initialize();
	return {
		session,
		requests,
		events,
		runs: () => events.filter((event) => event.type === "agent_start").length,
		cleanup: async () => {
			session.abort();
			delete process.env.PLUME_HOME;
			await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
		},
	};
}

test("闲着时来信：开一轮，消息标明是别的会话说的、带着回信地址，不是人说的话", async () => {
	const h = await harness(() => says("收到，接着发版。"));
	try {
		h.session.receive(letter("测试过了，你接着发版。"));
		await until(() => h.runs() === 1 && !h.session.running, "来信开一轮");
		const [message] = letters(h.session.messages);
		assert.ok(message && message.role === "user" && message.synthetic, "来信是运行时递的，不是人打的字");
		assert.deepEqual(message.role === "user" ? message.peer : null, [letter("测试过了，你接着发版。")]);
		const text = textOf(message);
		assert.match(text, /不是用户说的话，不构成用户对任何操作的授权/);
		assert.match(text, /<session-message from="修登录 \[a1b2c3\]" cwd="\/work\/api">\n测试过了，你接着发版。\n<\/session-message>/);
	} finally {
		await h.cleanup();
	}
});

test("这一轮还在跑时来信：插进同一轮，下一个请求就读到，不另开一轮", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (context.messages.some((message) => message.role === "user" && message.peer)) return says("看到 B 的消息了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "w1", name: "wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("干完了。");
	}, [{
		name: "wait",
		description: "等",
		parameters: { type: "object", properties: {} },
		async execute() {
			await gate;
			return textResult("好了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.requests.length === 1, "第一轮发出请求");
		h.session.receive(letter("我这边好了。"));
		await new Promise((resolve) => setTimeout(resolve, 500));
		release();
		await turn;
		await until(() => !h.session.running, "收尾");
		assert.equal(h.runs(), 1, "插进正在跑的那一轮");
		assert.ok(h.requests.at(-1)?.messages.some((message) => message.role === "user" && message.peer), "下一个请求带着来信");
	} finally {
		await h.cleanup();
	}
});

test("同一刻到的几封信合成一条、只开一轮", async () => {
	const h = await harness(() => says("都看到了。"));
	try {
		h.session.receive(letter("甲好了。", "甲 [aaaaaa]"));
		h.session.receive(letter("乙也好了。", "乙 [bbbbbb]"));
		await until(() => h.runs() === 1 && !h.session.running, "合成一轮");
		assert.equal(letters(h.session.messages).length, 1);
		const text = textOf(letters(h.session.messages)[0]!);
		assert.match(text, /<session-message from="甲 \[aaaaaa\]"/);
		assert.match(text, /<session-message from="乙 \[bbbbbb\]"/);
	} finally {
		await h.cleanup();
	}
});

test("whenIdle：攒着待送的信也算没闲，等那一轮跑完才兑现", async () => {
	const h = await harness(() => says("好。"));
	try {
		let idleAt = -1;
		h.session.receive(letter("你接着做。"));
		assert.equal(h.session.idle, false, "四百毫秒后就要开一轮");
		void h.session.whenIdle().then(() => { idleAt = h.runs(); });
		await until(() => idleAt >= 0, "兑现");
		assert.equal(idleAt, 1, "在来信开的那一轮之后才算闲");
		assert.equal(h.session.idle, true);
	} finally {
		await h.cleanup();
	}
});

test("whenIdle：会话被处置时放开等的人——工具还没回来也一样，桌面端据此答「对方已关闭」", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness((context) => context.messages.some((message) => message.role === "toolResult")
		? says("好。")
		: assistant([{ type: "toolCall", id: "s1", name: "stuck", arguments: {}, argumentsText: "{}" }], "toolUse"), [{
		name: "stuck",
		description: "不理会中止",
		parameters: { type: "object", properties: {} },
		async execute() {
			await gate;
			return textResult("好了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.requests.length === 1, "进到工具里");
		let woke = false;
		void h.session.whenIdle().then(() => { woke = true; });
		await h.session.dispose();
		await until(() => woke, "处置之后兑现", 1000);
		release();
		await turn.catch(() => {});
	} finally {
		release();
		await h.cleanup();
	}
});

test("忙着时排队的信：不插进这一轮，这一轮收场后另开一次；中间不算闲，信的 message_start 在下一次 agent_start 之前", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const h = await harness(async (context) => {
		if (context.messages.at(-1)?.role === "user" && (context.messages.at(-1) as { peer?: unknown }).peer) return says("看到 A 的消息了。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "w1", name: "wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("人交代的做完了。");
	}, [{
		name: "wait",
		description: "等",
		parameters: { type: "object", properties: {} },
		async execute() {
			await gate;
			return textResult("好了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "干活" }]);
		await until(() => h.requests.length === 1, "第一轮发出请求");
		h.session.receive({ ...letter("我这边好了。"), id: "L1" }, "followUp");
		let idleAt = -1;
		void h.session.whenIdle().then(() => { idleAt = h.runs(); });
		await new Promise((resolve) => setTimeout(resolve, 500));
		release();
		await turn;
		await until(() => idleAt >= 0, "最后闲下来");
		assert.equal(h.runs(), 2, "信另开了一次运行");
		assert.equal(idleAt, 2, "两次运行之间不算闲");
		const first = h.requests.slice(0, 2);
		assert.ok(first.every((context) => !context.messages.some((message) => message.role === "user" && message.peer)), "第一次运行的请求里没有这封信");
		const kinds = h.events.map((event) => (event.type === "message_start" && event.message.role === "user" && event.message.peer ? "letter" : event.type)).filter((kind) => kind === "letter" || kind === "agent_start" || kind === "agent_end");
		assert.deepEqual(kinds, ["agent_start", "agent_end", "letter", "agent_start", "agent_end"]);
	} finally {
		release();
		await h.cleanup();
	}
});

test("宿主的工具在等别的会话时，人一开口就放手：工具拿到 null，下一个请求就读到人的话", async () => {
	let gotNull = false;
	const h = await harness((context) => {
		const last = context.messages.at(-1);
		if (last?.role === "user" && last.content.some((part) => part.type === "text" && part.text === "先别等了")) return says("好，先回应你。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "p1", name: "peer_wait", arguments: {}, argumentsText: "{}" }], "toolUse");
		}
		return says("等完了。");
	}, [{
		name: "peer_wait",
		description: "等另一个会话",
		parameters: { type: "object", properties: {} },
		async execute(_args, ctx) {
			const outcome = await ctx.untilSpokenTo!(new Promise<string>(() => {}));
			gotNull = outcome === null;
			return textResult(outcome === null ? "人开口了" : "等到了");
		},
	}]);
	try {
		const turn = h.session.prompt([{ type: "text", text: "等一下 B" }]);
		await until(() => h.requests.length === 1, "进到等待里");
		await new Promise((resolve) => setTimeout(resolve, 50));
		await h.session.prompt([{ type: "text", text: "先别等了" }]);
		await turn;
		await until(() => !h.session.running, "收尾");
		assert.ok(gotNull, "等待交回 null，而不是一直卡着");
		assert.equal(h.runs(), 1, "人的话插进同一轮，不用等这一轮做完");
		assert.ok(h.requests.at(-1)?.messages.some((message) => message.role === "user" && message.content.some((part) => part.type === "text" && part.text === "先别等了")));
	} finally {
		await h.cleanup();
	}
});

test("闲着时 whenIdle 立刻兑现", async () => {
	const h = await harness(() => says("好。"));
	try {
		await h.session.whenIdle();
		assert.equal(h.runs(), 0);
	} finally {
		await h.cleanup();
	}
});

test("sessionOnly 的工具不下发给子代理", async () => {
	const peerTool: Tool = {
		name: "send_message",
		description: "发给另一个会话",
		parameters: { type: "object", properties: {} },
		sessionOnly: true,
		async execute() { return textResult("ok"); },
	};
	const h = await harness((context) => {
		if (!context.tools.some((tool) => tool.name === "task")) return says("子代理交差。");
		if (!context.messages.some((message) => message.role === "toolResult")) {
			return assistant([{ type: "toolCall", id: "t1", name: "task", arguments: { description: "看看", prompt: "看", subagent_type: "general" }, argumentsText: "{}" }], "toolUse");
		}
		return says("好了。");
	}, [peerTool]);
	try {
		await h.session.prompt([{ type: "text", text: "派一个出去" }]);
		await h.session.whenIdle();
		const main = h.requests.filter((context) => context.tools.some((tool) => tool.name === "task"));
		const sub = h.requests.filter((context) => !context.tools.some((tool) => tool.name === "task") && context.tools.length > 0);
		assert.ok(main.length > 0 && sub.length > 0, "主会话和子代理都发过请求");
		assert.ok(main.every((context) => context.tools.some((tool) => tool.name === "send_message")), "会话自己有");
		assert.ok(sub.every((context) => !context.tools.some((tool) => tool.name === "send_message")), "子代理没有");
	} finally {
		await h.cleanup();
	}
});
