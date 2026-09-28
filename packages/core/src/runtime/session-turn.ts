/**
 * Assembling one turn: everything the loop needs, in the order it has to be decided.
 *
 * Build the system prompt, let plugins amend the whole turn, then write down what came out. The
 * recording happens last on purpose — what belongs in the log is what the model was actually sent,
 * not what this file would have sent if nothing had intervened.
 *
 * Separate from the session because it is a function of its inputs and nothing else: given the same
 * workspace, capabilities and history it produces the same request. That is what makes a turn
 * something you can reason about after the fact rather than only watch happen.
 */

import { PROJECT_MEMORY_ENABLED_KEY, projectMemoryEnabled } from "./project-memory.ts";
import { isAbsolute, resolve } from "node:path";
import type { AgentEvent } from "../agent/events.ts";
import type { AgentRunConfig } from "../agent/loop.ts";
import { runTurn } from "../agent/runner.ts";
import { streamAssistant } from "../ai/index.ts";
import type { Settings } from "../config/settings.ts";
import { TODOS_KEY, type TodoItem } from "../tools/todo.ts";
import { continueWhileWorkRemains } from "./continuation.ts";
import type {
	ApprovalDecision,
	ApprovalRequest,
	AssistantMessage,
	Message,
	ModelConfig,
	ProviderConfig,
	StreamEvent,
	ThinkingLevel,
} from "../types.ts";
import { droppedMessage, filesSeen, lastRequest, summaryMessages } from "./compaction.ts";
import { taskContextFromHistory } from "./task-context.ts";
import { hookContextMessage, loadHookRunner, makeAfterToolCall, makeBeforeToolCall, makeOnStop, makePermissionRequest, runSessionStartHooks, runUserPromptSubmitHooks, type TurnHooks } from "./hooks.ts";
import type { SessionCapabilities } from "./session-capabilities.ts";
import type { SessionLog } from "./session-log.ts";
import { SUBAGENTS_KEY } from "../resources/handlers.ts";
import { offerRuleFromCorrection } from "./rule-offer.ts";
import { prepareTurn } from "./turn.ts";
import { loadPromptContext, promptCapabilities } from "./prompt-context.ts";
import { reconcilePrompt, type PromptContext } from "../prompt/context.ts";
import { currentSections, diffSections, promptSections, promptUpdateMessage } from "../prompt/update.ts";
import { buildTurnConfig } from "./turn-config.ts";
import type { SubAgentRegistry } from "./sub-agents.ts";
import type { DelegationWaits } from "./delegation-waits.ts";

export interface TurnInputs {
	cwd: string;
	settings: Settings;
	/** Resolve preferences at dispatch time without altering an already running model request. */
	getSettings?: () => Settings;
	log: SessionLog;
	can: SessionCapabilities;
	provider: ProviderConfig;
	model: ModelConfig;
	signal: AbortSignal;
	/**
	 * 收尾那一段自己的叫停绳，和回合的 `signal` 分开。
	 *
	 * 回合说完之后还有一段（下面那次规则建议判断，一次网络调用，上限 20 秒），而 `Session` 要
	 * 等这一段结束才算放手——排在后面的下一轮就卡在这儿等着。人说了下一句，这个建议按它自己的
	 * 道理就已经作废了（见下面「After the work」那段），所以该有办法单独把它叫停。
	 *
	 * 不复用 `signal`：那一根上挂着这一轮派出去的每个子智能体（`sub-agent.ts` 的 `stopWithParent`），
	 * 扯它等于顺手把它们也杀了。
	 */
	settleSignal?: AbortSignal;
	thinking?: ThinkingLevel;
	streamFn?: AgentRunConfig["streamFn"];
	scratchDir: string;
	requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>;
	emit: (event: AgentEvent) => Promise<void>;
	drainSteering: () => Message[];
	/** Where sub-agents dispatched by this turn register — see `runtime/sub-agents.ts`. */
	subAgents?: SubAgentRegistry;
	/** 这一轮在等的派发，人一开口就放手——见 `delegation-waits.ts`。 */
	delegations?: DelegationWaits;
	/** 这场对话此刻设定的模型——一轮之内也会变。见 `AgentRunConfig.liveModel`。 */
	liveModel?: AgentRunConfig["liveModel"];
}

/**
 * Run one prompt to a standstill: the turn itself, then as many more as the plan still needs.
 *
 * The continuation is here rather than at the call site because it is the same turn continuing —
 * a model that stops with items still unticked has not finished, and restarting it is not a second
 * request in any sense the log or the user would recognise.
 */
export async function driveTurn(input: TurnInputs): Promise<void> {
	const { cwd, can, log } = input;
	const onEvent = (event: AgentEvent) => recordTurnEvent(input.log, event);
	const hooks: TurnHooks = {
		runner: await loadHookRunner({ settings: input.settings, cwd, emit: input.emit }),
		cwd,
		sessionId: log.meta.id,
		permissionMode: input.settings.permissionMode,
		signal: input.signal,
	};
	if (!(await runPromptHooks(input, hooks))) return;
	const { config, systemPrompt } = await assembleTurn(input, hooks);

	/*
	 * 扩展的 `turn_start` / `turn_end`。
	 *
	 * 这两个事件（连同 `tool_result`、`session_start`）在清单里认得、校验过、存下来了，
	 * **而从来没有被派发过**——扩展宿主此前只有一个调用点，就是工具调用前的那次拦截。
	 * 一个声明了 `events: ["turn_end"]` 的扩展装上去、加载成功、然后什么也收不到。
	 *
	 * `dispatch` 不是 `intercept`：这两个事件是观察，不接受 `block`。一个能否决整轮开始的
	 * 扩展，跟一个能让会话卡住的扩展是同一个东西。
	 */
	void can.extensions.dispatch("turn_start", { cwd, sessionId: log.meta.id }).catch(() => {});

	const first = await runTurn(config, onEvent);
	await continueWhileWorkRemains(first, {
		run: (messages) => runTurn({ ...config, messages, systemPrompt }, onEvent),
		// 日期块由循环在每次请求末尾接上（`environment`），续跑重建的历史里不带它。
		messages: () => modelHistory(input.log, input.provider, input.model),
		todos: () => (input.can.state.get(TODOS_KEY) as TodoItem[] | undefined) ?? [],
		aborted: () => input.signal.aborted,
		notify: (message) => input.emit({ type: "notice", level: "info", message }),
		// The running line, not a toast: this wait outlives one by an order of magnitude.
		resuming: (info) => input.emit({ type: "retry", ...info, resume: true }),
		// So that pressing stop during a minute-long wait is felt immediately.
		signal: input.signal,
		/*
		 * 无条件为真，也就是说 `continueWhileWorkRemains` 里那半段「连接断了就整轮重来」在这里
		 * 从来不会执行。这是有意的，值得写下来，因为光读那个文件会以为它在工作。
		 *
		 * 会话永远带着一份重试策略——`normalizeRetryPolicy` 在没有配置时也会给出默认值——所以请求
		 * 那一层总是受设置管着，而且现在覆盖了每一种失败（见 `failure.ts`）。再让外面这层加码，
		 * 「重试 10 次」就会变成 10 次请求重试 × 3 轮 resume 一共四十次，跟设置页上写的数字对不上。
		 * 设成无限重试时它更是永远轮不到：请求那层根本不会放弃。
		 *
		 * 那半段代码留着是因为 `continueWhileWorkRemains` 本身是通用的，`resume.test.ts` 也仍然
		 * 覆盖着它；换个不带重试预算的调用者就该打开。
		 */
		requestRetriesHandled: true,
	});

	void can.extensions.dispatch("turn_end", { cwd, sessionId: log.meta.id, messages: log.messages.length }).catch(() => {});

	/*
	 * After the work, never during it.
	 *
	 * A choice presented in the middle of an action is one people dismiss to get it out of the way,
	 * and this one is worth reading. It is also the reason this is awaited rather than left running:
	 * an offer that arrives after the next prompt has started would be about the wrong exchange.
	 *
	 * 「已经是上一次交流了」这件事，现在也是它被叫停的理由：`settleSignal` 就是那根绳，由
	 * `Session` 在下一句话进来时扯——否则那一句得干等这次判断跑完才轮得上（见 `settleSignal`）。
	 */
	await offerRuleFromCorrection({
		messages: input.log.messages,
		settings: input.settings,
		provider: input.provider,
		model: input.model,
		stream: summaryStream(input.streamFn, { sessionId: log.meta.id, cwd, retryPolicy: () => (input.getSettings?.() ?? input.settings).retryPolicy, signal: input.signal }) ?? streamAssistant,
		budget: input.can.correctionBudget,
		signal: input.settleSignal ? AbortSignal.any([input.signal, input.settleSignal]) : input.signal,
		emit: input.emit,
	});
}

/** 这个会话的 SessionStart 钩子跑过没有。存在会话的 state 里：会话活多久，它就只跑一次。 */
const SESSION_START_KEY = "hooks:sessionStartRan";

/**
 * 一轮开始前的两个钩子：会话里的第一轮先跑 SessionStart，每一轮都跑 UserPromptSubmit。
 *
 * 它们给的附加上下文作为一条模型看得见、界面不画的消息，接在人刚发的那句后面。UserPromptSubmit
 * 拦下的那句话从记录里撤掉——拦它往往就是因为它不该进上下文（里面有口令、有不该发出去的东西），
 * 留在历史里等于下一轮照样发给模型。返回 false 表示这一轮不跑了。
 */
async function runPromptHooks(input: TurnInputs, hooks: TurnHooks): Promise<boolean> {
	const { can, log } = input;
	const inject = (message: Message | null) => injectMessage(input, message);

	/*
	 * 这一轮要查的那句，在注入任何东西之前定位。
	 *
	 * SessionStart 的上下文也是一条 user 消息，注入之后再往回找，找到的就是它——钩子查了启动上下文，
	 * 人发的那句原样进了模型请求。也不能按 `synthetic` 跳过：「继续」和后台送达本身就是 synthetic，
	 * 这一轮就是它们开的，跳过去会查到更早的一句人话，拦下时还会从那里把整段历史截掉。
	 */
	let index = log.messages.length - 1;
	while (index >= 0 && log.messages[index].role !== "user") index--;

	let startedNow = false;
	if (!can.state.get(SESSION_START_KEY)) {
		can.state.set(SESSION_START_KEY, true);
		const resumed = log.messages.some((message) => message.role === "assistant");
		const started = await runSessionStartHooks(hooks, resumed ? "resume" : "startup", `${input.provider.name}/${input.model.id}`);
		const context = hookContextMessage("SessionStart", started.additionalContexts);
		await inject(context);
		startedNow = context !== null;
	}

	const prompt = index >= 0 ? log.messages[index] : null;
	if (!prompt || prompt.role !== "user") return true;
	const text = prompt.displayText || prompt.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	const attachments = prompt.attachments?.map((attachment, at) => `${at + 1}:${attachment.name}`).join("\n");
	const submitted = await runUserPromptSubmitHooks(hooks, text, attachments);
	if (submitted.preventContinuation) {
		if (await log.truncateFrom(index)) await input.emit({ type: "rewound", messageCount: log.messages.length });
		// 刚注入的 SessionStart 上下文排在这句后面，跟着一起截掉了；不重置，这个会话就再也拿不到它。
		if (startedNow) can.state.delete(SESSION_START_KEY);
		await input.emit({ type: "notice", level: "warn", message: `UserPromptSubmit 钩子拦下了这条消息：${submitted.stopReason ?? "未说明原因"}` });
		await input.emit({ type: "agent_end", reason: "done" });
		return false;
	}
	await inject(hookContextMessage("UserPromptSubmit", submitted.additionalContexts));
	return true;
}

/**
 * 一条运行时写给模型的消息：进日志，也照常发给界面。
 *
 * 界面的转录和日志一条对一条（编辑重发按下标截断），所以不画的消息也要走 `message_start/end`，
 * 由界面按 `synthetic` 不画。
 */
async function injectMessage(input: TurnInputs, message: Message | null): Promise<void> {
	if (!message) return;
	await input.log.commit(message);
	await input.emit({ type: "message_start", message });
	await input.emit({ type: "message_end", message });
}

/**
 * Every event on its way out of the loop, with the two things that must happen as it passes.
 *
 * `message_end` is the commit point: partial assistant messages are never persisted, so this is
 * the only place a reply enters the transcript.
 *
 * And a turn stopped for going in circles has to say so. Ending silently is indistinguishable from
 * finishing, and the difference matters: one means the work is done, the other means it is stuck
 * and waiting for a person to say something it has not thought of.
 */
async function recordTurnEvent(log: SessionLog, event: AgentEvent): Promise<void> {
	if (event.type === "agent_end" && event.reason === "stalled") {
		await log.emit({
			type: "notice",
			level: "warn",
			message: "同一个调用反复得到相同结果，已停下。告诉它换个方向，或直接说明你想怎么处理。",
		});
	}
	if (event.type === "message_end") await log.commit(event.message);
	/*
	 * 规则打断的半截回复：没提交，界面上画出来的那一截也要收掉。
	 *
	 * 说成 `rewound` 而不是原样转发：界面早就认得它（按条数截断），而它的转录跟日志一条对一条——
	 * 留着那一截，后面每一条的下标都错一位，编辑重发就会截在错的地方。
	 */
	if (event.type === "message_discarded") return log.emit({ type: "rewound", messageCount: log.messages.length });
	await log.emit(event);
}

/**
 * The history as the model should see it: everything, or the summary and what followed it.
 *
 * The log keeps every message and the boundary says where the model's view starts. Rebuilding the
 * synthetic head from the stored summary on each turn — rather than storing the head itself —
 * keeps one copy of what a summary message looks like, and lets the quoted standing request be
 * recomputed from the messages it was drawn from instead of going stale beside them.
 */
export function modelHistory(log: SessionLog, provider: ProviderConfig, model: ModelConfig): Message[] {
	const boundary = log.compaction;
	if (!boundary) return log.messages;

	const older = log.messages.slice(0, boundary.keptFrom);
	const tail = log.messages.slice(boundary.keptFrom);
	// 头部带固定的边界时间：计量据此只丢边界之前的用量（`measureTotal`），重建时取当前时间会把之后的新用量也丢掉。
	const at = boundary.at ?? Math.max(0, ...tail.map((message) => message.timestamp));
	if (!boundary.summary) {
		const standing = lastRequest(older) ?? lastRequest(log.messages);
		return [{ ...droppedMessage(standing, taskContextFromHistory(older), model), timestamp: at }, ...tail];
	}

	const head = summaryMessages(boundary.summary, lastRequest(older), provider, model, filesSeen(older), taskContextFromHistory(older));
	return [...head.map((message) => ({ ...message, timestamp: at })), ...tail];
}

/**
 * 用户拖进来的、工作区之外的文件——这一轮可以读它们。
 *
 * 只喂给读的那一侧（`read`、`ls`）。写和改不吃这份集合，理由写在 `tools/write.ts` 里：拖一个文件
 * 进来的意思是让模型看它，不是把它交出去。
 *
 * **只认绝对路径**。`MessageAttachment.path` 的类型注释写得很清楚，它是发送时记下的展示用元数据
 * （「Not a promise that the file is still there」），从来不是按权限凭证设计的——而它现在是一个了。
 * 相对路径在这里没有意义：它会被 `resolve()` 按**当前进程**的工作目录补全，而那跟会话的 `cwd` 不是
 * 一回事，补出来的东西谁也没打算授权。宁可少认一条，也不要凭一段没人校验过的字符串放行。
 */
function collectAllowedPaths(messages: readonly Message[]): Set<string> | undefined {
	let paths: Set<string> | undefined;
	for (const message of messages) {
		if (message.role !== "user" || !message.attachments) continue;
		for (const attachment of message.attachments) {
			if (typeof attachment.path !== "string" || !attachment.path) continue;
			if (!isAbsolute(attachment.path)) continue;
			paths ??= new Set<string>();
			paths.add(resolve(attachment.path));
		}
	}
	return paths;
}

async function assembleTurn(input: TurnInputs, hooks: TurnHooks): Promise<{ config: AgentRunConfig; systemPrompt: string }> {
	const { cwd, can, log, settings } = input;
	const memoryEnabled = projectMemoryEnabled(settings);
	can.state.set(PROJECT_MEMORY_ENABLED_KEY, memoryEnabled);

	const { tools, dispatchLimits } = promptCapabilities({ settings, tools: can.tools });

	/*
	 * Where `agent://` finds the sub-agents this session dispatched.
	 *
	 * Put in the state map rather than handed to the router, because the router is built once per
	 * session while the registry arrives per turn — and a session with no registry (the CLI, a
	 * test) should leave `agent://` resolving to "this session has no sub-agents" rather than to
	 * a stale one.
	 */
	if (input.subAgents) can.state.set(SUBAGENTS_KEY, input.subAgents);

	const prompt = await settlePrompt(input, await loadPromptContext({
		cwd, settings, tools, skills: can.skills, agents: can.agents,
		modelName: input.model.name, scratchDir: input.scratchDir,
		rules: can.rules, resources: can.resources.schemes(),
		dispatchLimits,
	}));
	const turn = await prepareTurn({
		cwd, tools, systemPrompt: prompt.systemPrompt,
		messages: modelHistory(log, input.provider, input.model),
	});
	const assembled = reconcilePrompt(prompt, turn.systemPrompt);

	const systemPrompt = await log.recordContext(
		turn.systemPrompt,
		turn.tools.map((tool) => tool.name),
		can.skills.map((skill) => skill.name),
		turn.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
		{ sections: assembled.sections, mcpTools: can.mcp.allTools().map(tool => tool.name) },
	);

	const config = buildTurnConfig(
		{
			sessionId: log.meta.id,
			cwd,
			provider: input.provider,
			model: input.model,
			settings,
			getSettings: input.getSettings,
			state: can.state,
			tools,
			skills: can.skills,
			agents: can.agents,
			ruleMonitor: can.ruleMonitor,
			resources: can.resources,
			scratchDir: input.scratchDir,
			allowedPaths: collectAllowedPaths(log.messages),
			// Where anything this turn delegates registers itself, so it can be watched and steered.
			subAgents: input.subAgents,
			delegations: input.delegations,
			liveModel: input.liveModel,
			signal: input.signal,
			streamFn: input.streamFn,
			requestApproval: input.requestApproval,
			emit: input.emit,
			summaryStream: summaryStream(input.streamFn, { sessionId: log.meta.id, cwd, retryPolicy: () => (input.getSettings?.() ?? input.settings).retryPolicy, signal: input.signal }),
			// 压缩剪掉的大块输出存进会话，占位标记里给出 `artifact://` 地址。
			artifacts: { keep: (tool, content) => can.keepArtifact(tool, content) },
			beforeToolCall: makeBeforeToolCall(hooks, can.extensions),
			afterToolCall: makeAfterToolCall(hooks, can.extensions),
			permissionRequest: makePermissionRequest(hooks),
			onStop: makeOnStop(hooks),
			drainSteering: input.drainSteering,
		},
		turn,
		systemPrompt,
		input.thinking,
	);

	config.onContext = (context, model) => log.captureRequest(context, model);
	config.environment = true;
	return { config, systemPrompt };
}

/**
 * 这一轮发哪份 system prompt：会话里冻结的那份，不是刚才按磁盘现状生成的 `fresh`。
 *
 * 两份在段落上有出入时——项目指令改了、并发上限改了、换了模型——把改动作为
 * 一条增量接在历史末尾并写进日志，开头不动。比的是模型此刻看到的各段（冻结那份叠上历史里已发
 * 过的增量），所以同一处改动只发一次。增量里的并发数和闸门的宽度读的是同一个设置，说的数和拦的
 * 数一致。见 `prompt/update.ts`。
 */
async function settlePrompt(input: TurnInputs, fresh: PromptContext): Promise<PromptContext> {
	const { log } = input;
	const frozen = await log.frozenPrompt();
	if (!frozen) {
		log.freezePrompt(fresh);
		return fresh;
	}
	const seen = currentSections(frozen, modelHistory(log, input.provider, input.model));
	await injectMessage(input, promptUpdateMessage(diffSections(seen, promptSections(fresh))));
	return frozen;
}

/**
 * The provider call compaction should make, in the shape it expects.
 *
 * The session's override answers a whole turn; compaction wants a stream. Adapting rather than
 * reaching for the real provider is the point: a host that replaced how requests are made — a test,
 * a recorded session, a gateway — must have replaced this one too. Undefined when nothing was
 * overridden, which leaves the real provider in place.
 */
export function summaryStream(
	override: AgentRunConfig["streamFn"] | undefined,
	scope: Pick<AgentRunConfig, "sessionId" | "cwd" | "retryPolicy" | "signal">,
): typeof streamAssistant | undefined {
	if (!override) return (provider, model, context, options) => streamAssistant(provider, model, context, { ...options, retryPolicy: options?.retryPolicy ?? scope.retryPolicy, signal: options?.signal ?? scope.signal });
	return (provider, model, context, options) => {
		const call = override;
		// A generator that only returns: compaction asks for a stream, the override answers with a
		// whole message. The generator shape is the adaptor; there is nothing to yield along the way.
		// oxlint-disable-next-line require-yield
		async function* once(): AsyncGenerator<StreamEvent, AssistantMessage> {
			return call({ ...context }, {
				...scope, provider, model, messages: context.messages,
				systemPrompt: context.systemPrompt ?? "", tools: [],
				thinking: options?.thinking, maxTokens: options?.maxTokens, signal: options?.signal ?? scope.signal,
			});
		}
		return once();
	};
}
