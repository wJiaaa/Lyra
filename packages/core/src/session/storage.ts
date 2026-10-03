/**
 * What a session store has to be able to do.
 *
 * Extracted from the class rather than designed ahead of it. Naming it is what lets a session be
 * kept somewhere else without the runtime knowing which.
 *
 * The append-only contract is part of the interface, not an implementation detail. Callers rely on
 * `append` never rewriting history and on `read` replaying it in order; a store that edited its
 * records in place would satisfy the types and break every reader catching up by `seq`.
 */

import type { Message, Usage } from "../types.ts";
import type { CommandRun, HookRun } from "../agent/events.ts";
import type { CallSink } from "./live-calls.ts";
import type { PartialSink } from "./partial.ts";
import type { SpendRow } from "./spend.ts";
import type { Boundary, SessionMeta, SessionRecord, SessionRecordInput } from "./types.ts";

/** One local day of activity. */
export interface ActiveDay {
	/** `YYYY-MM-DD`, local. */
	day: string;
	/** Conversations that said or heard anything that day. */
	sessions: number;
	/** Messages on both sides. */
	messages: number;
}

export interface SessionStorage extends PartialSink, CallSink {
	/** `options.thinking` is written into the first record; see `SessionMeta.thinking` for why every new session gets one. */
	create(cwd: string, modelId: string, title?: string, options?: Pick<SessionMeta, "thinking">): Promise<SessionMeta>;
	/**
	 * Add one record and return the meta it produced. Never rewrites what is already there.
	 * `copy` marks history carried over from another session, whose cost was counted there.
	 * Null when the session is gone: nothing was committed, though what the record spent is kept.
	 * `stream` is the streamed copy a reply settles, dropped with it; no other stream is touched.
	 */
	append(meta: Pick<SessionMeta, "id">, payload: SessionRecordInput, options?: { copy?: boolean; stream?: string }): Promise<SessionMeta | null>;
	get(sessionId: string): Promise<SessionMeta | null>;
	read(sessionId: string, sinceSeq?: number, options?: { display?: boolean }): AsyncGenerator<SessionRecord>;
	messages(sessionId: string): Promise<Message[]>;
	/** The records a session's sub-agents left, in order — see `runtime/sub-agent-restore.ts`. */
	subAgentRecords(sessionId: string): Promise<SessionRecord[]>;
	load(
		sessionId: string,
		options?: { display?: boolean },
	): Promise<{
		meta: SessionMeta;
		messages: Message[];
		entries: { seq: number; message: Message }[];
		compactions: number[];
		commandRuns?: CommandRun[];
		hookRuns?: HookRun[];
		compaction: Boundary | null;
	} | null>;
	/** Most recently used first. */
	listSessions(): Promise<SessionMeta[]>;
	truncateFrom(sessionId: string, messageIndex: number): Promise<{ meta: SessionMeta; messages: Message[] } | null>;
	setArchived(sessionId: string, archived: boolean): Promise<SessionMeta | null>;
	/** Re-file a session under another project: a new `cwd`, and with it a new `projectId`. */
	move(sessionId: string, cwd: string, projectName: string): Promise<SessionMeta | null>;
	delete(sessionId: string): Promise<void>;
	deleteMany(sessionIds: string[]): Promise<void>;
	pruneEmpty(minAgeMs?: number): Promise<number>;
	/** A model call that belongs to no conversation. */
	recordUsage(spent: { source: string; providerId: string; modelId: string; usage: Usage }): Promise<void>;
	/**
	 * Billed calls and prefix boundaries after `afterId`, deleted conversations included, in id order
	 * and a page at a time: read on from the last id until a page comes back empty.
	 */
	readSpend(afterId?: number): Promise<SpendRow[]>;
	/** Names this store. A `readSpend` cursor kept anywhere else means nothing against another one. */
	storeId(): Promise<string>;
	activeDays(): Promise<ActiveDay[]>;
	/** Bytes each session's records take. */
	sizes(): Promise<Record<string, number>>;
}
