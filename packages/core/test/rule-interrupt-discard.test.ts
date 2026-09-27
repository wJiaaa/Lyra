/**
 * 规则半路打断的回复：不落盘、不进历史，界面上画出来的那一截也收掉。
 *
 * 循环里那段注释一直说「半截输出丢弃」，而流在收尾时照样发了 `message_end`——那是提交点，
 * 会话据此把半截违规写进了日志：重开会话、续跑、下一轮请求都带着它，模型被邀请把它说完。
 *
 * 走真实适配器和一个本地服务器：规则打断发生在 `streamTurn` 的真实流里，替身 `streamFn` 那条
 * 路根本不看规则。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionStore, type SessionRecord } from "../src/session/store.ts";
import type { ModelConfig, ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "t/m", providerId: "t", modelId: "m", name: "M", contextWindow: 100_000,
	maxOutputTokens: 1024, supportsThinking: false, supportsImages: false, supportsTools: true,
};

let server: Server;
let base = "";
let requests = 0;
/** 每个请求带去的消息，看第二个请求里有没有那半截。 */
const bodies: string[] = [];

const chunk = (text: string, finish: string | null = null) =>
	`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(text)}},"finish_reason":${finish === null ? "null" : JSON.stringify(finish)}}]}\n\n`;

before(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (part) => (raw += part));
		req.on("end", () => {
			requests += 1;
			bodies.push(raw);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (requests === 1) {
				// 先说出违规的那个词，然后迟迟不说完：打断必须发生在流的中途。
				res.write(chunk("我先把这里写成 FORBIDDEN_WORD"));
				const later = setTimeout(() => res.end(chunk("，然后接着说", "stop") + "data: [DONE]\n\n"), 3000);
				res.on("close", () => clearTimeout(later));
				return;
			}
			res.end(chunk("改过的回答", "stop") + "data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("规则打断的半截回复：不进日志、不进下一个请求，界面把它收掉", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-rule-discard-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	process.env.LYRA_HOME = home;
	const rules = join(root, ".lyra", "rules");
	await mkdir(rules, { recursive: true });
	await writeFile(join(rules, "no-forbidden.md"), "---\ncondition: 'FORBIDDEN_WORD'\ninterrupt: always\n---\n不要写 FORBIDDEN_WORD。", "utf8");

	const provider: ProviderConfig = { id: "t", name: "T", baseUrl: base, api: "openai-chat-completions", apiKey: "x", enabled: true, models: [MODEL] };
	const events: AgentEvent[] = [];
	const store = new SessionStore(join(root, "sessions"));
	const session = new AgentSession({
		cwd: root,
		store,
		settings: { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: MODEL.id, autoSummarizeTitle: false } as typeof DEFAULT_SETTINGS,
		emit: async (event) => {
			events.push(event);
		},
	});
	try {
		await session.initialize();
		assert.ok(session.can.ruleMonitor.active, "前提：规则载入成了流式规则");
		await session.prompt([{ type: "text", text: "写点东西" }]);

		assert.equal(requests, 2, "打断之后重问了一次");
		assert.ok(events.some((event) => event.type === "rule_triggered"), "前提：确实是规则打断的");

		const said = (text: string) => session.messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes(text)));
		assert.equal(said("我先把这里写成"), false, "半截回复不在会话历史里");
		assert.ok(said("改过的回答"));
		// 规则的提示里会引用触发它的那个词，所以查的是半截回复自己的前半句。
		assert.ok(!bodies[1].includes("我先把这里写成"), "重问的请求里没有那半截");

		const records: SessionRecord[] = [];
		for await (const record of store.read(session.meta.projectId, session.meta.id)) records.push(record);
		assert.ok(!JSON.stringify(records.filter((record) => record.type === "message")).includes("我先把这里写成"), "磁盘上也没有");

		/*
		 * 界面那一半：半截回复开了头（message_start），就得有东西把它收掉，而且收到日志的条数——
		 * 界面的转录跟日志一条对一条，编辑重发靠下标。
		 */
		const opened = events.findIndex((event) => event.type === "message_start" && event.message.role === "assistant");
		const closedAt = events.findIndex((event, at) => at > opened && (event.type === "message_end" || event.type === "rewound"));
		const closed = events[closedAt];
		assert.equal(closed?.type, "rewound", "那一截不是被提交，而是被收掉");
		assert.equal(closed.type === "rewound" && closed.messageCount, 1, "收到只剩用户那一条");
	} finally {
		await session.dispose();
		delete process.env.LYRA_HOME;
		await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
	}
});
