import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RETRY_POLICY, DEFAULT_RETRY_RULE, normalizeRetryPolicy, policyDelay, type RetryPolicy } from "../src/config/retry-policy.ts";
import { normalizeSettings } from "../src/config/settings.ts";
import { RetryBudget, fetchWithRetry, retryStream, isRetryableError } from "../src/ai/retry.ts";
import { FailureError, classifyFailure } from "../src/ai/failure.ts";
const socket = () => new Error("fetch failed");
/** 固定间隔带 ±20% 的抖动，所以比的是区间，不是相等。 */
const around = (waits: number[], expected: number[]) => {
	assert.equal(waits.length, expected.length, `等了 ${waits.length} 次`);
	waits.forEach((wait, index) => assert.ok(Math.abs(wait - expected[index]) <= expected[index] * 0.2, `第 ${index + 1} 次等了 ${wait}，应在 ${expected[index]} ±20%`));
};

test("normalizeSettings clamps concurrent sub-agents to 1–8", () => {
	assert.equal(normalizeSettings({ maxConcurrentSubAgents: -12 }).maxConcurrentSubAgents, 4);
	assert.equal(normalizeSettings({ maxConcurrentSubAgents: 16 }).maxConcurrentSubAgents, 8);
	assert.equal(normalizeSettings({ maxConcurrentSubAgents: 3 }).maxConcurrentSubAgents, 3);
});

test("defaults mean ten retries after the first request, about five seconds each", async () => {
	assert.deepEqual(normalizeSettings({}).retryPolicy, DEFAULT_RETRY_POLICY);
	let calls = 0; const waits: number[] = [];
	await assert.rejects(fetchWithRetry(async () => { calls++; return new Response("busy", { status: 503 }); }, "https://example.test", {}, { budget: new RetryBudget(), sleep: async ms => { waits.push(ms); } }));
	assert.equal(calls, 11); around(waits, Array(10).fill(5000));
});

test("断网默认也有上限：十次，5 秒起递增到 30 秒，一共约四分钟后报错，而不是一直挂着", async () => {
	// 曾经默认无限：一次连不上中转的运行重发了 646 次、挂了 54 分钟，直到人按停。
	assert.equal(new RetryBudget().policy.network.retries, 10);
	let calls = 0; const waits: number[] = [];
	await assert.rejects(fetchWithRetry(async () => { calls++; throw socket(); }, "https://example.test", {}, { budget: new RetryBudget(), sleep: async ms => { waits.push(ms); } }), /fetch failed/);
	assert.equal(calls, 11);
	assert.deepEqual(waits, [5000, 10000, 15000, 20000, 25000, 30000, 30000, 30000, 30000, 30000]);
	// 设置里没写间隔方式的，用这一类自己的默认，不落回固定间隔。
	assert.equal(normalizeRetryPolicy({ network: { retries: 3 } }).network.strategy, "linear");
});

test("linear delays reach the configured ceiling; the server's wait is honoured but never shortens the policy", async () => {
	const policy = { ...DEFAULT_RETRY_RULE, strategy: "linear" as const };
	assert.deepEqual([1, 2, 3, 6, 100].map(n => policyDelay(policy, n)), [5000, 10000, 15000, 30000, 30000]);
	const budget = () => new RetryBudget({ ...DEFAULT_RETRY_POLICY, upstream: { ...DEFAULT_RETRY_RULE, retries: 2 } });
	/*
	 * 预算用尽之后抛出来，而不是把那个 503 交回去——见 `fetchWithRetry` 的说明。
	 *
	 * 服务器说等 60 秒，就等 60 秒：从前配了策略就无视它，默认预算在服务器明说「一分钟内别来」的
	 * 时候几十秒内撞光。取大值、服务器那一侧封顶五分钟，见 `withServerDelay`。
	 */
	let waits: number[] = []; let calls = 0;
	await assert.rejects(fetchWithRetry(async () => { calls++; return new Response("busy", { status: 503, headers: { "retry-after": "60" } }); }, "https://example.test", {}, { budget: budget(), sleep: async ms => { waits.push(ms); } }));
	assert.equal(calls, 3); assert.deepEqual(waits, [60_000, 60_000]);

	// 服务器要的比用户配的短：用户配的是下限，照旧 5 秒上下。
	waits = [];
	await assert.rejects(fetchWithRetry(async () => new Response("busy", { status: 429, headers: { "retry-after": "2" } }), "https://example.test", {}, { budget: budget(), sleep: async ms => { waits.push(ms); } }));
	around(waits, [5000, 5000]);

	// 要求等十分钟的中转封顶五分钟；只写在正文里的 `reset_seconds` 也认。
	waits = [];
	await assert.rejects(fetchWithRetry(async () => new Response(JSON.stringify({ error: { reset_seconds: 600 } }), { status: 503 }), "https://example.test", {}, { budget: budget(), sleep: async ms => { waits.push(ms); } }));
	assert.deepEqual(waits, [300_000, 300_000]);

	// 服务器说了等多久、又说「别重试」（`x-should-retry: false`）：那个时间不作数，按自己的间隔、自己的判断。
	waits = []; calls = 0;
	await assert.rejects(fetchWithRetry(async () => { calls++; return new Response("busy", { status: 429, headers: { "retry-after": "240", "x-should-retry": "false" } }); }, "https://example.test", {}, { budget: budget(), sleep: async ms => { waits.push(ms); } }));
	assert.equal(calls, 3); around(waits, [5000, 5000]);
});

test("a wait the server wrote into a stream error is honoured by the stream retry too", async () => {
	const waits: number[] = []; let calls = 0;
	const stream = retryStream(async function* () {
		calls++;
		yield "partial";
		if (calls === 1) throw new FailureError(classifyFailure({ from: "stream", message: "model_unavailable", raw: JSON.stringify({ error: { message: "model_unavailable", reset_seconds: 12 } }) }));
	}, { budget: new RetryBudget(DEFAULT_RETRY_POLICY), reset: () => {}, sleep: async ms => { waits.push(ms); } });
	for await (const value of stream) assert.equal(value, "partial");
	assert.equal(calls, 2); assert.deepEqual(waits, [12_000]);
});

test("HTTP and broken streams spend one shared budget without multiplying retries", async () => {
	const budget = new RetryBudget({ ...DEFAULT_RETRY_POLICY, network: { ...DEFAULT_RETRY_RULE, retries: 3 } });
	let calls = 0; const attempts: number[] = [];
	const options = { budget, sleep: async () => {}, onRetry: (info: { attempt: number }) => { attempts.push(info.attempt); } };
	const stream = retryStream(async function* () {
		await fetchWithRetry(async () => { calls++; if (calls % 2) throw socket(); return new Response("ok"); }, "https://example.test", {}, options);
		yield "partial"; throw socket();
	}, { ...options, reset: () => {} });
	await assert.rejects(async () => { for await (const value of stream) assert.equal(value, "partial"); }, /fetch failed/);
	assert.equal(calls, 4); assert.deepEqual(attempts, [1, 2, 3]);
});

test("unlimited retry remains abortable during a real wait and never starts another stream", async () => {
	const controller = new AbortController(); let calls = 0;
	const start = Date.now();
	const stream = retryStream(async function* () { calls++; yield "partial"; throw socket(); }, {
		budget: new RetryBudget(DEFAULT_RETRY_POLICY), signal: controller.signal, reset: () => {},
		onRetry: () => { setTimeout(() => controller.abort(), 10); },
	});
	await assert.rejects(async () => { for await (const value of stream) assert.equal(value, "partial"); });
	assert.equal(calls, 1); assert.ok(Date.now() - start < 1000);
});

test("固定间隔带 ±20% 的抖动：一群一起断线的客户端不会踩着同一拍回来", () => {
	assert.equal(policyDelay(DEFAULT_RETRY_RULE, 1, () => 0), 4000);
	assert.equal(policyDelay(DEFAULT_RETRY_RULE, 1, () => 0.5), 5000);
	assert.ok(policyDelay(DEFAULT_RETRY_RULE, 1, () => 0.999_999) <= 6000);
	const samples = Array.from({ length: 50 }, () => policyDelay(DEFAULT_RETRY_RULE, 1));
	assert.ok(samples.every((ms) => ms >= 4000 && ms <= 6000), "都在区间里");
	assert.ok(new Set(samples).size > 1, "而且不是每次一样");
});

test("a missing policy takes the defaults, and invalid numbers cannot create tight loops", () => {
	assert.deepEqual(normalizeRetryPolicy(undefined), DEFAULT_RETRY_POLICY);
	assert.deepEqual(normalizeRetryPolicy({ upstream: { retries: Infinity, intervalMs: -1, maxIntervalMs: NaN, strategy: "unknown" } }).upstream, { retries: 10, intervalMs: 1000, maxIntervalMs: 30000, strategy: "fixed" });
	assert.equal(normalizeRetryPolicy({ upstream: { intervalMs: 40000, maxIntervalMs: 30000 } }).upstream.maxIntervalMs, 40000);
});


/*
 * The reason the budget reads rather than copies.
 *
 * A request retrying on the unlimited network rule can sit there for hours, which is exactly when
 * someone opens the settings page — and under a snapshot their edit would have reached it after it
 * finished, i.e. never. Both halves of the rule have to move: the interval it waits next, and the
 * ceiling that decides whether there is a next one at all.
 */
test("a policy edited mid-request applies from the next retry, and tightening the limit ends it", async () => {
	let live: RetryPolicy = { ...DEFAULT_RETRY_POLICY };
	const budget = new RetryBudget(() => live);
	const waits: number[] = []; let calls = 0;
	await assert.rejects(fetchWithRetry(async () => {
		calls++;
		if (calls === 2) live = { ...live, network: { retries: 3, strategy: "fixed", intervalMs: 1000, maxIntervalMs: 30_000 } };
		throw socket();
	}, "https://example.test", {}, { budget, sleep: async ms => { waits.push(ms); } }), /fetch failed/);
	// The first wait was quoted before the edit; every one after it is the new interval, and the
	// three retries the new rule allows are counted from the start rather than from the edit.
	around(waits, [5000, 1000, 1000]); assert.equal(calls, 4);
});

test("an explicit low-level attempt count still bounds both categories, whatever the settings say", () => {
	const bounded = new RetryBudget(undefined, 3).policy;
	assert.equal(bounded.upstream.retries, 2); assert.equal(bounded.network.retries, 2);
	// A live source that has nothing to say falls back to the same bounded lifetime.
	assert.equal(new RetryBudget(() => undefined, 3).policy.network.retries, 2);
	const unlimited: RetryPolicy = { ...DEFAULT_RETRY_POLICY, network: { ...DEFAULT_RETRY_RULE, retries: null } };
	assert.equal(new RetryBudget(() => unlimited, 3).policy.network.retries, null);
});

test("fault categories keep independent limits, and certificate errors are not transient network outages", async () => {
	const policy = { network: { ...DEFAULT_RETRY_RULE, retries: 2, intervalMs: 1000 }, upstream: { ...DEFAULT_RETRY_RULE, retries: 1, intervalMs: 3000 } };
	const budget = new RetryBudget(policy); let calls = 0; const waits: number[] = [];
	// 两类交替耗着各自的额度，各用各的间隔；upstream 先见底，于是最后那个 503 带着分类结果抛出来。
	await assert.rejects(fetchWithRetry(async () => { calls++; if (calls === 1 || calls === 3) throw socket(); return new Response("busy", { status: 503 }); }, "https://example.test", {}, { budget, sleep: async ms => { waits.push(ms); } }));
	assert.equal(calls, 4); around(waits, [1000, 3000, 1000]);
	assert.equal(isRetryableError(new Error("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } })), false);
	assert.equal(isRetryableError(new Error("fetch failed", { cause: { code: "ENETUNREACH" } })), true);
});

test("空回答自己带着上限，「一直重试」也管不着它", async () => {
	/*
	 * 用户把两类都设成了「一直重试」，而子代理卡了 34 分钟：同一个请求重发了 222 次，每次拿回来的
	 * 都是同一个空回答。重发的是逐字节相同的请求体——服务端状态的波动几次之内就会变个样子，几十次
	 * 一模一样的只说明这个请求在这个端点上就是会得到空。
	 *
	 * 所以空回答自带上限（`Failure.retryLimit`），和用户的策略取更严的那个。设成无限时，就是它说了算。
	 */
	const unlimited: RetryPolicy = { network: { ...DEFAULT_RETRY_RULE, retries: null }, upstream: { ...DEFAULT_RETRY_RULE, retries: null } };
	let calls = 0; const waits: number[] = [];
	const stream = retryStream(async function* () {
		calls++;
		// 逃生阀。上限没接上时这里是真的无限转，而挂死整个文件的测试没人看得出是哪条坏了——所以
		// 越过一个不可能到达的次数就正常收流，让下面的断言红着出来。
		if (calls > 20) { yield "上限没接上"; return; }
		throw new FailureError(classifyFailure({ from: "empty", why: "no-content" }));
	}, {
		budget: new RetryBudget(unlimited), reset: () => {}, sleep: async ms => { waits.push(ms); },
	});
	await assert.rejects(async () => { for await (const value of stream) assert.fail(`不该产出任何东西：${value}`); }, /空回答/);
	assert.equal(calls, 5, "第一次，加四次重试，然后放弃");
	around(waits, Array(4).fill(5000));
});

test("空回答的上限单独记，不被前面同类的 503 重试先吃掉", async () => {
	/*
	 * 上游预算设成无限，前面先连着 503 重试了四次。从前空回答的上限和 503 共用一个计数，于是轮到
	 * 空回答时已经「用满四次」，一次都不重试——而它自己一次都还没试过。
	 */
	const unlimited: RetryPolicy = { network: { ...DEFAULT_RETRY_RULE, retries: null }, upstream: { ...DEFAULT_RETRY_RULE, retries: null } };
	let calls = 0;
	const stream = retryStream(async function* () {
		calls++;
		if (calls > 20) { yield "上限没接上"; return; }
		if (calls <= 4) throw new FailureError(classifyFailure({ from: "status", status: 503 }));
		throw new FailureError(classifyFailure({ from: "empty", why: "no-content" }));
	}, { budget: new RetryBudget(unlimited), reset: () => {}, sleep: async () => {} });
	await assert.rejects(async () => { for await (const value of stream) assert.fail(`不该产出任何东西：${value}`); }, /空回答/);
	assert.equal(calls, 4 + 5, "四次 503，然后空回答自己的一次加四次重试");
});

test("空回答自己的上限之外，用户给的总次数照旧算数", async () => {
	// 上游一共只给 5 次重试：三次 503 之后，空回答只剩两次——不会因为它单独记账就绕过总数。
	const policy: RetryPolicy = { network: { ...DEFAULT_RETRY_RULE, retries: null }, upstream: { ...DEFAULT_RETRY_RULE, retries: 5 } };
	let calls = 0;
	const stream = retryStream(async function* () {
		calls++;
		if (calls > 20) { yield "上限没接上"; return; }
		if (calls <= 3) throw new FailureError(classifyFailure({ from: "status", status: 503 }));
		throw new FailureError(classifyFailure({ from: "empty", why: "no-content" }));
	}, { budget: new RetryBudget(policy), reset: () => {}, sleep: async () => {} });
	await assert.rejects(async () => { for await (const value of stream) assert.fail(`不该产出任何东西：${value}`); });
	assert.equal(calls, 6, "首次加五次重试");
});

test("收窄的只有空回答那一种，断线照旧无限重试", async () => {
	// 上一条的对照。「一直重试」是用户明确要的——网络回来之前别放弃，那个语义一个字都不能改。
	const unlimited: RetryPolicy = { ...DEFAULT_RETRY_POLICY, network: { ...DEFAULT_RETRY_RULE, retries: null } };
	let calls = 0;
	const stream = retryStream(async function* () { calls++; if (calls < 30) throw socket(); yield "ok"; }, {
		budget: new RetryBudget(unlimited), reset: () => {}, sleep: async () => {},
	});
	const seen: string[] = [];
	for await (const value of stream) seen.push(value);
	assert.deepEqual(seen, ["ok"]);
	assert.equal(calls, 30, "远超空回答那四次，也远超默认的十次：选了「无限重试」就是无限");
});
