/**
 * The four ways a delegated run can stop, and what each of them hands back.
 *
 * Only one of them used to be told apart. `runTurn` reports why it stopped and `runSubAgent` never
 * read it, so a run that used up its rounds, went in circles or lost the provider mid-request was
 * filed as `done` — with an empty answer, because the fallback prose read the last message and the
 * last message of a run cut off partway is a bare tool call. What reached the parent was
 * `(the sub-agent returned no output)`; what reached the roster was a green tick. Four sub-agents,
 * half an hour each, and nothing to show for them or to say why.
 *
 * So every test here asserts two things about one ending: that the parent is told what happened,
 * and that whatever the run had worked out by then travels with it. The clean and aborted paths are
 * in here too, as the regression half — the fix must not turn an ordinary finish into a warning.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SUB_AGENT_CHECKPOINT_TURNS, runSubAgent } from "../src/runtime/sub-agent.ts";
import { SubAgentRegistry } from "../src/runtime/sub-agents.ts";
import type { AgentDefinition } from "../src/agents-builtin.ts";
import type { AgentEvent } from "../src/agent/events.ts";
import { todoTool } from "../src/tools/todo.ts";
import type { AssistantMessage, LlmContext, Message, ModelConfig, ProviderConfig, Settings, Tool } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

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

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

/** Shaped like the built-in `explore`: a declared output, so delivery means calling `yield`. */
const EXPLORE: AgentDefinition = {
	name: "explore",
	description: "只读搜索",
	systemPrompt: "read-only",
	tools: ["read"],
	source: "builtin",
	output: {
		type: "object",
		required: ["summary", "files"],
		properties: { summary: { type: "string" }, files: { type: "array", items: { type: "object" } } },
	},
};

/** 没有声明输出格式：做完了用正文回答，到检查点时交 `HANDOFF_SCHEMA` 那一份。 */
const GENERAL: AgentDefinition = { name: "general", description: "通用", systemPrompt: "general", tools: "*", source: "builtin" };

let executed = 0;
const read: Tool = {
	name: "read",
	snippet: "reads",
	description: "reads",
	parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
	summarize: () => "读了一个文件",
	async execute() {
		executed += 1;
		return { content: [{ type: "text", text: "ok" }] };
	},
};

function assistant(parts: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
		content: parts,
	};
}

const says = (text: string) => assistant([{ type: "text", text }], "stop");
/** `n` varies the arguments, so the repetition watch does not call this stuck. */
const looks = (n: number, text?: string) =>
	assistant([
		...(text ? [{ type: "text" as const, text }] : []),
		{ type: "toolCall" as const, id: `c${n}`, name: "read", arguments: { at: n }, argumentsText: `{"at":${n}}` },
	]);
/** Same arguments every time, which is what the repetition watch is looking for. */
const stuck = (n: number) =>
	assistant([{ type: "toolCall", id: `c${n}`, name: "read", arguments: {}, argumentsText: "{}" }]);
const yields = (n: number, value: Record<string, unknown>) =>
	assistant([{ type: "toolCall", id: `y${n}`, name: "yield", arguments: value, argumentsText: JSON.stringify(value) }]);

function broke(message = "HTTP 502 上游服务端故障"): AssistantMessage {
	return { ...assistant([], "error"), errorMessage: message, errorRetryable: true };
}

const textOf = (message: Message | undefined) =>
	message && "content" in message && Array.isArray(message.content) ? message.content.map((part) => ("text" in part ? part.text : "")).join("") : "";

/**
 * 讨交接的那一轮：以「到检查点了」那句话结尾。
 *
 * 不能再按「工具表里只剩 `yield`」来认——工具表现在一个字都不变，那正是要守的东西。
 */
const pressed = (context: LlmContext) => /到检查点了/.test(textOf(context.messages.at(-1)));

async function dispatch(options: {
	/** `pressed`：这一轮是不是讨要交付的那一轮。 */
	reply: (turn: number, pressed: boolean, context: LlmContext) => AssistantMessage;
	signal?: AbortSignal;
	onTurn?: (turn: number, registry: SubAgentRegistry, id: string) => void;
	agentType?: string;
	tools?: Tool[];
}) {
	const registry = new SubAgentRegistry();
	const events: AgentEvent[] = [];
	const requests: LlmContext[] = [];
	let turn = 0;
	executed = 0;

	const answer = await runSubAgent(
		{
			sessionId: "s1",
			cwd: "/tmp",
			settings: { thinking: "off" } as unknown as Settings,
			tools: options.tools ?? [read],
			skills: [],
			agents: [EXPLORE, GENERAL],
			signal: options.signal,
			registry,
			requestApproval: async () => "allow",
			emit: async (event) => {
				events.push(event);
			},
			streamFn: async (context) => {
				// 拍下这一刻：`messages` 跟循环里的历史可能是同一个数组，之后还会往上接。
				requests.push({ ...context, messages: [...context.messages], tools: [...context.tools] });
				options.onTurn?.(turn, registry, registry.list()[0]?.id ?? "");
				return options.reply(turn++, pressed(context), context);
			},
		},
		{ description: "分析后端基础与认证", prompt: "去分析", agentType: options.agentType ?? "explore" },
		PROVIDER,
		MODEL,
	);

	const done = events.find((event) => event.type === "subagent_done");
	return { answer, registry, record: registry.list()[0], done, turns: turn, requests };
}

test("a clean finish is unchanged: the report, and nothing said about it", async () => {
	// The regression half. Every warning below is only worth having if this one stays quiet.
	const { answer, record, done } = await dispatch({ reply: () => says("在 auth.ts:42") });

	assert.equal(answer.text, "在 auth.ts:42");
	assert.equal(record.status, "done");
	assert.equal(record.error, undefined);
	assert.ok(!answer.text.includes("⚠"), "a run that finished has nothing to warn about");
	assert.equal(record.incomplete, undefined, "and nothing for the pane to mark either");
	assert.equal(done?.type === "subagent_done" ? done.status : null, "done");
});

test("running out of rounds is asked once more for a delivery, and that delivery is the answer", async () => {
	/*
	 * The one that produced the report. Four of these ran for half an hour each, hit the cap, and
	 * came back as an empty string filed under `done` — with everything they had found still in
	 * their heads and one `yield` call away.
	 *
	 * So the cap is not the end any more: only `yield` will run, and it is told to hand over what it
	 * has. Which is exactly what the fixture does when it is pressed.
	 */
	const { answer, record, turns } = await dispatch({
		reply: (turn, pressedNow) =>
			pressedNow
				? yields(turn, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] })
				: looks(turn, `第 ${turn + 1} 轮：在看 auth.ts`),
	});

	assert.ok(turns > SUB_AGENT_CHECKPOINT_TURNS, `the checkpoint was reached and one more round was spent asking (${turns})`);
	assert.ok(answer.text.includes("登录在 auth.ts:42"), `the delivery came back: ${answer.text}`);
	assert.deepEqual(answer.output, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] }, "as an object too");
	assert.ok(answer.text.includes("阶段性交接"), "and it is labelled as a handoff it was pressed for, not a finished piece of work");
	assert.ok(answer.text.includes("可以接着跑"), "and the parent is told the sub-agent is still there to continue");
	assert.ok(!answer.text.includes("拆小"), `the old advice sent the parent into redispatching from zero: ${answer.text}`);
	assert.equal(record.status, "done");
	assert.equal(record.answer, answer.text, "the pane and the parent are told the same thing");
	assert.equal(record.incomplete, true, "pressed for it, so the pane says so — the leading ⚠ is stripped before it reaches the screen");
});

/** 一次请求里模型看得见的工具定义，原样序列化：名字、描述、参数，一个字节都算。 */
const toolBytes = (context: LlmContext) => JSON.stringify(context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));

for (const agentType of ["general", "explore"]) {
	test(`讨交接那一轮的工具表跟前面干活的请求逐字节相同（${agentType}）`, async () => {
		/*
		 * 工具定义排在请求最前面，换一个字前缀缓存就从第 0 字节起作废。从前这一轮只放一个 `yield`：
		 * 审计在真实会话上量到一次请求三十五万 token 整段未命中（「本地工具定义变了（28075→560 字符）」）。
		 * `general` 是更要紧的那一个——它正常轮里从前根本没有 `yield`，追加也一样断。
		 */
		const { requests, answer } = await dispatch({
			agentType,
			reply: (turn, pressedNow) =>
				pressedNow ? yields(turn, { summary: "登录在 auth.ts:42", remaining: "刷新没看", files: [] }) : looks(turn, "看着"),
		});

		const salvage = requests.at(-1)!;
		assert.ok(pressed(salvage), "最后一次请求是讨交接的那一次");
		const lastWorking = requests.at(-2)!;
		assert.ok(!pressed(lastWorking));
		assert.equal(toolBytes(salvage), toolBytes(lastWorking), "工具表和它前一次干活的请求逐字节相同");
		assert.equal(toolBytes(requests[0]!), toolBytes(salvage), "从第一次请求起就是这一份");
		assert.ok(salvage.tools.some((tool) => tool.name === "yield") && salvage.tools.some((tool) => tool.name === "read"));
		assert.equal(salvage.systemPrompt, lastWorking.systemPrompt, "系统提示也不动");
		assert.ok(
			JSON.stringify(salvage.messages).startsWith(JSON.stringify(lastWorking.messages).slice(0, -1)),
			"消息接在上一次请求后面，只多出这一轮的内容",
		);
		assert.match(answer.text, /登录在 auth\.ts:42/);
	});
}

test("讨交接那一轮调别的工具只拿到一句拒绝，yield 照常交上去", async () => {
	/*
	 * 工具不再从桌上拿走，「它没有第二条路可走」就得由执行那一下来保证：调了 `read` 拿到的是一条
	 * 错误，告诉它只能 `yield`；`read` 本身一次都不跑，也不会先弹一张授权卡片。
	 */
	let pressedTurns = 0;
	const { answer, requests } = await dispatch({
		agentType: "general",
		reply: (turn, pressedNow, context) => {
			if (!pressedNow && !pressed({ ...context, messages: context.messages.slice(0, -2) })) return looks(turn, "看着");
			pressedTurns += 1;
			return pressedTurns === 1 ? looks(turn) : yields(turn, { summary: "入口在 auth.ts:42", remaining: "刷新没看" });
		},
	});

	const readsDuringWork = SUB_AGENT_CHECKPOINT_TURNS * 2;
	assert.equal(executed, readsDuringWork, `讨交接那一轮的 read 没有执行（干活时 ${readsDuringWork} 次，实际 ${executed} 次）`);
	const refused = requests.at(-1)!.messages.at(-1)!;
	assert.equal(refused.role, "toolResult");
	assert.equal(refused.role === "toolResult" && refused.isError, true, "拿到的是一条错误");
	assert.match(textOf(refused), /只能调用 `yield`/, "并且说清楚现在该做什么");
	assert.deepEqual(answer.output, { summary: "入口在 auth.ts:42", remaining: "刷新没看" }, "第二轮的 yield 照常落进 YIELD_KEY，成了答案");
	assert.match(answer.text, /阶段性交接/);
});

test("general 中途自己交了交接，这一段就此收工，交接就是答案", async () => {
	/*
	 * `general` 现在从派发起就带着交接那一份 `yield`（为了讨交接那一轮工具表不变）。它的描述只让它
	 * 在检查点上用，但模型真在中途调了，也得是一个说得通的结局：交上来的东西是答案、不再多发请求，
	 * 也不挂「到了检查点」的警告——它没有跑到检查点。
	 */
	const { answer, turns, record } = await dispatch({
		agentType: "general",
		reply: (turn) => (turn === 0 ? yields(0, { summary: "入口在 auth.ts:42", remaining: "刷新没看", next: "读 refresh.ts" }) : says("这一轮不该存在")),
	});

	assert.equal(turns, 1, `交了就收工，实际发了 ${turns} 次`);
	assert.ok(answer.text.startsWith("入口在 auth.ts:42"), `summary 打头：${answer.text}`);
	assert.match(answer.text, /\*\*remaining\*\*: 刷新没看/);
	assert.match(answer.text, /\*\*next\*\*: 读 refresh\.ts/);
	assert.ok(!answer.text.includes("⚠"), "没有跑到检查点，不说成被截断");
	assert.equal(record.incomplete, undefined);
});

test("讨交接那一轮不会被追问清单", async () => {
	/*
	 * 循环收尾时，清单里有「正在做」、工具表里又有 `todo_write`，就会追问一句清单。从前这一轮工具表里
	 * 只有 `yield`，那一问不会出现；现在工具表原样留着，清单就得在这一轮拿开——否则它道个歉没交，
	 * 第二轮被拿去勾一张这一轮根本勾不了的清单。
	 */
	const plan = [
		{ content: "读 auth", status: "completed" },
		{ content: "读 refresh", status: "in_progress" },
	];
	let salvageRequests = 0;
	const { answer, registry, record } = await dispatch({
		agentType: "general",
		tools: [read, todoTool as unknown as Tool],
		reply: (turn, pressedNow) => {
			if (pressedNow || salvageRequests > 0) {
				salvageRequests += 1;
				return says("抱歉，时间不够了");
			}
			return turn === 0
				? assistant([{ type: "toolCall", id: "t0", name: "todo_write", arguments: { todos: plan }, argumentsText: JSON.stringify({ todos: plan }) }])
				: looks(turn, "看着");
		},
	});

	assert.equal(salvageRequests, 1, `讨交接只发了一次请求，实际 ${salvageRequests} 次`);
	assert.match(answer.text, /抱歉，时间不够了/);
	assert.ok(registry.detail(record.id), "它还在登记簿里");
});

test("a run that will not deliver even when pressed still says what happened", async () => {
	/*
	 * 讨要不是保证。模型可能道个歉就完了——那正是这一整条链最初的失败模式，所以要确认兜底还在：
	 * 说清楚步数用尽，并把它最后说过的话交上去。
	 */
	const { answer, record } = await dispatch({
		reply: (turn, pressedNow) => (pressedNow ? says("抱歉，时间不够了") : looks(turn, `第 ${turn + 1} 轮：在看 auth.ts`)),
	});

	assert.ok(answer.text.includes(`这一段 ${SUB_AGENT_CHECKPOINT_TURNS} 轮`), `the cause is named: ${answer.text}`);
	assert.ok(!answer.text.includes("阶段性交接"), "没交出来就不能说成交了交接");
	assert.ok(answer.text.includes("抱歉，时间不够了"), "最后说的那句仍然要交上去");
	assert.equal(record.status, "done", "it did the work, it just did not get to the end of it");
});

test("a run cut off mid-tool-call still reports the last thing it said", async () => {
	/*
	 * The bug inside the bug: the fallback read the *last* assistant message, and a run that is
	 * stopped from outside almost always ends on a tool call with no text in it.
	 */
	const { answer } = await dispatch({
		reply: (turn) => (turn === 0 ? looks(0, "读完了 auth.ts，登录在 42 行") : looks(turn)),
	});

	assert.ok(answer.text.includes("登录在 42 行"), `walked back to the newest prose: ${answer.text}`);
});

test("going in circles is reported as going in circles, not as finishing", async () => {
	const { answer, record, turns } = await dispatch({ reply: (turn) => (turn === 0 ? looks(0, "先看一眼") : stuck(turn)) });

	assert.ok(turns < SUB_AGENT_CHECKPOINT_TURNS, "the repetition watch stopped it early");
	assert.ok(answer.text.includes("反复用同样的参数"), `the cause is named: ${answer.text}`);
	assert.equal(record.incomplete, true);
	assert.ok(answer.text.includes("先看一眼"), "and what it had said is still delivered");
	assert.equal(record.status, "done");
});

test("a provider that failed is recorded as failed, with the work it had done attached", async () => {
	const { answer, record, done } = await dispatch({
		reply: (turn) => (turn === 0 ? looks(0, "读完了 auth.ts") : broke()),
	});

	assert.equal(record.status, "failed", "this one is a failure — and it is what puts 重新派发 on the pane");
	assert.match(record.error ?? "", /502/);
	assert.match(answer.text, /模型服务出错/);
	assert.match(answer.text, /502/, "the parent decides whether to retry, so it needs to see what broke");
	assert.ok(answer.text.includes("读完了 auth.ts"), "half an hour of work is not thrown away with the connection");
	assert.equal(record.incomplete, true, "failed and partial are different facts; the pane shows both");
	assert.equal(done?.type === "subagent_done" ? done.status : null, "failed");
	assert.match(done?.type === "subagent_done" ? (done.error ?? "") : "", /502/);
});

test("a yielded object that renders to nothing is not a delivery", async () => {
	/*
	 * The schema check asks whether the required fields are present and typed, not whether they
	 * were filled in — so `{ summary: "", files: [] }` is accepted, and renders to an empty string.
	 * Without the fallback that is another silent empty answer, this time from a run that did
	 * everything it was told to.
	 */
	const { answer } = await dispatch({
		reply: (turn) => (turn === 0 ? yields(0, { summary: "", files: [] }) : says("没找到能确定的东西，认证那块看不到入口")),
	});

	assert.ok(answer.text.includes("认证那块看不到入口"), `fell back to what it said: ${answer.text}`);
});

test("a real yield still wins over the prose beside it", async () => {
	// The other half of the line above: the fallback must not start overruling actual deliveries.
	const { answer } = await dispatch({
		reply: (turn) =>
			turn === 0 ? yields(0, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] }) : says("说完了"),
	});

	assert.ok(answer.text.startsWith("登录在 auth.ts:42"), `the yielded object is the answer: ${answer.text}`);
	assert.deepEqual(answer.output, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] });
});

test("交付完就收工，不会再多问一句", async () => {
	/*
	 * 这一条守的是一次真实的卡死。
	 *
	 * 从前 `yield` 交完，循环把「结果已提交。」当普通工具结果送回模型，再发一轮请求。顺利时那一轮
	 * 只换回一句没人读的「我做完了」——一整份上下文换一句废话。不顺时模型确实无话可说，服务商把它
	 * 转成一个没有内容的流，而空回答是要重试的：日志里量到过同一个请求重发 222 次、34 分钟，报告
	 * 早就躺在 `state` 里，派它来的人一直等不到。
	 *
	 * 所以断言的是请求次数，不是答案内容——答案那一半上面两条已经守着了，而这里唯一会重新坏掉的
	 * 方式，就是有人把 `terminate` 那根线又拆了。
	 */
	const { answer, turns } = await dispatch({
		reply: (turn) =>
			turn === 0
				? yields(0, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] })
				: says("这一轮不该存在"),
	});

	assert.equal(turns, 1, `交付之后不该再有请求，实际发了 ${turns} 次`);
	assert.ok(answer.text.startsWith("登录在 auth.ts:42"), `报告照常回来：${answer.text}`);
});

test("没过校验的那次不算交付，它还得接着改", async () => {
	/*
	 * 上一条的另一半：收工的信号必须跟着「收下了」走，而不是跟着「调用了 `yield`」走。
	 *
	 * 挂在后者上，一次缺字段的提交就会把整个派生结束掉——模型本来只差一次改正，结果交出去的是
	 * 一份没通过校验、也没人再让它补的东西。
	 */
	const { answer, turns } = await dispatch({
		reply: (turn) =>
			turn === 0
				? yields(0, { summary: "只写了一半" })
				: yields(turn, { summary: "登录在 auth.ts:42", files: [{ path: "auth.ts", why: "入口" }] }),
	});

	assert.equal(turns, 2, `第一次没过校验，得给它改的机会，实际发了 ${turns} 次`);
	assert.ok(answer.text.startsWith("登录在 auth.ts:42"), `改完的那份才是答案：${answer.text}`);
});

test("pressing stop is still not a failure, and still says nothing about rounds", async () => {
	const { record, answer } = await dispatch({
		reply: (turn) => looks(turn, `第 ${turn} 轮`),
		onTurn: (turn, registry, id) => {
			if (turn === 1) registry.abort(id);
		},
	});

	assert.equal(record.status, "aborted");
	assert.ok(!answer.text.includes("⚠"), "a button the user pressed is not an incident to report");
	assert.equal(record.incomplete, undefined);
});

test("按停止的那个，它说过的话留在面板上", async () => {
	/*
	 * 这里曾经是干干净净的 `{ status: "aborted" }`，什么都不带。而人按停止的时刻，往往正是它已经
	 * 说了些什么、然后卡在别处的时候——派它来的模型还能从返回值里读到那些话，只有看着界面的人
	 * 两手空空，而按下按钮的正是他。
	 */
	const { record, answer } = await dispatch({
		reply: (turn) => looks(turn, `第 ${turn} 轮：auth.ts 里没有入口`),
		onTurn: (turn, registry, id) => {
			if (turn === 1) registry.abort(id);
		},
	});

	assert.ok(answer.text.includes("没有入口"), `返回值里一直都有：${answer.text}`);
	assert.ok(record.answer?.includes("没有入口"), `面板上现在也有了：${record.answer}`);
	assert.equal(record.incomplete, undefined, "带回他的东西，别给他一条警告——理由见上一条");
});
