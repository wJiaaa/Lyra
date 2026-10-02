/**
 * What a session has written down.
 *
 * The transcript in memory and the append-only log on disk are the same history seen twice, and
 * keeping them together is what stops them disagreeing: every message goes through `commit`, every
 * event that outlives its window goes through `emit`, and neither can be done by reaching past
 * this object.
 *
 * It is also where the two de-duplication rules live, both of which exist because the same thing
 * arrives twice by design rather than by accident.
 */

import { completedCompaction, interruptedCompaction } from "./compaction-lifecycle.ts";
import { refreshMemorySnapshot } from "./memory-inject.ts";
import type { PromptContext } from "../prompt/context.ts";
import { promptBase } from "../prompt/update.ts";
import type { AgentEvent, AgentEventSink, CommandRun, HookRun } from "../agent/events.ts";
import type { SessionMeta, SessionRecordInput } from "../session/store.ts";
import type { SessionStorage } from "../session/storage.ts";
import type { Boundary } from "../session/types.ts";
import { OUTPUT_SAVE_MS, KEPT_OUTPUT_CHARS, progressText } from "../session/live-calls.ts";
import { PartialWriter } from "../session/partial.ts";
import { parkMessage, rehydrateMessages } from "../session/payload.ts";
import type { LlmContext, Message, ModelConfig } from "../types.ts";

/** A session's own context carries every field; only a sub-agent's, nested in `subagent_event`, has no sections. */
export type RecordedContext = Required<Extract<AgentEvent, { type: "context" }>>;
export interface RequestContext {
	context: LlmContext;
	model: ModelConfig;
}

/**
 * Events that outlive the window they were shown in.
 *
 * The log is meant to answer "what did the model actually see, and why did it do that" long after
 * the run — so anything that changes the model's input, or that happened out of view, is kept.
 * Token deltas and repeated partial output stay live-only; execution boundaries and nested
 * transcripts survive without bloating the model history.
 */
const PERSISTED_EVENTS = new Set<AgentEvent["type"]>(["command_status", "compacted", "context", "subagent", "subagent_done", "subagent_message", "subagent_event", "agent_start", "agent_end", "turn_start", "tool_start", "request", "approval_request", "retry", "retry_settled", "notice"]);

export class SessionLog {
	/**
	 * The transcript, in order, complete. Replaced wholesale only by `restore`.
	 *
	 * Complete even after compaction: what compaction changes is which of these the *model* is
	 * given, never what the session remembers. The window scrolls back through all of it, `recall`
	 * searches all of it, and a later replay of the log is unaffected.
	 */
	messages: Message[] = [];
	commandRuns: CommandRun[] = [];
	/** 钩子的执行记录，和 `commandRuns` 同理：运行中的会话从内存读，`store.load` 从日志重建同一份。 */
	hookRuns: HookRun[] = [];
	meta!: SessionMeta;

	/**
	 * Where the model's view of this session begins, and what stands in for everything before it.
	 *
	 * This is the whole of what makes compaction durable. It used to live in the running loop's own
	 * array and nowhere else, so the next prompt rebuilt its history from `messages` — every
	 * original message, in full — and compacted again from nothing. A conversation could not get
	 * smaller than the log, and the log only grows.
	 *
	 * `keptFrom` indexes into `messages`; `summary` is empty when history was dropped without one,
	 * which is a different thing to say and needs saying.
	 */
	compaction: Boundary | null = null;

	/**
	 * Every place history was summarised, as positions in `messages` — the marks the window draws.
	 *
	 * Not the same thing as `compaction` above, despite the names sitting next to each other.
	 * That one is the model's view: the single newest boundary, because each summary stands in for
	 * the one before it. This is the reader's: every boundary the session has ever crossed, because
	 * scrolling back through a long transcript should show where each one happened.
	 *
	 * Kept here because a running session is read from memory, not from disk. `store.load` rebuilds
	 * the same list while replaying the log, but `snapshot` never opens the log — so without this
	 * the marks vanished the moment a session started running and came back when it stopped, which
	 * is exactly backwards from when a long turn most wants to show them.
	 */
	compactions: number[] = [];

	/**
	 * Messages already appended, tracked by identity.
	 *
	 * A prompt sent while the agent is idle is committed straight away; a steering message is
	 * queued instead and only reaches the transcript when the loop injects it. Both paths end at
	 * `message_end`, so committing there and de-duplicating by identity keeps steering messages in
	 * the log — and in the right position, after the turn they interrupted.
	 */
	private committed = new WeakSet<Message>();
	private readonly nestedCommitted = new Map<string, WeakSet<Message>>();

	/** What the last recorded context looked like, so an unchanged one is not written twice. */
	private lastContext: string | null = null;
	private recordedContext: RecordedContext | null = null;
	private contextLoaded = false;
	private contextRevision = 0;
	/** 最近记录的上下文之后又压缩过：它不再是冻结的那份，下一轮重新生成。 */
	private contextStale = false;
	/** 会话内冻结的 system prompt（中间件之前），见 `frozenPrompt`。 */
	private prompt: PromptContext | null = null;
	/** 历史是从日志载入的（`restore`）。没载入过的会话，日志里有的都经过这里写下，不必读盘。 */
	private restored = false;
	requestContext: RequestContext | null = null;

	private readonly store: SessionStorage;
	private readonly sink: AgentEventSink;
	/** The reply streaming right now, written as it arrives so a crash does not take all of it. */
	private readonly partial: PartialWriter;
	/** When each running call's output was last written down; see `OUTPUT_SAVE_MS`. */
	private readonly outputSaved = new Map<string, number>();

	// Assigned here rather than as parameter properties: Node's type stripping runs the source
	// as-is and cannot rewrite a constructor parameter into a field.
	constructor(store: SessionStorage, sink: AgentEventSink, meta?: SessionMeta) {
		this.store = store;
		this.sink = sink;
		if (meta) this.meta = meta;
		this.partial = new PartialWriter(store, () => this.meta.id);
	}

	/** Append a message to the transcript and the log exactly once. */
	async commit(message: Message): Promise<void> {
		if (this.committed.has(message)) return;
		this.committed.add(message);
		this.messages.push(message);
		try {
			// A reply settles this writer's stream, and only that one.
			const stream = message.role === "assistant" ? this.partial.stream ?? undefined : undefined;
			this.meta = (await this.store.append(this.meta, { type: "message", message }, stream ? { stream } : undefined)) ?? this.meta;
		} catch (error) {
			/*
			 * A reply that did not get written is not in the transcript either, and its stream stays
			 * as it was: still saving what is waiting, still there for `settleOrphan` to commit as a
			 * stopped reply, and still on disk if the process dies first. Forgetting it before the
			 * write, as this once did, lost the last batch and left nothing to retry with.
			 */
			if (message.role === "assistant") {
				this.committed.delete(message);
				const at = this.messages.lastIndexOf(message);
				if (at >= 0) this.messages.splice(at, 1);
			}
			throw error;
		}
		// The store dropped the streamed copy in the same transaction that wrote the reply.
		if (message.role === "assistant") this.partial.settle();
		if (message.role === "toolResult") this.outputSaved.delete(message.toolCallId);
		if (this.requestContext && !this.requestContext.context.messages.includes(message)) this.requestContext.context.messages.push(message);
	}

	/**
	 * Send an event on, and write it down if it is one of the few that has to survive.
	 *
	 * What the model was told, what was summarised away, what a sub-agent was sent off to do —
	 * none of it can be recovered from the messages alone, so it is written as it happens.
	 */
	async emit(event: AgentEvent): Promise<void> {
		// Some messages are committed first and announced after; those have nothing left to stream.
		if (event.type === "message_start" && event.message.role === "assistant" && this.meta && !this.committed.has(event.message)) await this.partial.begin(event.message);
		if (event.type === "message_update" && this.meta) await this.partial.update(event.message);
		if (this.meta) await this.trackCall(event);
		if (event.type === "subagent_message") {
			let seen = this.nestedCommitted.get(event.id);
			if (!seen) { seen = new WeakSet(); this.nestedCommitted.set(event.id, seen); }
			if (seen.has(event.message)) return;
			seen.add(event.message);
		}
		// Automatic operations use the full transcript position, not the already compacted window.
		if (event.type === "command_status" && event.command.automatic) {
			const command = event.command;
			event = { ...event, command: { ...command, at: this.commandRuns.find(run => run.id === command.id)?.at ?? this.messages.length } };
		}
		if (event.type === "compacted" && event.command) {
			const command = event.command;
			event = { ...event, command: { ...command, at: this.commandRuns.find(run => run.id === command.id)?.at ?? this.messages.length } };
		}
		if (event.type === "hook_run") {
			const run = event.run;
			const at = this.hookRuns.findIndex((known) => known.id === run.id);
			const stamped = { ...run, at: at >= 0 ? this.hookRuns[at].at : this.messages.length };
			event = { ...event, run: stamped };
			if (at < 0) this.hookRuns.push(stamped); else this.hookRuns[at] = stamped;
			// 只落终态：「开始了」对一份事后读的记录没有信息量，终态才说得出它拦没拦、为什么。
			if (stamped.status !== "running" && this.meta) this.meta = (await this.store.append(this.meta, { type: "event", event })) ?? this.meta;
		}
		if (PERSISTED_EVENTS.has(event.type) && this.meta) {
			this.meta = (await this.store.append(this.meta, { type: "event", event })) ?? this.meta;
		}
		if (event.type === "command_status") {
			const at = this.commandRuns.findIndex((run) => run.id === event.command.id);
			if (at < 0) this.commandRuns.push(event.command); else this.commandRuns[at] = event.command;
		}
		if (event.type === "agent_end") this.commandRuns = this.commandRuns.map(run => run.automatic && run.status === "running" ? interruptedCompaction(run) : run);
		// A failed append must leave the last durable model view in force.
		if (event.type === "compacted" && event.kept !== undefined) {
			this.requestContext = null;
			this.markCompaction(event.summary ?? "", event.kept);
			// 压缩反正要重写前缀：冻结的 system prompt 在这里作废，下一轮按当前状态重新生成。
			this.prompt = null;
			this.contextStale = true;
			// 新的那份即使和旧的一字不差也要落一条，重启后才认得出它是压缩之后的。
			this.lastContext = null;
			// 摘要可能把 `learn` 的调用和结果一起折叠掉了，冻结的记忆快照在这里补上它。
			this.refreshMemory();
			const at = this.commandRuns.findIndex((run) => run.id === event.commandId);
			if (at >= 0) this.commandRuns[at] = event.command ?? completedCompaction(this.commandRuns[at], event.before, event.after);
		}
		await this.sink(event);
	}

	/** How far each tool call has got, kept so a process that dies mid-call leaves a fact behind. See `live-calls.ts`. */
	private async trackCall(event: AgentEvent): Promise<void> {
		const id = this.meta.id;
		if (event.type === "tool_start") return this.store.openCall(id, event.toolCallId);
		if (event.type === "tool_phase") return this.store.markCall(id, event.toolCallId, event.phase);
		if (event.type !== "tool_update") return;
		// Throttled rather than every update: a chatty command reports ten times a second.
		const now = Date.now();
		if (now - (this.outputSaved.get(event.toolCallId) ?? 0) < OUTPUT_SAVE_MS) return;
		this.outputSaved.set(event.toolCallId, now);
		await this.store.saveCallOutput(id, event.toolCallId, progressText(event.partial.content).slice(-KEPT_OUTPUT_CHARS));
	}

	/** A reply that started and was thrown away rather than committed: nothing of it is to be recovered. */
	discardPartial(): Promise<void> {
		return this.partial.discard();
	}

	/**
	 * A reply still streaming when its turn ended: the turn threw before `message_end`.
	 *
	 * Committed as the reply a stop would have produced and announced like any other, so the
	 * transcript, the window and the store stay one-to-one. Left alone, this process kept the stream
	 * marked as live — no read would recover it — and the next turn's `beginPartial` deleted it.
	 */
	async settleOrphan(): Promise<void> {
		if (!this.partial.streaming) return;
		const reply = this.partial.stopped();
		if (!reply) return this.partial.discard();
		await this.commit(reply);
		await this.emit({ type: "message_end", message: reply });
	}

	/** Every message this session ever committed, truncated ones included, from its own store. */
	transcript(): Promise<Message[]> {
		return this.store.messages(this.meta.id);
	}

	/**
	 * Write down what the model is about to be given, the first time it looks like this.
	 *
	 * Returns the prompt so it can wrap the call that produced it — the point is that there is no
	 * way to build a prompt and forget to record it. Unchanged context is not re-recorded: a
	 * hundred-turn run would otherwise carry a hundred copies of the same system prompt.
	 */
	async recordContext(systemPrompt: string, toolNames: string[], skillNames: string[], schemas: import("../types/tool.ts").ToolSpec[], details: Pick<RecordedContext, "sections" | "mcpTools">): Promise<string> {
		const tools = [...toolNames].sort();
		const skills = [...skillNames].sort();
		const fingerprint = `${systemPrompt}\0${tools.join(",")}\0${skills.join(",")}\0${JSON.stringify(schemas)}\0${JSON.stringify(details)}`;
		if (fingerprint === this.lastContext) return systemPrompt;
		const event: RecordedContext = { type: "context", systemPrompt, tools, skills, schemas, ...details };
		await this.emit(event);
		this.recordedContext = event;
		this.contextLoaded = true;
		this.contextStale = false;
		this.lastContext = fingerprint;
		return systemPrompt;
	}

	captureRequest(context: LlmContext, model: ModelConfig): void {
		// Messages are immutable once committed; copy the array before the loop appends to it.
		this.requestContext = { context: { ...context, messages: [...context.messages], tools: structuredClone(context.tools) }, model };
	}

	/** Reuse the durable prompt after restart, including sources that have since changed on disk. */
	async readContext(): Promise<RecordedContext | null> {
		if (this.contextLoaded) return this.recordedContext;
		const revision = this.contextRevision;
		const contexts: { seq: number; event: RecordedContext }[] = [];
		// 压缩边界的位置，和上下文一样按截断回退：被撤回的压缩不算数。
		const boundaries: number[] = [];
		for await (const record of this.store.read(this.meta.id)) {
			if (record.type === "event" && record.event.type === "context") contexts.push({ seq: record.seq, event: record.event as RecordedContext });
			if (record.type === "event" && record.event.type === "compacted" && record.event.kept !== undefined) boundaries.push(record.seq);
			if (record.type === "truncate") {
				while (contexts.length && contexts.at(-1)!.seq > record.afterSeq) contexts.pop();
				while (boundaries.length && boundaries.at(-1)! > record.afterSeq) boundaries.pop();
			}
		}
		// A rewind may invalidate the disk read even when no newer request has finished yet.
		if (revision !== this.contextRevision) return this.readContext();
		// A request can finish while disk history is being read; its newer snapshot wins.
		if (!this.contextLoaded) {
			const latest = contexts.at(-1);
			this.recordedContext = latest?.event ?? null;
			// 读盘期间在内存里压缩过的，那一次也算。
			this.contextStale ||= latest !== undefined && (boundaries.at(-1) ?? -1) > latest.seq;
			this.contextLoaded = true;
		}
		return this.recordedContext;
	}

	/**
	 * 会话内冻结的 system prompt；null 表示该重新生成一份（新会话、压缩之后、撤回到它之前）。
	 *
	 * 持久化不另开记录：每轮发出去的 system prompt 本来就作为 `context` 事件记在日志里，冻结之后
	 * 那就是同一份，重启后取最近一条、去掉中间件那部分就是原样的字节（`promptBase`）。撤回截掉的
	 * 上下文跟着失效，退回更早那条——那条正是截断之后剩下的历史当时配着发的。
	 */
	async frozenPrompt(): Promise<PromptContext | null> {
		if (this.prompt) return this.prompt;
		const recorded = this.restored ? await this.readContext() : this.recordedContext;
		if (!recorded || this.contextStale) return null;
		this.prompt = promptBase(recorded);
		return this.prompt;
	}

	/** 从这一轮起冻结 `prompt`，直到下一次压缩或撤回。 */
	freezePrompt(prompt: PromptContext): void {
		this.prompt = prompt;
	}

	/**
	 * Append anything else the log carries — a new title, a chosen model.
	 *
	 * The returned meta replaces the one held here, because appending is what advances it. A session
	 * deleted under a running turn returns none, and the last one known stays.
	 */
	async append(record: SessionRecordInput): Promise<void> {
		this.meta = (await this.store.append(this.meta, record)) ?? this.meta;
	}

	/**
	 * 压缩采纳的已发视图写进日志（`AgedToolPruner.onAdopt`）。
	 *
	 * 不等它写完：采纳发生在压缩边界写盘之后、同步调用里。存储层的追加队列按调用顺序排，所以它
	 * 仍然落在边界之后、下一条消息之前。
	 */
	recordViews(views: { source: Message; view: Message }[]): void {
		const records = views.flatMap(({ source, view }) => {
			const at = this.messages.indexOf(source);
			return at < 0 ? [] : [{ at, message: parkMessage(view) }];
		});
		if (records.length === 0 || !this.meta) return;
		void this.append({ type: "views", views: records }).catch(() => {});
	}

	/**
	 * 从日志读回的已发视图，按位置对上当前历史里的原文。只在载入之后有意义；截断照 `load` 的规矩退回。
	 */
	async restoredViews(): Promise<{ source: Message; view: Message }[]> {
		if (!this.restored) return [];
		const seqs: number[] = [];
		const views = new Map<number, { seq: number; message: Message }>();
		for await (const record of this.store.read(this.meta.id)) {
			if (record.type === "message") { if (record.message) seqs.push(record.seq); }
			else if (record.type === "views") for (const view of record.views) views.set(view.at, { seq: record.seq, message: view.message });
			else if (record.type === "truncate") {
				while (seqs.length && seqs.at(-1)! > record.afterSeq) seqs.pop();
				for (const [at, view] of views) if (view.seq > record.afterSeq || at >= seqs.length) views.delete(at);
			}
		}
		const found = [...views].filter(([at]) => at < this.messages.length);
		const hydrated = await rehydrateMessages(found.map(([, view]) => view.message));
		return found.map(([at], index) => ({ source: this.messages[at], view: hydrated[index] }));
	}

	/** 快照按会话 id 冻结，见 `memory-inject.ts`。 */
	private refreshMemory(): void {
		if (this.meta) refreshMemorySnapshot(this.meta.id);
	}

	/**
	 * Record where history was summarised, so the next turn starts from the summary.
	 *
	 * Takes a count rather than an index because the array compaction worked on is the running
	 * loop's — already compacted, possibly more than once — while the boundary belongs to this log,
	 * which holds every original message. "The last N still apply" is the one statement that means
	 * the same thing in both.
	 */
	private markCompaction(summary: string, kept: number): void {
		this.compaction = { at: Date.now(), summary, keptFrom: Math.max(0, this.messages.length - kept) };
		/*
		 * Counted when the `compacted` event is written, which is what keeps this in step with the
		 * list `store.load` builds while replaying: there the mark is `entries.length` at the moment
		 * the event is read back, and every message committed before it is already in both.
		 */
		this.compactions.push(this.messages.length);
	}

	/**
	 * Adopt a history read back from disk.
	 *
	 * These messages are already in the log — that is where they came from — so they are not
	 * committed again, and nothing here is written.
	 */
	restore(messages: Message[], compaction: Boundary | null = null, compactions: number[] = []): void {
		// 载入、撤回、换模型都会换掉历史：历史里的 `learn` 结果可能没了，记忆快照跟着刷新。
		this.refreshMemory();
		this.requestContext = null;
		this.recordedContext = null;
		this.contextLoaded = false;
		// 截断可能截掉了冻结那份对应的上下文，从日志重新认一遍。
		this.contextStale = false;
		this.prompt = null;
		this.restored = true;
		this.contextRevision++;
		this.lastContext = null;
		this.messages = messages;
		this.committed = new WeakSet(messages);
		this.compaction = compaction;
		// Positions into the array being adopted, so anything past its end is a mark for messages
		// that are no longer here — a rewound tail, or a log the caller read only part of.
		this.compactions = compactions.filter((at) => at <= messages.length);
	}

	/**
	 * Discard everything from `index` on — in the log first.
	 *
	 * If the run that follows fails, the history is still the shortened, consistent one rather than
	 * a mix of old and new. Null when there was nothing there to cut.
	 */
	async truncateFrom(index: number): Promise<boolean> {
		const truncated = await this.store.truncateFrom(this.meta.id, index);
		if (!truncated) return false;
		this.meta = truncated.meta;
		// 存储层会把落在工具结果上的截断点往前挪（不拆开调用和结果），按它实际截到的位置算，和重新载入时一致。
		const cut = truncated.messages.length;
		/*
		 * A rewind past the compaction boundary retires it.
		 *
		 * The boundary says "the model sees the summary, then everything from here on". Cut the
		 * history back to before that point and there is no "from here on" left — the summary would
		 * be standing in for messages that are themselves now gone, and the kept tail it was paired
		 * with no longer exists. Going back to the full history is correct and costs one compaction
		 * next time the window fills.
		 *
		 * 截在边界上（编辑保留尾部的第一条，常见）不算越过：摘要覆盖的消息都还在，只是尾部空了。
		 * 同 `store.ts` 载入时的判断，否则运行中退回完整历史、重启后却是摘要。
		 */
		const boundary = this.compaction && cut >= this.compaction.keptFrom ? this.compaction : null;
		this.commandRuns = this.commandRuns.filter((run) => run.at <= cut);
		this.hookRuns = this.hookRuns.filter((run) => run.at <= cut);
		// The marks live at positions too, so a cut tail takes the ones inside it — same rule as the runs above.
		this.restore(truncated.messages, boundary, this.compactions.filter((at) => at <= cut));
		return true;
	}
}
