/**
 * 持续目标在真会话里怎么认这一轮是怎么收尾的：服务商报错、重试中途恢复、重试用完、人按停、人插话。
 *
 * 单元夹具（`session-goal.test.ts`）直接把收尾原因递给 `afterTurn`，测不到会话有没有把真实的原因
 * 递过去——循环的 `agent_end` 不经过 `Session.emit`，从前一次也没递到，报错的那一轮被当成 done 去问裁判。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/config/settings.ts";
import { GOAL_JUDGE_SYSTEM } from "../src/runtime/goal-judge.ts";
import { AgentSession, type AgentSessionOptions } from "../src/runtime/session.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AssistantMessage, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://localhost", api: "openai-chat-completions", apiKey: "x", enabled: true, models: [MODEL] };
/** 一秒是 `normalizeRule` 允许的最小间隔。 */
const RETRY = { network: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 }, upstream: { retries: 2, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 1000 } } as const;
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, providers: [PROVIDER], defaultModelId: MODEL.id, mcpServers: [], permissionMode: "full", autoSummarizeTitle: false, retryPolicy: RETRY };
const reply = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-chat-completions", provider: "fake", model: "model", usage: { ...emptyUsage(), input: 10, output: 5 }, stopReason: "stop", timestamp: Date.now() });
const until = async (ok: () => boolean, what: string) => {
	for (let i = 0; i < 1000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(ok(), what);
};

/** 一个本地服务商：按次序答，用完了一直答最后一种。 */
type Answer = "bad-request" | "unavailable" | "speaks";
let answers: Answer[] = [];
let hits = 0;
let server: Server;
let base = "";
const SPEAKS = [
	`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"CI 已经绿了"},"finish_reason":null}]}`,
	`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
	"data: [DONE]",
].join("\n\n");

before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const answer = answers[Math.min(hits, answers.length - 1)];
			hits += 1;
			if (answer === "bad-request") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "messages: malformed input", type: "invalid_request_error" } }));
			} else if (answer === "unavailable") {
				res.writeHead(503, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "upstream overloaded" } }));
			} else {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(`${SPEAKS}\n\n`);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** 一个带目标的真会话；裁判走替身，数它被问了几次。 */
async function withSession(options: Partial<AgentSessionOptions>, verdict: string, run: (session: AgentSession, judged: () => number, events: AgentEvent[]) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ly-goal-end-"));
	const home = join(root, "home");
	await mkdir(home, { recursive: true });
	const store = new SessionStore(home);
	let judged = 0;
	const events: AgentEvent[] = [];
	const settings = options.settings ?? SETTINGS;
	try {
		const session = new AgentSession({
			cwd: root, store, meta: await store.create(root, MODEL.id), settings,
			emit: (event) => { events.push(event); },
			titleSummaryStream: (_provider, _model, context) => {
				assert.equal(context.systemPrompt, GOAL_JUDGE_SYSTEM);
				judged++;
				// oxlint-disable-next-line require-yield
				return (async function* () { return reply(verdict); })();
			},
			...options,
		});
		await run(session, () => judged, events);
		await session.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const progress = JSON.stringify({ verdict: "progress", reason: "还没绿" });
const met = JSON.stringify({ verdict: "met", reason: "绿了" });
const providerAt = (url: string): Settings => ({ ...SETTINGS, providers: [{ ...PROVIDER, baseUrl: url }] });

test("a provider's 400 ends the turn in error and pauses the goal at once, before any judge call", { timeout: 15_000 }, async () => {
	answers = ["bad-request"];
	hits = 0;
	await withSession({ settings: providerAt(base) }, progress, async (session, judged, events) => {
		await session.setGoal("CI green");
		await until(() => session.meta.goal?.status === "paused", "the goal stops");
		assert.equal(session.meta.goal?.pausedFor, "error");
		assert.equal(judged(), 0, "the judge is not asked about a turn that failed");
		assert.equal(hits, 1, "a 400 is not retried, and the goal does not start another turn");
		const end = events.find((event) => event.type === "agent_end");
		assert.equal(end?.type === "agent_end" && end.reason, "error", "the provider's refusal is the turn's ending, not a reply");
		const notice = events.findLast((event) => event.type === "notice");
		assert.equal(notice?.type === "notice" && notice.code, "goal-paused");
		assert.equal(notice?.type === "notice" && notice.params?.why, "error");
	});
});

test("a retryable failure that recovers inside the turn does not stop the goal", { timeout: 15_000 }, async () => {
	answers = ["unavailable", "speaks"];
	hits = 0;
	await withSession({ settings: providerAt(base) }, met, async (session, judged, events) => {
		await session.setGoal("CI green");
		await until(() => session.meta.goal?.status === "met", "the goal is judged and met");
		assert.equal(judged(), 1);
		assert.equal(hits, 2, "retried once, then answered");
		assert.ok(events.some((event) => event.type === "retry_settled" && event.outcome === "recovered"));
	});
});

test("retries that run out end the turn in error: the goal stops once, not once per retry", { timeout: 15_000 }, async () => {
	answers = ["unavailable"];
	hits = 0;
	await withSession({ settings: providerAt(base) }, progress, async (session, judged) => {
		await session.setGoal("CI green");
		await until(() => session.meta.goal?.status === "paused", "the goal stops");
		assert.equal(session.meta.goal?.pausedFor, "error");
		assert.equal(hits, 1 + RETRY.upstream.retries);
		assert.equal(judged(), 0);
	});
});

test("stop mid-turn pauses the goal without asking the judge; an interjection yields instead", { timeout: 10_000 }, async () => {
	let started = 0;
	let hold = true;
	const streamFn: AgentSessionOptions["streamFn"] = async (_context, options) => {
		started++;
		if (hold) await new Promise((resolve) => options.signal?.addEventListener("abort", resolve, { once: true }));
		return options.signal?.aborted ? { ...reply(""), stopReason: "aborted" } : reply("done");
	};
	await withSession({ streamFn }, met, async (session, judged) => {
		const opening = session.setGoal("CI green");
		await until(() => started === 1, "the goal turn is running");
		// 人插话打断：那一轮停下，目标不停，人的那一轮收尾时照常判。
		hold = false;
		await session.prompt([{ type: "text", text: "先看看 lint" }], { deliver: "interrupt" });
		await opening;
		await until(() => session.meta.goal?.status === "met", "judged after the interjection");
		assert.equal(judged(), 1);

		hold = true;
		const second = session.setGoal("CI green again");
		await until(() => started === 3, "the second goal turn is running");
		session.abort();
		await second;
		await session.whenIdle();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(session.meta.goal?.status, "paused");
		assert.equal(session.meta.goal?.pausedFor, "stopped");
		assert.equal(judged(), 1, "a stopped turn is not judged");
	});
});
