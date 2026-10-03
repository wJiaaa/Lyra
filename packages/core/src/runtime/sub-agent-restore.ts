/**
 * 进程退出之后，子代理还在：从会话日志里把它们读回来。
 *
 * 登记簿只在内存里，应用一关就没了——名单是空的，`resume` 只能得到一句「上下文已经不在了」，人说
 * 「继续」之后模型只好从零重派，把读过的再读一遍。而它做过的事一直在日志里：`subagent`（派了谁、
 * 让它做什么）、每一条 `subagent_message`、它在哪压缩过、哪些调用开始了、`subagent_done`。
 *
 * 这里从那几种记录重建两样东西：名单上的一行，和续跑要的上下文。
 *
 * 上下文要和它停下前最后发出去的那份逐字相同：缓存能留多久因服务商而异，重启得快的话还在，
 * 前缀对不上就是整段按原价重算。所以按它自己跑的那个模型重建（供应商句柄留着、压缩头按那个模型
 * 拼），压缩剪过的结果从 `subagent_views` 换回剪过的那份。见 ADR-0024。
 */

import type { AgentEvent } from "../agent/events.ts";
import { environmentDate, today, withEnvironment } from "../prompt/environment.ts";
import { interruptedResult } from "../session/live-calls.ts";
import { sessionPruner } from "./aged-prune.ts";
import { stripStaleHandles } from "./model-switch.ts";
import type { Boundary, SessionRecord } from "../session/types.ts";
import { TODOS_KEY, todosFromLog } from "../tools/todo.ts";
import { addUsage, emptyUsage, type AssistantContent, type Message, type ToolResult } from "../types.ts";
import type { SubAgentConversation, SubAgentSummary } from "./sub-agents.ts";

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
type Event<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

export interface RestoredSubAgent {
	summary: SubAgentSummary;
	/** What the pane shows: the transcript as it was written. */
	messages: Message[];
	/** Absent when there is no model to rebuild a compacted history against. */
	conversation?: SubAgentConversation;
}

/**
 * How to turn a sub-agent's transcript into what the model it ran on sees: the id that model goes
 * by and the session's own `historyFrom`, bound to it. Undefined when there is no model to rebuild
 * against; the rows still come back, but none can be resumed.
 */
export type Rebuild = (ran: { provider?: string; model?: string }) => { model: string; history: (messages: Message[], boundary: Boundary | null) => Message[] } | undefined;

interface Draft {
	summary: SubAgentSummary;
	messages: Message[];
	/** The model its latest stretch ran on, as the `subagent` event names it. */
	ran: { provider?: string; model?: string };
	/** Where a resume switched models: handles before it were stripped then, so they are here too. */
	switchedAt: number;
	/** Results its compaction cut, by call id; see the `subagent_views` event. */
	views: Map<string, Message>;
	boundary: Boundary | null;
	/** Calls that got as far as `tool_start` — the ones that may have acted. */
	started: Set<string>;
	left: Map<string, ToolResult>;
	lastSeen: number;
}

/**
 * The sub-agents in `records`, oldest first, less the ones taken off the roster by hand.
 */
export function restoreSubAgents(records: readonly SessionRecord[], rebuild?: Rebuild): RestoredSubAgent[] {
	const drafts = new Map<string, Draft>();
	const dismissed = new Set<string>();
	for (const record of untruncated(records)) {
		if (record.type !== "event") continue;
		const event = record.event;
		if (event.type === "subagent") {
			dispatched(drafts, event, record.ts);
			continue;
		}
		if (event.type === "subagent_dismissed") {
			dismissed.add(event.id);
			continue;
		}
		if (event.type !== "subagent_message" && event.type !== "subagent_event" && event.type !== "subagent_done" && event.type !== "subagent_views") continue;
		const draft = drafts.get(event.id);
		if (!draft) continue;
		if (event.type === "subagent_views") {
			for (const { toolCallId, message } of event.views) draft.views.set(toolCallId, message);
			continue;
		}
		draft.lastSeen = record.ts;
		if (event.type === "subagent_message") {
			if (!event.message) continue;
			draft.messages.push(event.message);
			if (event.message.role === "assistant") draft.summary.usage = addUsage(draft.summary.usage, event.message.usage);
		} else if (event.type === "subagent_event") {
			const inner = event.event;
			// Same arithmetic as the session's own boundary (`replay-records.ts`): the tail it kept is the tail of what was written.
			if (inner.type === "compacted" && inner.kept !== undefined) draft.boundary = { at: record.ts, summary: inner.summary ?? "", keptFrom: Math.max(0, draft.messages.length - inner.kept) };
			if (inner.type === "tool_start") {
				draft.started.add(inner.toolCallId);
				draft.summary.toolCalls += 1;
				draft.summary.lastActivity = inner.summary;
			}
			if (inner.type === "tool_left") draft.left.set(inner.toolCallId, inner.result);
		} else {
			draft.summary.status = event.status;
			draft.summary.endedAt = record.ts;
			if (event.answer) draft.summary.answer = event.answer;
			if (event.error) draft.summary.error = event.error;
		}
	}

	return [...drafts.values()].filter((draft) => !dismissed.has(draft.summary.id)).map((draft) => {
		// No `subagent_done`: the process went away while it ran. Stopped, as far as anyone can tell now.
		if (draft.summary.status === "running" || draft.summary.status === "queued") {
			draft.summary.status = "aborted";
			draft.summary.endedAt = draft.lastSeen;
		}
		const target = rebuild?.(draft.ran);
		return { summary: draft.summary, messages: draft.messages, ...(target ? { conversation: conversationOf(draft, target) } : {}) };
	});
}

function dispatched(drafts: Map<string, Draft>, event: Event<"subagent">, at: number): void {
	const known = drafts.get(event.id);
	if (known) {
		// A resume: same row, running again. Its opening line arrived as a `subagent_message` just before.
		known.summary.status = "running";
		known.summary.endedAt = undefined;
		known.summary.answer = undefined;
		known.summary.error = undefined;
		known.summary.resumes = (known.summary.resumes ?? 0) + 1;
		known.lastSeen = at;
		if (event.provider !== known.ran.provider || event.model !== known.ran.model) {
			// `runSubAgent` stripped everything before this stretch's opening line, which is the last message.
			known.switchedAt = Math.max(0, known.messages.length - 1);
			known.ran = { provider: event.provider, model: event.model };
		}
		return;
	}
	const parent = event.parentId ? drafts.get(event.parentId) : undefined;
	drafts.set(event.id, {
		summary: {
			id: event.id,
			agent: event.agent,
			description: event.description,
			status: "running",
			startedAt: at,
			toolCalls: 0,
			...(event.parentId ? { parentId: event.parentId } : {}),
			depth: parent ? parent.summary.depth + 1 : 1,
			usage: emptyUsage(),
		},
		// A fresh dispatch's opening line rides in the `subagent` event itself, not as a message.
		messages: [{ role: "user", content: [{ type: "text", text: event.prompt }], timestamp: at, origin: "parent" }],
		ran: { provider: event.provider, model: event.model },
		switchedAt: 0,
		views: new Map(),
		boundary: null,
		started: new Set(),
		left: new Map(),
		lastSeen: at,
	});
}

/** Records a rewind cut off, gone — the same rule the session's own replay follows. */
function untruncated(records: readonly SessionRecord[]): SessionRecord[] {
	let kept: SessionRecord[] = [];
	for (const record of records) {
		if (record.type === "truncate") kept = kept.filter((one) => one.seq <= record.afterSeq);
		else kept.push(record);
	}
	return kept;
}

function conversationOf(draft: Draft, target: NonNullable<ReturnType<Rebuild>>): SubAgentConversation {
	const transcript = draft.switchedAt > 0 ? stripStaleHandles(draft.messages, draft.switchedAt) : draft.messages;
	const ordered = paired(transcript, draft.started, draft.left, draft.lastSeen);
	// The boundary named a position in the transcript as written; find the same message in the reordered one.
	const boundary = draft.boundary && {
		...draft.boundary,
		keptFrom: draft.boundary.keptFrom >= transcript.length ? ordered.length : Math.max(0, ordered.indexOf(transcript[draft.boundary.keptFrom]!)),
	};
	const view = withEnvironment(target.history(ordered, boundary));
	const plan = todosFromLog(ordered);
	// 读过哪些文件不带回来：进程换过，文件可能也变过，它要改哪个就先重读哪个。清单带回来——检查点上要不要接着跑，看的就是它。
	const state = new Map<string, unknown>(plan.length > 0 ? [[TODOS_KEY, plan]] : []);
	if (draft.views.size > 0) {
		const pruner = sessionPruner(state);
		for (const message of ordered) {
			const cut = message.role === "toolResult" ? draft.views.get(message.toolCallId) : undefined;
			if (cut) pruner.remember(message, cut);
		}
	}
	return { agent: draft.summary.agent, view, state, envDate: environmentDate(view) ?? today(), model: target.model };
}

/**
 * Every call answered, right after the reply that made it.
 *
 * Two things in a transcript as written break that, and a provider rejects the whole request for
 * either. Something said to it while a tool ran is written when it was said — between the call and
 * its result — while the loop only read it after the result; it goes back after the results. And a
 * call the process died during has no result at all; it gets the same "interrupted" the session's
 * own calls get on reopening, with whatever it said it leaves behind.
 */
function paired(messages: readonly Message[], started: Set<string>, left: Map<string, ToolResult>, at: number): Message[] {
	const out: Message[] = [];
	let open: ToolCall[] = [];
	let held: Message[] = [];
	const close = () => {
		for (const call of open) out.push(interruptedResult(call, started.has(call.id) ? { callId: call.id, phase: "running", output: null } : undefined, at, left.get(call.id)));
		open = [];
		out.push(...held);
		held = [];
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			close();
			out.push(message);
			open = message.content.filter((block): block is ToolCall => block.type === "toolCall");
		} else if (message.role === "toolResult") {
			out.push(message);
			open = open.filter((call) => call.id !== message.toolCallId);
			if (open.length === 0) close();
		} else if (open.length > 0) held.push(message);
		else out.push(message);
	}
	close();
	return out;
}
