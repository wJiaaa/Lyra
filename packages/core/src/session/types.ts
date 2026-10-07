/**
 * The shapes a session is stored in, apart from the store that stores them.
 *
 * Kept out of `store.ts` so the pure pieces the store is built from — applying a record, replaying
 * a transcript, reading spend off a record — can name them without importing the store.
 */

import type { AgentEvent } from "../agent/events.ts";
import type { Message, ThinkingLevel, Usage } from "../types.ts";

/**
 * What the conversation looked like when its recap was written.
 *
 * `covered` is how many transcript messages it accounts for and `coveredAt` the timestamp of the
 * last of them: a length alone cannot tell a transcript that grew from one that was rewound and
 * grew back to the same length.
 */
export interface SessionRecap {
	text: string;
	covered: number;
	coveredAt: number;
	at: number;
}

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
	/** The last recap written for a person coming back to this conversation. See `runtime/session-recap.ts`. */
	recap?: SessionRecap;
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
	 * A recap was asked for. Carries its own usage because it was billed, and `text` is absent when
	 * the call came back with nothing usable — the cost still counts, the old recap stays.
	 *
	 * Not a `usage` record plus a `meta` write: both move `updatedAt`, and the recap is generated
	 * when someone *opens* a conversation. Looking at one must not lift it to the top of the list.
	 */
	| { seq: number; ts: number; type: "recap"; text?: string; covered: number; coveredAt: number; providerId: string; modelId: string; usage: Usage }
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
