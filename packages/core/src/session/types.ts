/**
 * The shapes a session is stored in, apart from the store that stores them.
 *
 * Kept out of `store.ts` so the pure pieces the store is built from — applying a record, replaying
 * a transcript, reading spend off a record — can name them without importing the store.
 */

import type { AgentEvent } from "../agent/events.ts";
import type { Message, ThinkingLevel, Usage } from "../types.ts";

export interface SessionMeta {
	id: string;
	title: string;
	cwd: string;
	projectId: string;
	projectName: string;
	createdAt: number;
	updatedAt: number;
	modelId: string;
	messageCount: number;
	usage: Usage;
	/**
	 * Messages a person sent: the length of the conversation as anyone would count it. `messageCount`
	 * also counts every reply and tool result, so one turn that ran forty tools read as eighty-odd.
	 *
	 * Absent on sessions written before it existed, until `listSessions` fills it in from the log.
	 */
	turns?: number;
	/**
	 * What the main conversation's own replies spent: `usage` without sub-agents and side calls.
	 *
	 * The cache hit rate is read off this. Those other calls each start a prefix of their own, so
	 * mixed in they pull the rate down, and they hide the one question it answers — whether the
	 * conversation's prefix keeps being reused. Absent on old sessions, like `turns`.
	 */
	replyUsage?: Usage;
	/** 主对话里模型回了几次，一次请求一步；子智能体内部的来回不算。缺省同 `turns`。 */
	steps?: number;
	/** `usage` 里子智能体花掉的那部分，卡片据此把用量拆开。缺省同 `turns`。 */
	subagentUsage?: Usage;
	/**
	 * 这个会话旁边所有侧边聊天的用量之和。
	 *
	 * 侧边聊天是自己的会话，花的记在自己的 `usage` 上；只有不带子会话的 `listSessions` 在返回时算上，
	 * 不写盘——侧边聊天关掉就连记录一起删了，存一份在父会话上只会和它对不上。
	 */
	sideUsage?: Usage;
	archived?: boolean;
	/** A submitted opening message is durable before its runtime is initialized. */
	pendingPrompt?: boolean;
	/** Desktop workspace preparation is deferred until execution, never transcript reading. */
	workspaceSetup?: "worktree";
	/**
	 * How many messages were already written when the model was last changed mid-conversation.
	 *
	 * Everything before this index was produced by a different model, and carries that provider's
	 * opaque handles — an Anthropic thinking signature, a Responses reasoning item id, an encrypted
	 * payload. They are only meaningful to the provider that issued them; replayed to another they
	 * are rejected, not ignored. See `stripStaleHandles`.
	 *
	 * Absent on a session whose model never changed, which is the ordinary case and behaves exactly
	 * as before.
	 */
	modelSwitchedAt?: number;
	/**
	 * How hard this conversation asks the model to think.
	 *
	 * Per session because that is the unit the decision belongs to: one conversation is a long
	 * refactor worth paying `high` for and the next is "what does this flag do". Held globally,
	 * turning one up turned all of them up — including the ones already running somewhere else,
	 * which is a bill nobody agreed to.
	 *
	 * Written when the session is created, with the app default of that moment (`create`). It used
	 * to stay absent until someone changed it inside the conversation, so that a session nobody had
	 * an opinion about would follow the default as it moved. Seen from the window there is no such
	 * session: the level picked in a new chat before its first message is an opinion about that
	 * chat, yet it can only land on the app default — there is no session to hold it yet — and the
	 * session was then created without it. Picking a level in the next new chat moved the first one
	 * along, in its label and in what its turns actually asked for (reported against 0.9.19). The
	 * default is where new conversations start, not a dial for the ones already under way.
	 *
	 * Absent now only after `setThinking(null)`, which means "whatever the settings say".
	 */
	thinking?: ThinkingLevel;
	/**
	 * Someone typed this title, so nothing else gets to replace it.
	 *
	 * The first prompt names the conversation after itself, which is the right default for the
	 * conversations nobody names — and wrong for every one somebody did. Naming a session before
	 * asking anything is the ordinary way to use it, and the automatic title landed on top of the
	 * name a moment later: the rename looked like it had worked, right up until the first message.
	 */
	titleSetByUser?: boolean;
	/**
	 * 这是哪个会话的侧边聊天。
	 *
	 * 侧边聊天是一个完整的会话——同样的循环、工具、审批和记录——只是挂在另一个会话旁边：不进
	 * 会话列表，跟着父会话删除，提问时读得到父会话。见 `runtime/side-session.ts`。
	 */
	parentId?: string;
	/**
	 * 父会话旁边的哪一格：面板自己的 id（最早那一格是 `default`）。
	 *
	 * 面板的开关、多开、弹出窗口都按这个 id 走，和会话 id 无关——会话到第一次提问时才建。
	 */
	sideId?: string;
	/** Highest sequence number written. Readers compare against this. */
	seq: number;
}

export type SessionRecord =
	| { seq: number; ts: number; type: "meta"; meta: SessionMeta }
	| { seq: number; ts: number; type: "message"; message: Message }
	| { seq: number; ts: number; type: "event"; event: AgentEvent }
	| { seq: number; ts: number; type: "title"; title: string; source?: "user" | "auto" }
	| { seq: number; ts: number; type: "usage"; source: "title-summary" | "side-chat" | "compaction" | "memory-extract" | (string & {}); providerId: string; modelId: string; usage: Usage }
	/**
	 * Its own record type rather than a `meta` write: archiving must not touch `updatedAt`,
	 * and a `meta` record always refreshes it. Sending it through the log also means a reader
	 * catching up from seq N learns the session was archived, same as any other change.
	 */
	| { seq: number; ts: number; type: "archive"; archived: boolean }
	/**
	 * Filed under another project: `cwd`, `projectId` and `projectName` change together.
	 *
	 * Its own record rather than a `meta` write for the same reason as `archive`: re-filing a
	 * conversation is not activity, and `updatedAt` must not jump — otherwise a session untouched for
	 * half a year leaps to the top of the list because someone tidied it.
	 */
	| { seq: number; ts: number; type: "move"; cwd: string; projectId: string; projectName: string }
	/**
	 * Tool results compaction rewrote and sent in that form: `at` is the original's position in the
	 * transcript, `message` what was sent.
	 *
	 * The log keeps only originals; the model saw these. Without them, a restart rebuilds from the
	 * originals and the prefix sent next time changes. The later record for a position wins (a later
	 * compaction cut again on top of the earlier one). See `AgedToolPruner`.
	 */
	| { seq: number; ts: number; type: "views"; views: { at: number; message: Message }[] }
	/**
	 * Everything after `afterSeq` is void.
	 *
	 * Editing a message rewrites history — the reply it drew, and everything that followed,
	 * no longer follows from what was said. Recorded rather than achieved by deleting rows,
	 * so the log stays append-only and a reader catching up from seq N finds out the same
	 * way it finds out about anything else.
	 */
	| { seq: number; ts: number; type: "truncate"; afterSeq: number };

/**
 * Where the model's view of a session begins, once history has been summarised.
 *
 * `keptFrom` indexes into the restored message list; `summary` stands in for everything before it,
 * and is empty when that history was dropped rather than condensed — which is a different thing to
 * tell the model, and so a difference worth storing.
 */
export interface Boundary {
	/** Stable rewrite time; retained replies describe the old request until a newer reply arrives. */
	at: number;
	summary: string;
	keptFrom: number;
}

/** `Omit` over a union collapses it into one shape; distribute so each variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A record as supplied by callers, before the store stamps `seq` and `ts`. */
export type SessionRecordInput = DistributiveOmit<SessionRecord, "seq" | "ts">;
