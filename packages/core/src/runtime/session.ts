/**
 * The runtime that turns settings + a workspace into a running agent.
 *
 * Everything user-facing goes through here: the desktop main process, the sync server and the CLI
 * all drive the same `AgentSession`, so the phone and the desktop cannot drift.
 *
 * What is left in this file is the driving: take a prompt, run a turn, stop, queue, approve. What
 * the session *has done* is `SessionLog` — the transcript and the append-only log kept as one
 * thing — and what it *can do* is `SessionCapabilities`. Both are held rather than inherited, so
 * the boundary is visible at every call site.
 *
 * Who holds the history right now (a prompt, a turn, a manual compaction) is `SessionActivity`;
 * gathering background results and delivering them is `SessionDeliveries`; `session://` lookups are
 * `session-lookup.ts`. Manual compaction, the cut behind undo and edit-and-resend, and recording the
 * model and thinking level are `manual-compaction.ts`, `session-rewind.ts` and `session-model.ts`.
 * What stays is how a turn starts, queues and stops — which borrows a dozen pieces of session state
 * at once. Why it is split this way: ADR-0039.
 */

import type { AgentEvent, AgentEventSink, QueuedTask } from "../agent/events.ts";
import type { LiveModel, StreamFn } from "../agent/run-config.ts";
import type { Settings } from "../config/settings.ts";
import { describeSettingsProblem, layerProjectSettings, resolveModel, settingsProblem, withProjectLayer } from "../config/settings.ts";
import { SESSIONS_KEY } from "../resources/more-handlers.ts";
import type { Boundary, SessionMeta } from "../session/store.ts";
import type { SessionStorage } from "../session/storage.ts";
import type { ApprovalDecision, ApprovalRequest, Message, MessageAttachment, ThinkingLevel, Tool, UserContent } from "../types.ts";
import { ApprovalGate, sessionApprovalGate } from "./approvals.ts";
import type { ContextBreakdown } from "./context.ts";
import { describeContext, describeSession, type SessionFacts, type SessionStatus } from "./reporting.ts";
import { CapabilityWatcher } from "./capability-watch.ts";
import { SessionCapabilities } from "./session-capabilities.ts";
import { scratchDir, sessionFacts } from "./session-facts.ts";
import { SessionLog } from "./session-log.ts";
import { PROJECT_MEMORY_ENABLED_KEY, projectMemoryEnabled } from "./project-memory.ts";
import { sessionPruner } from "../agent/aged-prune.ts";
import { driveTurn, historyFrom, modelHistory } from "./session-turn.ts";
import { restoreSubAgents, type Rebuild } from "./sub-agent-restore.ts";
import { rehydrateMessages } from "../session/payload.ts";
import { SubAgentRegistry, type SteerDisplay } from "./sub-agents.ts";
import { DelegationWaits } from "./delegation-waits.ts";
import { backgroundJobs } from "../tools/background-jobs.ts";
import { SessionActivity, type CompactOutcome } from "./session-activity.ts";
import { SessionDeliveries } from "./session-deliveries.ts";
import { sessionLookup } from "./session-lookup.ts";
import { refreshDispatchGate } from "./turn-config.ts";
import { sessionTaskQueue, type TaskQueue } from "./task-queue.ts";
import { stripStaleHandles } from "../agent/model-switch.ts";
import { streamAssistant } from "../ai/index.ts";
import { SessionTitle } from "./session-title.ts";
import { TODOS_KEY } from "../tools/todo.ts";
import { manualCompaction, type CompactionParts } from "./manual-compaction.ts";
import { adoptModelSwitch, recordModel, recordThinking } from "./session-model.ts";
import { rewind, type RewindParts } from "./session-rewind.ts";

export interface AgentSessionOptions {
	cwd: string;
	settings: Settings;
	store: SessionStorage;
	meta?: SessionMeta;
	emit: AgentEventSink;
	/**
	 * Tools that only exist on a particular host — the desktop app contributes browser
	 * automation backed by a real BrowserWindow, which the platform-agnostic core cannot build.
	 */
	extraTools?: Tool[];
	/**
	 * Replaces the provider call, exactly as `AgentModelContext.streamFn` does one layer down.
	 *
	 * Exposed here so behaviour that lives in the session rather than the loop — the task
	 * queue, in particular — can be exercised without a network round trip.
	 */
	streamFn?: StreamFn;
	/** A turn override suppresses title requests unless this separate stream is supplied. */
	titleSummaryStream?: typeof streamAssistant;
}

export class AgentSession {
	readonly store: SessionStorage;
	readonly log: SessionLog;
	readonly can: SessionCapabilities;
	cwd: string;

	private settings: Settings;
	/**
	 * 应用给的那一份，没有叠过项目层。
	 *
	 * 留着它，是因为项目层要能重新叠：设置一变，主进程推下来的是全局的那一份，
	 * 拿已经叠过的结果再叠一次，项目的值会被当成全局的值固化下来。
	 */
	private globalSettings: Settings;
	/** `.plume/config.json` as last read, laid over new global settings until the next read lands. */
	private projectLayer: Record<string, unknown> = {};
	/** Bumped by every read of the project layer, so a slower, older read cannot land over a newer one. */
	private projectReads = 0;
	/** 盯着技能和子智能体目录的那个，没有可听的目录时是 null。 */
	private watcher: CapabilityWatcher | null = null;
	private streamFn?: StreamFn;
	/**
	 * 标题那件事的全部，在 `session-title.ts` 里。
	 *
	 * 和 `tasks`/`approvals`/`subAgents` 一样是协作者。轮次、控制器、后台任务都在它自己那边——
	 * 这个类里从此看不到「摘要跑到哪一步了」这种东西。
	 */
	private title: SessionTitle;
	/** 谁此刻占着历史、怎么停下它。见 `session-activity.ts`。 */
	private readonly activity = new SessionActivity();
	private steering: Message[] = [];
	/**
	 * 说了「等这一轮做完再说」的那些消息。
	 *
	 * 跟 `steering` 分开的理由就是它们的区别：`steering` 会被塞进正在跑的那一轮，而这些要等
	 * 那一轮结束。合成一个队列的话，两种意思里必然有一种表达不出来。
	 */
	private readonly pending: { message: Message; thinking?: ThinkingLevel }[] = [];
	/**
	 * Every sub-agent this session has dispatched, live and finished.
	 *
	 * Owned by the session rather than by the turn that spawned one: a delegated run is worth
	 * reading after the turn that asked for it has ended, and the pane showing it outlives both.
	 * Emitting on change is what keeps a window in step without polling.
	 */
	readonly subAgents = new SubAgentRegistry(
		() => {
			void this.emit({ type: "subagents", agents: this.subAgents.list() });
		},
		/*
		 * 一个子代理停下了，它还挂着的授权也就没人等了——收回，卡片跟着下来。
		 *
		 * 被按停的那一刻它可能正停在一次授权上：循环不再等那个回答，可问题还挂在闸门里，卡片要在
		 * 屏幕上一直留到五分钟超时，点了也没人接。
		 */
		(id) => this.approvals.rejectWhere((request) => request.from?.subAgentId === id),
	);
	/**
	 * 主会话在等的派发：人一开口就放手，放了手的跑完后结果送回来。见 `delegation-waits.ts`。
	 */
	private readonly delegations = new DelegationWaits({
		detached: (id) => this.subAgents.background(id),
		settled: (report) => this.deliveries.report(report),
	});
	/** 跑完了、还没送回主会话的后台结果；攒一小会儿再送。见 `session-deliveries.ts`。 */
	private readonly deliveries: SessionDeliveries;
	/** 剪枝器最后一次从日志放回视图时对着的那份历史；见 `preparePruner`。 */
	private viewsSeededFor: Message[] | null = null;
	/** Whether the previous process's sub-agents are back on the roster; see `restoreSubAgents`. */
	private subAgentsRestored = false;
	/** 正在跑的那一轮对「模型换了」的订阅；见 `liveModel`。 */
	private readonly modelListeners = new Set<() => void>();
	/**
	 * 这场对话此刻的模型，交给正在跑的那一轮。
	 *
	 * 人中途换了模型，它从下一个请求起就换；旧的上游坏了、请求正卡在重试上的，当场放手换人。
	 * 见 `AgentModelContext.liveModel`。
	 */
	private readonly liveModel: LiveModel = {
		current: () => resolveModel(this.settings, this.log.meta.modelId || this.settings.defaultModelId),
		onChange: (listener) => {
			this.modelListeners.add(listener);
			return () => this.modelListeners.delete(listener);
		},
		adopted: () => adoptModelSwitch(this.log),
	};
	private readonly approvals: ApprovalGate;
	private readonly tasks: TaskQueue = sessionTaskQueue({
		run: (task) => this.prompt([{ type: "text", text: task.text }], { origin: task.origin }),
		busy: () => this.running,
		changed: (tasks) => this.emit({ type: "tasks", tasks }),
	});

	constructor(options: AgentSessionOptions) {
		this.cwd = options.cwd;
		this.settings = options.settings;
		this.globalSettings = options.settings;
		this.store = options.store;
		this.streamFn = options.streamFn;
		this.title = new SessionTitle({
			settings: () => this.settings,
			append: (record) => this.log.append(record),
			emitTitle: (title) => this.emit({ type: "title", title }),
			titleSetByUser: () => Boolean(this.log.meta.titleSetByUser),
			modelId: () => this.log.meta.modelId,
			stream: options.titleSummaryStream,
			// 见 `TitleDeps.stream` 那段：这两个要一起看，少看一个会在测试里真的发请求。
			sessionStreamInjected: Boolean(options.streamFn),
		});
		/*
		 * 每一个出门的事件都先过这里翻牌，然后才交给宿主。
		 *
		 * 翻的是 `activity.steerable`，看 loop 此刻在不在。必须挂在 log 的出口上：loop 自己
		 * 的事件走 `session-turn.ts` 的 `recordTurnEvent` 直接进 `log.emit`，根本不经过
		 * `Session.emit`——翻在那里的话 `agent_start` 一次都翻不到，`steerable` 永远是 false，
		 * 于是插话悄悄退化成了「这一轮做完再说」，而测试照样是绿的。
		 *
		 * 在 `sink` 之前翻，所以窗口看到 `agent_end` 的那一刻，这边已经不收插话了——那正是
		 * 排队出队要抢的那一拍。
		 */
		this.log = new SessionLog(options.store, (event) => {
			this.activity.observe(event);
			return options.emit(event);
		}, options.meta);
		this.can = new SessionCapabilities(options.extraTools ?? []);
		this.deliveries = new SessionDeliveries({
			activity: this.activity,
			jobs: () => backgroundJobs(this.can.state),
			detail: (id) => this.subAgents.detail(id),
			submit: (message) => this.submit(message, { fromPerson: false }),
		});
		backgroundJobs(this.can.state).onFinished((job) => this.deliveries.jobFinished(job));
		this.approvals = sessionApprovalGate({
			mode: () => this.settings.permissionMode,
			cwd: () => this.cwd,
			emit: (event) => this.emit(event),
			alwaysAllow: options.settings.alwaysAllow,
		});
	}

	/** The history, as callers have always read it. */
	get meta(): SessionMeta {
		return this.log.meta;
	}

	get messages(): Message[] {
		return this.log.messages;
	}

	/**
	 * Adopt a transcript read back from disk, and where the model's view of it begins.
	 *
	 * Both, because they are two halves of one fact. Restoring the messages without the boundary
	 * reopens a compacted session on its full history: correct on screen, and back over the context
	 * window on the first prompt — which then compacts again, from scratch, having thrown away the
	 * summary it paid for last time.
	 */
	restore(messages: Message[], compaction: Boundary | null = null, compactions: number[] = []): void {
		/*
		 * Handles from before a model change are dropped on the way in, not at the point of use.
		 *
		 * The log on disk is append-only, so a switch cannot edit what is already written — which
		 * means the stale handles come back every time the session is opened. Cleaning here covers
		 * both ways in, from the session hub and from sync, and leaves the encoders unchanged.
		 */
		this.log.restore(stripStaleHandles(messages, this.log.meta?.modelSwitchedAt), compaction, compactions);
	}

	get running(): boolean {
		return this.activity.running;
	}

	/** Load skills, agents and MCP tools. Safe to call again after settings change. */
	async initialize(): Promise<void> {
		if (!this.log.meta) {
			this.log.meta = await this.store.create(this.cwd, this.settings.defaultModelId ?? "", undefined, { thinking: this.settings.thinking });
		}
		await this.applyProjectConfig();
		/*
		 * The global settings file could not be read, so this runs on defaults: no providers, no MCP
		 * servers, no hooks. Said in the session because this is where it shows — an empty model list
		 * reads as the app having lost everything, not as one file that would not parse.
		 */
		const damaged = settingsProblem();
		if (damaged) {
			await this.emit({
				type: "notice",
				level: "error",
				message: describeSettingsProblem(damaged),
				code: damaged.keptAt ? "settings-unreadable-kept" : "settings-unreadable",
				params: { path: damaged.path, reason: damaged.reason, ...(damaged.keptAt ? { keptAt: damaged.keptAt } : {}) },
			});
		}
		await this.can.load(this.cwd, this.settings);
		/*
		 * `session://` 的数据源。
		 *
		 * 在这里而不是 `SessionCapabilities` 里，因为它要的是 store——而能力层刻意不知道会话
		 * 是怎么存的。
		 */
		this.can.state.set(SESSIONS_KEY, sessionLookup(this.store));
		await this.restoreSubAgents();
		/*
		 * 扩展的 `session_start`。
		 *
		 * 在 `can.load` 之后：这时扩展自己才刚被加载起来，而一个还没起来的 worker 收不到事件。
		 * 不 await——一个扩展在启动时慢，不该让打开一个对话跟着慢。
		 */
		void this.can.extensions.dispatch("session_start", { cwd: this.cwd, sessionId: this.log.meta.id }).catch(() => {});
		this.startWatching();
	}

	/**
	 * 盯着那些真的放了东西的目录，改了就重读。
	 *
	 * 编辑技能是这套系统里最高频的动作之一：写一条、试一句、再改一版。要求每一版都重启
	 * 窗口，等于要求每一版都重新加载全部插件、重连全部 MCP、丢掉正在看的那个对话。
	 *
	 * `watched` 这份名单一直被收集着——每个 provider 都老实报了，注册表也合并了——只是从来
	 * 没有人接。
	 */
	private startWatching(): void {
		this.watcher?.close();
		if (this.can.watched.length === 0) return;
		this.watcher = new CapabilityWatcher({
			dirs: this.can.watched,
			// 一轮跑到一半绝不换：模型正按当前那份清单做决策。
			idle: () => !this.running,
			reload: () => this.reloadCapabilities(),
		});
	}

	/**
	 * 重读一遍，然后说清楚变了什么。
	 *
	 * 「能力已更新」对着一次 `git checkout` 说了等于没说——那会换掉半个目录。所以报的是数量差
	 * 和新出现的名字。两个数都是 0 也是一个诚实的答案：有人改了某个技能的正文，而名单没变。
	 */
	/**
	 * 重新发现能力，并把变化说出来。
	 *
	 * 公开的，因为它是监听器的动作本身——而测试要验的是「重载会更新 `can` 并且发出通知」，
	 * 不是「`fs.watch` 在这台机器上多久发一次事件」。后者是 Node 的事，在负载高时要等十几秒，
	 * 而一条等它的测试是在赌延迟：`capability-watch.test.ts` 为此把超时调大过三次。
	 */
	async reloadCapabilities(): Promise<void> {
		const before = {
			skills: this.can.skills.length,
			agents: this.can.agents.length,
			names: new Set([...this.can.skills.map((s) => s.name), ...this.can.agents.map((a) => a.name)]),
		};

		await this.can.load(this.cwd, this.settings);
		// 目录名单本身也会变——新建了 `.plume/skills/` 之后，它才第一次出现在 `watched` 里。
		this.startWatching();

		await this.emit({
			type: "capabilities_changed",
			skills: this.can.skills.length - before.skills,
			agents: this.can.agents.length - before.agents,
			added: [...this.can.skills.map((s) => s.name), ...this.can.agents.map((a) => a.name)]
				.filter((name) => !before.names.has(name))
				.slice(0, 4),
		});
	}

	/**
	 * 把 `<cwd>/.plume/config.json` 叠到全局设置上。
	 *
	 * 这一层以前只有一个模块和一份测试，产品里没有任何东西读那个文件——「A 项目用便宜模型加
	 * 严格审批、B 项目用强模型加宽松审批」在这个分支上一直只是一段注释。
	 *
	 * 在会话上叠而不是在应用上叠，是因为项目本来就是会话的属性：一个窗口可以同时开着两个项目的
	 * 对话，而设置页只有一个。
	 */
	private async applyProjectConfig(): Promise<void> {
		const read = ++this.projectReads;
		const layered = await layerProjectSettings(this.globalSettings, this.cwd).catch(() => null);
		// A settings change after this read started has started its own; this one is stale.
		if (!layered || read !== this.projectReads) return;
		this.projectLayer = layered.layer;
		this.settings = layered.settings;
		this.can.state.set(PROJECT_MEMORY_ENABLED_KEY, projectMemoryEnabled(this.settings));

		/*
		 * 被拒的键要说出来，而且要说得像一次拒绝。
		 *
		 * `.plume/config.json` 是要提交进仓库的，落在里面的凭证就是已公开的凭证。安静地忽略它，
		 * 写的人会以为它生效了——那正是「能正常工作、只是把密钥共享了」的那种错误。
		 */
		if (layered.refused.length > 0) {
			await this.emit({
				type: "notice",
				level: "warn",
				message: `.plume/config.json 里的 ${layered.refused.join("、")} 被忽略了——这个文件会进仓库，凭证和供应商只能写在全局设置里。`,
				code: "project-config-refused",
				params: { keys: layered.refused.join(", ") },
			});
		}
		if (layered.error) {
			const problem = layered.problem;
			await this.emit({
				type: "notice",
				level: "warn",
				message: layered.error,
				...(problem?.kind === "not-object" ? { code: "project-config-not-object", params: { path: problem.path } } : {}),
				...(problem?.kind === "invalid-json" ? { code: "project-config-invalid-json", params: { path: problem.path, error: problem.detail } } : {}),
			});
		}
		// 项目层可能改了并发上限：闸门要跟上叠好的那一份，不是全局那一份。
		refreshDispatchGate(this.can.state, this.settings);
	}

	async status(): Promise<SessionStatus> {
		return describeSession(this.facts());
	}

	async contextBreakdown(): Promise<ContextBreakdown | null> {
		const resolved = resolveModel(this.settings, this.log.meta.modelId || this.settings.defaultModelId);
		if (!resolved) return null;
		return describeContext({ ...this.facts(), messages: modelHistory(this.log, resolved.provider, resolved.model) });
	}

	private facts(): SessionFacts {
		const { log, can, cwd, settings, running } = this;
		return sessionFacts({ log, can, cwd, settings, running });
	}

	/**
	 * Summarise the conversation now, rather than when it runs out of room.
	 *
	 * What `/compact` calls. The boundary is stored exactly as it is when compaction happens on its
	 * own — there is one way a session's history gets shortened, and this only changes what starts
	 * it.
	 *
	 * Refused mid-turn: the running loop is holding its own copy of the history and would write its
	 * own boundary at the end of the turn, over this one.
	 */
	compact(instructions = ""): Promise<CompactOutcome> {
		const pending = this.activity.compaction;
		if (pending) return pending;
		if (this.running) return Promise.resolve({ ok: false, reason: "对话正在进行中，等它结束再压缩。", code: "busy" });
		const task = this.activity.compact((signal) => manualCompaction(this.compactionParts(), instructions, signal));
		void task.finally(() => {
			void this.watcher?.resume();
			void this.tasks.drain();
		}).catch(() => {});
		return task;
	}

	private compactionParts(): CompactionParts {
		return {
			log: this.log,
			can: this.can,
			settings: () => this.settings,
			streamFn: this.streamFn,
			emit: (event) => this.emit(event),
			preparePruner: () => this.preparePruner(),
		};
	}

	/**
	 * 会话的剪枝器接上日志：压缩采纳的视图写下来；历史换过一份（载入、撤回、换模型）之后，
	 * 第一次用它之前把日志里记下的放回去。读不出来就照旧从原文走，不挡这一轮。
	 */
	private async preparePruner(): Promise<void> {
		const pruner = sessionPruner(this.can.state);
		pruner.onAdopt ??= (views) => this.log.recordViews(views);
		const history = this.log.messages;
		if (this.viewsSeededFor === history) return;
		this.viewsSeededFor = history;
		const views = await this.log.restoredViews().catch(() => []);
		for (const { source, view } of views) pruner.remember(source, view);
	}

	/**
	 * 上一个进程派出去的子代理，放回名单——停下了，但能续跑。见 `sub-agent-restore.ts`。
	 *
	 * 只在打开时做一次：`initialize` 改设置时还会再调，而那时名单上的已经是这个进程自己的。读不出来
	 * 就算了，名单空着和从前一样，不挡打开对话。
	 */
	private async restoreSubAgents(): Promise<void> {
		if (this.subAgentsRestored) return;
		this.subAgentsRestored = true;
		// `then` rather than a bare call: a store that cannot answer at all throws before there is a promise to catch.
		const records = await Promise.resolve()
			.then(() => this.store.subAgentRecords(this.log.meta.id))
			.catch(() => []);
		if (records.length === 0) return;
		// 落盘时挪出去的图片接回来，跟主会话的消息同一条路（`store.load`）。
		const said = records.flatMap((record) => (record.type === "event" && record.event.type === "subagent_message" && record.event.message ? [record.event.message] : []));
		const hydrated = await rehydrateMessages(said).catch(() => said);
		const back = new Map(said.map((message, index) => [message, hydrated[index] ?? message]));
		const readable = records.map((record) =>
			record.type === "event" && record.event.type === "subagent_message" && back.has(record.event.message)
				? { ...record, event: { ...record.event, message: back.get(record.event.message)! } }
				: record,
		);
		const fallback = resolveModel(this.settings, this.log.meta.modelId || this.settings.defaultModelId);
		const rebuild: Rebuild = (ran) => {
			// The model it ran on, so the prefix is the one it sent. Gone from settings: the session's, under no id, so `runSubAgent` strips the old handles.
			const provider = this.settings.providers.find((one) => one.enabled && one.id === ran.provider);
			const model = provider?.models.find((one) => one.modelId === ran.model);
			const using = provider && model ? { provider, model } : fallback;
			return using ? { model: provider && model ? model.id : "", history: (messages, boundary) => historyFrom(messages, boundary, using.provider, using.model) } : undefined;
		};
		this.subAgents.restore(restoreSubAgents(readable, rebuild));
	}

	/** Drop the cached symbol index so the next `symbol` lookup re-reads it from disk. */
	invalidateSymbolIndex(): void {
		this.can.invalidateSymbolIndex();
	}


	updateSettings(settings: Settings): void {
		if (settings.autoSummarizeTitle === false) void this.title.cancel();
		this.globalSettings = settings;
		// The project layer stays on while it is re-read; dropping it here ran stricter project
		// settings (approval mode, concurrency) on global ones for the length of a disk read.
		this.settings = withProjectLayer(settings, this.projectLayer);
		this.can.state.set(PROJECT_MEMORY_ENABLED_KEY, projectMemoryEnabled(this.settings));
		for (const subject of settings.alwaysAllow) this.approvals.allow(subject);
		/*
		 * 并发上限当场生效，不等下一轮。
		 *
		 * 主会话派了四个、闸门只放一个的时候，这一轮要等四个依次跑完才结束；人这时候去设置页把
		 * 并发调大，排着的那几个应该马上开跑，而不是等一个永远轮不到的「下一轮」。
		 */
		refreshDispatchGate(this.can.state, this.settings);
		/*
		 * 项目层重新叠一遍，不等这次调用。
		 *
		 * 它要读一次盘，而这个方法是同步的（每一个改设置的路径都在调它）。不重新叠的话，
		 * 在设置页改任何一项，都会把这个会话的项目配置默默清掉——而屏幕上没有任何东西说这件事。
		 */
		void this.applyProjectConfig();
	}

	/** Pick or change the model this session runs on, at any point. See `recordModel`. */
	async setModel(modelId: string): Promise<boolean> {
		const changed = await recordModel(this.log, modelId);
		/*
		 * 正在跑的那一轮也要听到。
		 *
		 * 从前它听不到：一轮开始时拿到的模型用到这一轮结束。旧模型的上游坏了、请求在一遍遍重试时，
		 * 人换了模型——界面上写着新的，服务器收到的一直是旧的，直到人按停止、再编辑重发。见
		 * `AgentModelContext.liveModel`。
		 */
		if (changed) for (const listener of this.modelListeners) listener();
		return true;
	}

	/** How hard this conversation asks the model to think, from here on. See `recordThinking`. */
	async setThinking(thinking: ThinkingLevel | null): Promise<void> {
		await recordThinking(this.log, thinking);
	}

	// -------------------------------------------------------------------------
	// Running a turn
	// -------------------------------------------------------------------------

	/**
	 * Send a prompt. If the agent is already running, the message is queued as steering and
	 * picked up between turns instead of starting a second concurrent run.
	 */
	/**
	 * Say something to a sub-agent that is still running.
	 *
	 * Not a second conversation: the message is spliced between its turns, so it finishes the step
	 * it is on, reads this with its context intact, and carries on. False when there is no such
	 * sub-agent or it has already finished — the caller decides whether that is worth saying.
	 *
	 * The effect on the parent is indirect and that is the whole design. One executor per
	 * workspace: steering changes what the sub-agent reports back, and the parent acts on the
	 * report. Two agents writing to one working tree is a conflict waiting to happen.
	 */
	async steerSubAgent(id: string, said: string | UserContent[], display?: SteerDisplay): Promise<boolean> {
		const message = this.subAgents.steer(id, said, display);
		if (!message) return false;
		/*
		 * Announced, or a window watching this sub-agent would not see what was said to it.
		 *
		 * The roster event that `steer` triggers carries summaries and no transcripts, so without
		 * this the message sat in the sub-agent's history unseen until something re-read the whole
		 * thing — and the reply, when it came, would arrive as an answer to a question that was
		 * never on screen.
		 */
		await this.emit({ type: "subagent_message", id, message });
		return true;
	}

	/** Stop one sub-agent. The parent and its siblings carry on. */
	abortSubAgent(id: string): boolean {
		return this.subAgents.abort(id);
	}

	/**
	 * Take one off the roster — stopping it first if it is still going.
	 *
	 * A running sub-agent that was merely un-listed would go on running with nothing able to reach
	 * it, so this never silently orphans one; see `SubAgentRegistry.dismiss`.
	 */
	async dismissSubAgent(id: string): Promise<"removed" | "stopping" | "unknown"> {
		const outcome = this.subAgents.dismiss(id);
		// Written down, or the next process reads it back from the log and lists it again.
		if (outcome === "removed") await this.emit({ type: "subagent_dismissed", id });
		return outcome;
	}

	/** Consume a durable opening message once, without appending a second copy. */
	resumePendingPrompt(): Promise<void> {
		const pending = this.activity.holding("resume");
		if (pending) return pending;
		if (!this.log.meta.pendingPrompt) return Promise.resolve();
		const mark = this.activity.mark();
		const resume = async () => {
			await this.cancelPendingPrompt();
			if (this.activity.stoppedSince(mark)) { await this.emit({ type: "agent_end", reason: "aborted" }); return; }
			/*
			 * A fresh session restored with pendingPrompt (e.g. from the desktop new session flow)
			 * has its first prompt already written to disk before the session object exists. Trigger
			 * title summarisation here if the user has not explicitly provided a custom title.
			 */
			if (!this.log.meta.titleSetByUser) {
				const userMessages = this.log.messages.filter((m) => m.role === "user");
				if (userMessages.length === 1) {
					const first = userMessages[0];
					await this.title.fromPrompt(first.content, first.displayText === "" ? first.skillRef?.name ?? first.sessionRefs?.[0]?.title ?? "" : first.displayText);
				}
			}
			if (this.activity.stoppedSince(mark)) { await this.emit({ type: "agent_end", reason: "aborted" }); return; }
			await this.run();
			await this.drainPending();
		};
		const held = this.activity.hold("resume", resume);
		void held.finally(() => void this.tasks.drain()).catch(() => {});
		return held;
	}

	async cancelPendingPrompt(): Promise<void> {
		if (!this.log.meta.pendingPrompt) return;
		this.log.meta = { ...this.log.meta, pendingPrompt: undefined };
		await this.log.append({ type: "meta", meta: this.log.meta });
	}

	async prompt(
		content: UserContent[],
		options: {
			thinking?: ThinkingLevel;
			origin?: "side-chat";
			/**
			 * The message is the app asking on the user's behalf, not the user typing.
			 *
			 * 「继续」 is the case: it says the same thing the user would have typed, and it is not
			 * something they wrote. Marked so the transcript does not put words in their mouth, and
			 * so the three places that look for "the last thing actually asked for" — retrying,
			 * compaction's standing instruction, whether a conversation has any real content — all
			 * see past it to the request it is continuing.
			 */
			synthetic?: boolean;
			/**
			 * 会话正忙时怎么办。默认 `steer`——插进正在跑的那一轮。
			 *
			 * `followUp` 是另一种意思：**不打断，排到这一轮后面**。「跑完之后顺手把测试也跑一遍」
			 * 属于后者，而现在说出来跟等五分钟再说出来的区别，是要不要一直守在这儿。
			 *
			 * 空闲时两者一样，都是开一个新回合——差别只存在于有东西正在跑的时候，而这正是它
			 * 唯一需要被区分的时候。
			 */
			deliver?: "steer" | "followUp";
			displayText?: string;
			skillRef?: { name: string; path?: string; pluginId?: string };
			sessionRefs?: Array<{ id: string; title: string }>;
			attachments?: MessageAttachment[];
		} = {},
	): Promise<void> {
		// A prompt waits for the manual boundary before creating a turn against that history.
		const compaction = this.activity.compaction;
		if (compaction) await compaction;
		const message: Message = {
			role: "user",
			content,
			timestamp: Date.now(),
			...(options.origin ? { origin: options.origin } : {}),
			...(options.synthetic ? { synthetic: true } : {}),
			...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
			...(options.skillRef ? { skillRef: options.skillRef } : {}),
			...(options.sessionRefs?.length ? { sessionRefs: options.sessionRefs } : {}),
			...(options.attachments?.length ? { attachments: options.attachments } : {}),
		};

		return this.submit(message, {
			thinking: options.thinking,
			deliver: options.deliver,
			fromPerson: true,
			// Names the conversation after its opening line — unless it already has a name someone
			// chose, which this must not overwrite. See `SessionMeta.titleSetByUser`.
			title: async () => {
				if (!this.log.meta.titleSetByUser && this.log.messages.filter((m) => m.role === "user").length === 1) {
					await this.title.fromPrompt(content, options.displayText === "" ? options.skillRef?.name ?? options.sessionRefs?.[0]?.title ?? "" : options.displayText);
				}
			},
		});
	}

	/**
	 * 一条消息进会话：忙着就插话或排队，闲着就开一个回合。
	 *
	 * 人说的话和运行时替后台子代理递回来的结果都走这里，差别只有一处：`fromPerson`。人开口时，
	 * 父会话不再干等它派出去的子代理（见 `delegation-waits.ts`）；送达的结果不是人在说话，它只是
	 * 排进去，不打断任何人。
	 */
	private async submit(
		message: Message,
		options: { thinking?: ThinkingLevel; deliver?: "steer" | "followUp"; fromPerson: boolean; title?: () => Promise<void> },
	): Promise<void> {
		if (this.running) {
			/*
			 * 插话，还是排队。
			 *
			 * 插话是默认，因为绝大多数在回合中途说的话都是「等等，不是那样」——那种话晚说
			 * 五分钟就白说了。而 `followUp` 说的是「这一轮做完再说」，把它插进去反而会打断
			 * 那件本来就该先做完的事。
			 */
			if (options.deliver === "followUp" || !this.activity.steerable) {
				this.pending.push({ message, thinking: options.thinking });
			} else {
				this.steering.push(message);
				/*
				 * 人开口了，父会话别再干等子代理。
				 *
				 * 插话只在两轮之间才有人取，而父会话正卡在一个 `task` 上的时候，「两轮之间」要等到
				 * 子代理全部跑完——十几分钟。放手之后这一轮当场往下走，下一个回合开头就读到这句话；
				 * 子代理留在后台接着跑，跑完的结果另外送回来。
				 */
				if (options.fromPerson) this.delegations.release();
			}
			return;
		}

		// Reserve the turn before the first disk write; another submission must queue during it.
		const mark = this.activity.mark();
		const accept = async () => {
			await this.cancelPendingPrompt();
			await this.log.commit(message);
			await this.emit({ type: "message_start", message });
			await this.emit({ type: "message_end", message });
			await options.title?.();

			if (this.activity.stoppedSince(mark)) { await this.emit({ type: "agent_end", reason: "aborted" }); return; }
			await this.run(options.thinking);
			await this.drainPending();
		};
		try { await this.activity.hold("prompt", accept); }
		finally { void this.tasks.drain(); }
	}

	/**
	 * 排在这一轮后面的那些，按进来的顺序发。
	 *
	 * 一条 `followUp` 跑完可能又带出下一条，所以是循环而不是一次——而 `run` 本身在跑的时候
	 * `this.running` 为真，所以循环里不会有第二个回合同时开始。
	 */
	private async drainPending(): Promise<void> {
		while (this.pending.length > 0 || this.steering.length > 0) {
			/*
			 * 没人接走的插话，也在这里兜住。
			 *
			 * 走到这里 loop 已经结束了——`drainSteering` 不会再被调用——所以此刻还留在
			 * `steering` 里的只可能是孤儿。孤儿不报错、不进转录、也不回到队列条上，人看到的
			 * 只是「发出去了但一点反应都没有」，而它会在下一次发送时被顺带倒出来，看起来像
			 * 旧话重放。`steerable` 那道判断堵的是已知的那条进法，这里堵的是「还有没有别的
			 * 进法」——这类故障最不该靠推理来保证不发生。
			 *
			 * 排在 `pending` 前面，因为它们是更早说出口的。
			 */
			if (this.steering.length > 0) {
				this.pending.unshift(...this.steering.splice(0, this.steering.length).map((message) => ({ message })));
			}
			const next = this.pending.shift();
			if (!next) break;
			if (this.activity.stopping) break;
			const mark = this.activity.mark();
			await this.log.commit(next.message);
			await this.emit({ type: "message_start", message: next.message });
			await this.emit({ type: "message_end", message: next.message });
			if (this.activity.stoppedSince(mark)) break;
			await this.run(next.thinking);
		}
	}

	/**
	 * What this turn asks for: the caller's word, then the conversation's, then the app's.
	 *
	 * Resolved here rather than at each entry point so every way of starting a turn — the desktop,
	 * the phone through sync, a scheduled task, 「继续」 — reads the conversation's own level
	 * without each of them having to remember to.
	 */
	private thinkingFor(requested?: ThinkingLevel): ThinkingLevel | undefined {
		return requested ?? this.log.meta.thinking ?? undefined;
	}

	private async run(requested?: ThinkingLevel): Promise<void> {
		const thinking = this.thinkingFor(requested);
		const resolved = resolveModel(this.settings, this.log.meta.modelId || this.settings.defaultModelId);
		if (!resolved) {
			await this.emit({
				type: "notice",
				level: "error",
				message: "No model is configured. Add a provider in Settings → Models first.",
				code: "no-model",
			});
			await this.emit({ type: "agent_end", reason: "error", error: "no_model" });
			return;
		}

		const signal = this.activity.beginTurn();
		try {
			await this.preparePruner();
			const turn = driveTurn({
				cwd: this.cwd,
				settings: this.settings,
				getSettings: () => this.settings,
				log: this.log,
				can: this.can,
				provider: resolved.provider,
				model: resolved.model,
				signal,
				thinking,
				streamFn: this.streamFn,
				scratchDir: scratchDir(this.log.meta.id),
				requestApproval: (request) => this.requestApproval(request),
				emit: (event) => this.emit(event),
				drainSteering: () => this.steering.splice(0, this.steering.length),
				subAgents: this.subAgents,
				delegations: this.delegations,
				liveModel: this.liveModel,
			});
			this.activity.trackTurn(turn);
			await turn;
		} finally {
			// Whatever the turn's own error was, it is the one that propagates.
			await this.log.settleOrphan().catch(() => {});
			this.activity.endTurn();
			/*
			 * Anything still waiting for approval would hang forever once the run is over.
			 *
			 * 后台子代理问的除外：它们的问题本来就是在主会话收尾之后问出来的，人还没看见，这里一并
			 * 收掉就等于替人答了「不行」。它们停下时由登记簿那一头收回（见 `subAgents` 的 `onFinish`）。
			 */
			this.approvals.rejectWhere((request) => !request.from);
		}

		/*
		 * 这一轮跑的时候磁盘上改过的东西，现在换进来。
		 *
		 * 「流式中不替换」那条约束的另一半：排了队就得有人放出来，否则那次改动会一直等到下一次
		 * 文件事件——而人保存完文件就等着看效果，不会再去动它一次。
		 */
		void this.watcher?.resume();

		// The queue moves the moment the workspace is free again. Skipped while draining,
		// because that loop is already the thing calling us.
		void this.tasks.drain();
	}

	abort(): void {
		void this.title.cancel();
		// The prompt owner records a cancelled startup before resolving, so disposal cannot race
		// an unawaited append after the caller has already finished the opening submission.
		this.activity.stop();
		this.steering.length = 0;
		/*
		 * Explicitly, as well as through the chain.
		 *
		 * Each sub-agent's controller is chained to this one, so aborting here already reaches them
		 * — but "stop means stop" is worth stating rather than inferring from a listener two files
		 * away, and a sub-agent left running past the session it belongs to has nothing that could
		 * ever reach it again.
		 */
		this.subAgents.abortAll();
		this.approvals.rejectAll();
		// 放了手的、攒着没送的都不再送回来；后台命令照跑，只是结束时不再叫醒会话。见 `SessionDeliveries.clear`。
		this.delegations.forget();
		this.deliveries.clear();
		backgroundJobs(this.can.state).mute();
		/*
		 * 排队等着的那些也一并取消。
		 *
		 * 「停止」说的是这个对话现在停下，而不是「停下当前这一轮，然后把我排的三条接着跑完」
		 * ——后者会在人按下按钮之后继续花钱，而屏幕上刚刚显示了已停止。
		 */
		this.pending.length = 0;
		// Stop means stop. Letting the queue carry on after the button was pressed would be
		// the opposite of what pressing it asks for.
		void this.tasks.cancelAll();
	}

	/** Wait for in-flight tools before discarding a plan so a late todo_write cannot restore it. */
	async discardTaskPlan(): Promise<void> {
		this.abort();
		await this.activity.settled();
		await this.tasks.discardPlan();
		this.can.state.delete(TODOS_KEY);
		const message: Message = {
			role: "user", synthetic: true, clearsTaskPlan: true, timestamp: Date.now(),
			content: [{ type: "text", text: "用户已取消旧任务清单。不要继续旧清单；等待新的指令。" }],
		};
		await this.log.commit(message);
		await this.emit({ type: "message_end", message });
	}

	// -------------------------------------------------------------------------
	// Dispatched work
	// -------------------------------------------------------------------------

	get taskQueue(): QueuedTask[] {
		return this.tasks.list();
	}

	async enqueueTask(text: string, origin: QueuedTask["origin"] = "side-chat"): Promise<QueuedTask> {
		return this.tasks.enqueue(text, origin);
	}

	async cancelTask(taskId: string): Promise<boolean> {
		return this.tasks.cancel(taskId);
	}

	/** Take a finished task off the receipt list. The transcript keeps what happened. */
	async dismissTask(taskId: string): Promise<boolean> {
		return this.tasks.dismiss(taskId);
	}

	/** Put an interrupted or failed task back in the queue. See `TaskQueue.resume`. */
	async resumeTask(taskId: string): Promise<boolean> {
		return this.tasks.resume(taskId);
	}

	/**
	 * The task this session was working on when it stopped, if there is one.
	 *
	 * What makes 「继续」 in the main conversation mean the right thing. Pausing a session that was
	 * running a dispatched task cancels the task too, and continuing afterwards used to resume only
	 * the conversation — the task stayed cancelled, the side panel went on saying so, and the work
	 * the panel had dispatched was simply not done. Newest first: if several were interrupted, the
	 * one that was running is the one to pick up.
	 */
	interruptedTask(): QueuedTask | null {
		return this.tasks.list().findLast((task) => task.status === "cancelled" && task.cancelledBy === "stop") ?? null;
	}

	private emit(event: AgentEvent): Promise<void> {
		return this.log.emit(event);
	}

	// -------------------------------------------------------------------------
	// Approvals
	// -------------------------------------------------------------------------

	private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
		return this.approvals.request(request);
	}

	resolveApproval(requestId: string, decision: unknown): boolean {
		return this.approvals.resolve(requestId, decision);
	}

	listPendingApprovals(): { id: string; request: ApprovalRequest; expiresAt: number }[] {
		return this.approvals.list();
	}

	// -------------------------------------------------------------------------
	// Misc
	// -------------------------------------------------------------------------

	/**
	 * Replace a message and run again from there.
	 *
	 * Editing what you asked invalidates the answer and everything built on it, so the tail is
	 * discarded rather than left dangling above a contradictory reply.
	 */
	async editAndResend(
		messageIndex: number,
		content: UserContent[],
		options: {
			thinking?: ThinkingLevel;
			/**
			 * 改的是措辞，不是这条消息是什么。
			 *
			 * 这两样从前没跟过来，于是编辑一次就把它们清空了：`attachments` 一没，界面上那排附件
			 * 整个消失——文件其实还在 `content` 里，模型照样看得见，只有人看不见了；`displayText`
			 * 一没，气泡退回原文，一份上千行的附件正文重新整个铺进自己发出的那条消息里，而那正
			 * 是 `displayText` 存在的全部理由。
			 */
			displayText?: string;
			attachments?: MessageAttachment[];
		} = {},
	): Promise<void> {
		await this.title.cancel();
		if (this.running) {
			this.abort();
			// Acceptance writes and follow-up draining also own the history, before/after driveTurn.
			await (this.activity.holding("prompt") ?? this.activity.holding("resume"))?.catch(() => {});
		}
		await rewind(this.rewindParts(), messageIndex);
		await this.prompt(content, options);
	}

	/**
	 * Take a user message back without asking again.
	 *
	 * Edit-and-resend throws the tail away and immediately spends another turn. Undo is the other
	 * half of that: the same cut, then stop, so the wording can land in the composer instead of
	 * going back to the model. A running turn still owns the log, so this refuses rather than
	 * aborting — abort-then-cut is what edit does, and mixing the two is how a tool write and a
	 * rewind race.
	 */
	async revert(messageIndex: number): Promise<void> {
		if (this.running) {
			throw new Error("Cannot revert while a turn is running");
		}
		await this.title.cancel();
		await rewind(this.rewindParts(), messageIndex);
	}

	private rewindParts(): RewindParts {
		const { log, deliveries, delegations, subAgents } = this;
		return { log, state: this.can.state, deliveries, delegations, subAgents, emit: (event) => this.emit(event) };
	}

	/**
	 * Name the conversation by hand, and have it stay named.
	 *
	 * The title record is what the store already understands, so this is only the writing half.
	 * The other half is `titleSetByUser`: without it the first prompt renames the session after
	 * itself and the name typed a moment earlier is gone. Title and ownership share one record so
	 * cold-session renames and late automatic writes are ordered at the store boundary too.
	 */
	async rename(title: string): Promise<void> {
		const cleanTitle = title.trim();
		if (!cleanTitle) return;
		await this.title.cancel();
		await this.log.append({ type: "title", title: cleanTitle, source: "user" });
		await this.emit({ type: "title", title: cleanTitle });
	}

	async dispose(): Promise<void> {
		this.abort();
		// A host may delete the log as soon as disposal returns; finish any title write first.
		await this.title.pending();
		// 没人关的 fs.watch 会一直拿着描述符，而一天里会开关几十个会话。
		this.watcher?.close();
		this.watcher = null;
		await this.can.dispose();
	}
}
