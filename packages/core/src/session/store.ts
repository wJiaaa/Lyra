/**
 * Session storage: one SQLite database, `sessions.db`.
 *
 * Every session is an append-only list of records with a monotonic `seq`, and a row in `sessions`
 * holding its current meta. The two are written in the same transaction, so the list the sidebar
 * reads can never disagree with the records it summarises — which is what the JSONL files and their
 * separately rewritten `index.json` spent most of this module working around.
 *
 * Nothing is rewritten in place. An edit is a `truncate` record, a rename a `title` record; a
 * reader that has seen up to seq N asks for what came after N and replays it.
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir, uptime } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CommandRun, HookRun } from "../agent/events.ts";
import type { AssistantMessage, Message, Usage } from "../types.ts";
import { emptyUsage } from "../types.ts";
import { applyRecord, persistedPayload, recordKind } from "./apply-record.ts";
import { beforeSessionDbClose, closeSessionDb, sessionDb, transaction } from "./db.ts";
import { interruptedResult, openRound, type CallPhase, type LiveCall } from "./live-calls.ts";
import { assemblePartial, flushPendingPartials, type PartialPiece } from "./partial.ts";
import { parkRecordPayload, rehydrateMessages, slimJsonlLine } from "./payload.ts";
import { REPLAY_KINDS, replayRecords } from "./replay-records.ts";
import { auxiliaryCall, spendOf, type SpendEntry, type SpendRow } from "./spend.ts";
import type { ActiveDay, SessionStorage } from "./storage.ts";
import type { Boundary, SessionMeta, SessionRecord, SessionRecordInput } from "./types.ts";

export type { Boundary, SessionMeta, SessionRecord, SessionRecordInput } from "./types.ts";

export function plumeHome(): string {
	return process.env.PLUME_HOME || join(homedir(), ".plume");
}

export function projectIdFor(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** Records per query when streaming a session out: bounded memory, and no statement held open across an `await`. */
const READ_PAGE = 500;
/** Spend rows per `readSpend`. The table only grows, and a reader starting from 0 would otherwise take all of it at once. */
const SPEND_PAGE = 5_000;

/** Streams this process is writing right now: token to the database it writes into. See `settlePartial`. */
const liveStreams = new Map<string, string>();
/** Tool calls this process is running right now, as `callKey`s. See `settleCalls`. */
const liveCalls = new Set<string>();

function callKey(path: string, sessionId: string, callId: string): string {
	return `${path}\0${sessionId}\0${callId}`;
}

// A normal quit mid-stream writes out the last batch before the connection closes.
beforeSessionDbClose(flushPendingPartials);

/** When this machine last booted, in ms. Nothing written before it can have a live writer. */
function bootedAt(): number {
	return Date.now() - uptime() * 1000;
}

/**
 * Whether whoever wrote a row is still there to finish it: this process's own writers by what it
 * remembers, another's by its pid — unless the row predates this boot, when the pid may be anyone's.
 */
function writerAlive(row: { owner_pid: number; updated_at: number }, mine: () => boolean): boolean {
	if (row.owner_pid === process.pid) return mine();
	// A few seconds of slack: `uptime` is rounded, and a row written just after boot is live.
	if (row.updated_at < bootedAt() - 5_000) return false;
	return processAlive(row.owner_pid);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, it just is not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * What `load` reports as the session's spend.
 *
 * The replayed total, except when it comes out empty over a meta that says otherwise — a session
 * whose replies carried no usage keeps what its meta accumulated.
 */
function settledUsage(meta: Usage, replayed: Usage): Usage {
	return replayed.total > 0 || meta.total === 0 ? replayed : meta;
}

export class SessionStore implements SessionStorage {
	/** The database file. */
	readonly path: string;

	constructor(root = join(plumeHome(), "sessions")) {
		this.path = join(root, "sessions.db");
	}

	private get db(): DatabaseSync {
		return sessionDb(this.path);
	}

	/**
	 * Close this process's connection. Tests call it before removing the directory; Windows will not delete an open file.
	 *
	 * What was streaming into it ends here too. Left marked live, a stream cut off by the close was
	 * never recovered by a store reopened in this process: its pid is this one, still running.
	 */
	close(): void {
		for (const [token, path] of liveStreams) if (path === this.path) liveStreams.delete(token);
		for (const key of liveCalls) if (key.startsWith(`${this.path}\0`)) liveCalls.delete(key);
		closeSessionDb(this.path);
	}

	private metaOf(sessionId: string): SessionMeta | null {
		const row = this.db.prepare("SELECT meta FROM sessions WHERE id = ?").get(sessionId) as { meta: string } | undefined;
		return row ? (JSON.parse(row.meta) as SessionMeta) : null;
	}

	async create(cwd: string, modelId: string, title = "New session", options: Pick<SessionMeta, "thinking"> = {}): Promise<SessionMeta> {
		// One reading of the clock for the whole creation, so `createdAt`, `updatedAt` and the first record agree.
		const now = Date.now();
		const meta: SessionMeta = {
			id: randomUUID(),
			title,
			cwd,
			projectId: projectIdFor(cwd),
			projectName: basename(cwd) || cwd,
			createdAt: now,
			updatedAt: now,
			modelId,
			...(options.thinking ? { thinking: options.thinking } : {}),
			messageCount: 0,
			usage: emptyUsage(),
			seq: 0,
		};
		const db = this.db;
		return transaction(db, () => {
			db.prepare("INSERT INTO sessions (id, project_id, seq, created_at, updated_at, archived, message_count, meta) VALUES (?, ?, 0, ?, ?, 0, 0, ?)")
				.run(meta.id, meta.projectId, now, now, JSON.stringify(meta));
			return this.write(meta.id, { type: "meta", meta }, false, now) ?? meta;
		});
	}

	/**
	 * Append one record and return the meta it produced.
	 *
	 * `copy` marks history that already happened in another session (a fork): it is written like
	 * anything else, but its replies were paid for once, where they were first given.
	 *
	 * Null when the session no longer exists: a write can still be on its way when the session is
	 * deleted, and it must neither bring it back nor be reported as committed. What it spent is still
	 * kept — the call was made and billed, and deleting a conversation does not unspend its money.
	 */
	async append(meta: Pick<SessionMeta, "id">, payload: SessionRecordInput, options: { copy?: boolean; stream?: string } = {}): Promise<SessionMeta | null> {
		// Images go to files here, outside the transaction.
		const parked = parkRecordPayload(payload);
		const copy = options.copy ?? false;
		return transaction(this.db, () => {
			const next = this.write(meta.id, parked, copy, Date.now(), options.stream);
			/*
			 * A reply that asks for tools leaves its calls on record with it, before the first one starts:
			 * a process dying in between would otherwise leave no sign that they never ran. A copy is
			 * history that already played out elsewhere; nobody here is about to run it.
			 */
			if (next && !copy && parked.type === "message" && parked.message.role === "assistant") {
				for (const block of parked.message.content) if (block.type === "toolCall") this.registerCall(meta.id, block.id, "pending");
			}
			return next;
		});
	}

	/**
	 * The one place a record is written: the record, the meta row, the spend, all or nothing.
	 * `stream` is the streamed copy a reply settles; see `PartialSink`.
	 */
	private write(sessionId: string, payload: SessionRecordInput, copy: boolean, now = Date.now(), stream?: string): SessionMeta | null {
		const db = this.db;
		return transaction(db, () => {
			// Read under the write lock: whatever a caller holds may be stale, and another process may be writing too.
			const base = this.metaOf(sessionId);
			if (!base) {
				if (!copy) for (const entry of spendOf(payload, now)) this.insertSpend(sessionId, entry, now);
				return null;
			}
			const next = applyRecord(base, payload, now);
			if (next === base) return base;
			const record = { seq: next.seq, ts: now, ...persistedPayload(base, payload, next) };
			db.prepare("INSERT INTO records (session_id, seq, ts, kind, body) VALUES (?, ?, ?, ?, ?)")
				.run(sessionId, next.seq, now, recordKind(payload), JSON.stringify(record));
			db.prepare("UPDATE sessions SET project_id = ?, seq = ?, updated_at = ?, archived = ?, message_count = ?, meta = ? WHERE id = ?")
				.run(next.projectId, next.seq, next.updatedAt, next.archived ? 1 : 0, next.messageCount, JSON.stringify(next), sessionId);
			if (!copy) for (const entry of spendOf(payload, now)) this.insertSpend(sessionId, entry, now);
			// The reply is in; what was kept of it while it streamed has done its job. Only its own: a
			// stream begun since belongs to whoever took over.
			if (payload.type === "message" && payload.message.role === "assistant" && stream !== undefined) this.clearPartial(sessionId, stream);
			// Answered: the call has nothing left for a dead owner to leave behind.
			if (payload.type === "message" && payload.message.role === "toolResult") this.closeCall(sessionId, payload.message.toolCallId);
			return next;
		});
	}

	private insertSpend(sessionId: string | null, entry: SpendEntry, now: number): void {
		this.db.prepare("INSERT INTO spend (session_id, stream, kind, ts, source, provider, model, call) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			// A reply built without a provider or model (tests, synthetic messages) has undefined there, which SQLite will not bind.
			.run(sessionId, entry.stream ?? null, entry.kind, now, entry.source ?? null, entry.provider ?? null, entry.model ?? null, entry.call ? JSON.stringify(entry.call) : null);
	}

	async get(sessionId: string): Promise<SessionMeta | null> {
		return this.metaOf(sessionId);
	}

	async listSessions(): Promise<SessionMeta[]> {
		const rows = this.db.prepare("SELECT meta FROM sessions ORDER BY updated_at DESC").all() as { meta: string }[];
		return rows.map((row) => JSON.parse(row.meta) as SessionMeta);
	}

	/** Stream records, optionally only those newer than `sinceSeq`. */
	async *read(sessionId: string, sinceSeq = 0, options?: { display?: boolean }): AsyncGenerator<SessionRecord> {
		this.settle(sessionId);
		const page = this.db.prepare("SELECT seq, body FROM records WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?");
		let after = sinceSeq;
		while (true) {
			const rows = page.all(sessionId, after, READ_PAGE) as { seq: number; body: string }[];
			for (const row of rows) {
				after = row.seq;
				yield JSON.parse(options?.display ? slimJsonlLine(row.body) : row.body) as SessionRecord;
			}
			if (rows.length < READ_PAGE) return;
		}
	}

	/**
	 * Every message ever committed, in order — truncated ones included.
	 *
	 * This is "what was said", for `recall` and the memory pass; `load` is "what the conversation
	 * is now".
	 */
	async messages(sessionId: string): Promise<Message[]> {
		this.settle(sessionId);
		const rows = this.db.prepare("SELECT body FROM records WHERE session_id = ? AND kind = 'message' ORDER BY seq").all(sessionId) as { body: string }[];
		const out: Message[] = [];
		for (const row of rows) {
			const record = JSON.parse(row.body) as { message?: Message };
			if (record.message) out.push(record.message);
		}
		return out;
	}

	/** Only the kinds the transcript is built from; a turn's prompts and requests are never parsed here. */
	private replay(sessionId: string, display: boolean) {
		const marks = REPLAY_KINDS.map(() => "?").join(", ");
		const rows = this.db.prepare(`SELECT body FROM records WHERE session_id = ? AND kind IN (${marks}) ORDER BY seq`).all(sessionId, ...REPLAY_KINDS) as { body: string }[];
		return replayRecords(rows.map((row) => JSON.parse(display ? slimJsonlLine(row.body) : row.body) as SessionRecord));
	}

	async load(
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
	} | null> {
		this.settle(sessionId);
		const meta = this.metaOf(sessionId);
		if (!meta) return null;
		const replayed = this.replay(sessionId, options?.display ?? false);
		let entries = replayed.entries;
		let messages = entries.map((entry) => entry.message);
		if (!options?.display) {
			const hydrated = await rehydrateMessages(messages);
			if (hydrated !== messages) {
				messages = hydrated;
				entries = entries.map((entry, index) => ({ ...entry, message: hydrated[index] ?? entry.message }));
			}
		}
		meta.messageCount = messages.length;
		meta.usage = settledUsage(meta.usage, replayed.usage);
		return { meta, messages, entries, compactions: replayed.compactions, compaction: replayed.compaction, commandRuns: replayed.commandRuns, hookRuns: replayed.hookRuns };
	}

	/**
	 * Drop a message and everything after it.
	 *
	 * Returns the messages that survive, so the caller can reset its own in-memory copy to
	 * match without re-reading. Null when the index is out of range — a stale UI can ask to
	 * edit a message that has since been truncated by another client.
	 */
	async truncateFrom(sessionId: string, messageIndex: number): Promise<{ meta: SessionMeta; messages: Message[] } | null> {
		// The transcript is read under the write lock too: another process appending between the read and the cut would move the cut.
		const cut = transaction(this.db, () => {
			const { entries } = this.replay(sessionId, false);
			if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= entries.length) return null;

			// Never cut inside a tool-call turn: a cut on a tool result moves back past the call that produced it.
			let target = messageIndex;
			while (target > 0 && entries[target]?.message.role === "toolResult") target -= 1;
			// The seq to keep is the one just before the record carrying the doomed message.
			const truncated = this.write(sessionId, { type: "truncate", afterSeq: entries[target].seq - 1 }, false);
			if (!truncated) return null;
			const usage = settledUsage(truncated.usage, this.replay(sessionId, false).usage);
			// The meta row tracks message count; a truncate is the one write that lowers it.
			const corrected = this.write(sessionId, { type: "meta", meta: { ...truncated, messageCount: target, usage } }, false) ?? truncated;
			return { meta: { ...corrected, messageCount: target, usage }, kept: entries.slice(0, target).map((entry) => entry.message) };
		});
		if (!cut) return null;
		return { meta: cut.meta, messages: await rehydrateMessages(cut.kept) };
	}

	/** Null when there is no such session — a stale sidebar can ask about one already deleted. */
	async setArchived(sessionId: string, archived: boolean): Promise<SessionMeta | null> {
		if (!this.metaOf(sessionId)) return null;
		return this.write(sessionId, { type: "archive", archived }, false);
	}

	/**
	 * File a session under another project. Null when there is no such session.
	 *
	 * Already there is not nothing: a renamed project keeps its directory and changes its name, and
	 * that still has to be written. Only when neither changed is there nothing to record.
	 */
	async move(sessionId: string, cwd: string, projectName: string): Promise<SessionMeta | null> {
		const base = this.metaOf(sessionId);
		if (!base) return null;
		const projectId = projectIdFor(cwd);
		if (projectId === base.projectId && base.cwd === cwd && base.projectName === projectName) return base;
		return this.write(sessionId, { type: "move", cwd, projectId, projectName }, false);
	}

	async delete(sessionId: string): Promise<void> {
		await this.deleteMany([sessionId]);
	}

	/**
	 * Delete sessions, their records and anything streaming for them — not what they spent.
	 *
	 * Space is handed back to the file system straight after. Without it SQLite only marks the pages
	 * free, and "clear a range" would free nothing anyone could see.
	 */
	async deleteMany(sessionIds: string[]): Promise<void> {
		if (sessionIds.length === 0) return;
		const db = this.db;
		const streams = transaction(db, () => {
			const tokens = db.prepare("SELECT token FROM partials WHERE session_id = ?");
			const remove = db.prepare("DELETE FROM sessions WHERE id = ?");
			return sessionIds.flatMap((id) => {
				const found = (tokens.all(id) as { token: string }[]).map((row) => row.token);
				remove.run(id);
				return found;
			});
		});
		for (const token of streams) liveStreams.delete(token);
		/*
		 * In one go, on the caller's thread: measured 2026-10-01, 0.5s for 320MB and 1.7s for 1GB. In
		 * steps of `incremental_vacuum(N)` with the event loop let in between, the longest pause was
		 * still 150–670ms and the whole took three times as long, so it stays one call. If deletes that
		 * size become common, the way out is a connection on a worker thread, not smaller steps.
		 */
		db.exec("PRAGMA incremental_vacuum");
		/*
		 * The vacuum moves pages through the WAL, so right after it the WAL holds about as much as
		 * was freed (measured: 313MB after deleting 320MB). Truncating it now is what makes the space
		 * come back when the person pressed delete, rather than at some later checkpoint.
		 */
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	/**
	 * Drop sessions that were created but never used.
	 *
	 * A session with no messages holds nothing. They accumulate from any path that reserves a
	 * session up front and then sends nothing: a scheduled task that failed to start, a client that
	 * navigated away. `minAgeMs` protects one another client is about to send its first message to.
	 */
	async pruneEmpty(minAgeMs = 5 * 60_000): Promise<number> {
		const rows = this.db.prepare("SELECT id FROM sessions WHERE message_count = 0 AND created_at < ?").all(Date.now() - minAgeMs) as { id: string }[];
		await this.deleteMany(rows.map((row) => row.id));
		return rows.length;
	}

	// ---------------------------------------------------------------------------------------------
	// A reply while it streams. See `partial.ts`.
	// ---------------------------------------------------------------------------------------------

	/** Takes the place over from any stream before it, whose token from then on matches nothing. */
	async beginPartial(sessionId: string, token: string, head: AssistantMessage): Promise<void> {
		const db = this.db;
		const { replaced, started } = transaction(db, () => {
			const before = db.prepare("SELECT token FROM partials WHERE session_id = ? AND stream = 'main'").get(sessionId) as { token: string } | undefined;
			db.prepare("DELETE FROM partials WHERE session_id = ? AND stream = 'main'").run(sessionId);
			const inserted = db.prepare("INSERT INTO partials (session_id, stream, token, head, owner_pid, updated_at) SELECT id, 'main', ?, ?, ?, ? FROM sessions WHERE id = ?")
				.run(token, JSON.stringify(head), process.pid, Date.now(), sessionId).changes;
			return { replaced: before?.token, started: Number(inserted) > 0 };
		});
		if (replaced) liveStreams.delete(replaced);
		// A session deleted in the meantime gets no stream, and nothing here should claim one.
		if (started) liveStreams.set(token, this.path);
	}

	async appendPartial(sessionId: string, token: string, pieces: PartialPiece[]): Promise<void> {
		const db = this.db;
		transaction(db, () => {
			// Nothing to extend once the reply was committed, thrown away, or taken over by a newer stream.
			const known = db.prepare("SELECT COALESCE((SELECT MAX(n) FROM partial_chunks WHERE session_id = ? AND stream = 'main'), 0) AS n, EXISTS (SELECT 1 FROM partials WHERE session_id = ? AND stream = 'main' AND token = ?) AS open")
				.get(sessionId, sessionId, token) as { n: number; open: number };
			if (!known.open) return;
			db.prepare("INSERT INTO partial_chunks (session_id, stream, n, body) VALUES (?, 'main', ?, ?)").run(sessionId, known.n + 1, JSON.stringify(pieces));
			db.prepare("UPDATE partials SET updated_at = ? WHERE session_id = ? AND stream = 'main'").run(Date.now(), sessionId);
		});
	}

	async dropPartial(sessionId: string, token: string): Promise<void> {
		transaction(this.db, () => this.clearPartial(sessionId, token));
	}

	private clearPartial(sessionId: string, token: string): void {
		this.db.prepare("DELETE FROM partials WHERE session_id = ? AND stream = 'main' AND token = ?").run(sessionId, token);
		liveStreams.delete(token);
	}

	/**
	 * Commit what a dead writer left behind, as the reply it would have been had someone pressed stop.
	 *
	 * A stream is dead when it is this process's and nothing here is writing it any more, when it was
	 * last written before this machine booted, or when the process that wrote it is gone. The boot
	 * check comes before the pid: after a power cut — the case this exists for — the old pid may well
	 * belong to some other process, which kept the stream "alive" until the next turn deleted it.
	 * Checked and committed in one transaction, so two processes opening the same session cannot both
	 * commit it.
	 *
	 * Stamped with when it was last written, not now: a reply cut off on Monday and opened on
	 * Wednesday happened on Monday, and stamping it Wednesday moved the conversation to the top of the
	 * list and its activity to that day. Never earlier than the meta, which only moves forward.
	 *
	 * Its spend row is written like any reply's: the call was made and billed. The usage it carries is
	 * what the stream had reported when it stopped — the input, for providers that send it up front.
	 */
	private settlePartial(sessionId: string): void {
		const db = this.db;
		type Row = { token: string; head: string; owner_pid: number; updated_at: number };
		const probe = db.prepare("SELECT token, head, owner_pid, updated_at FROM partials WHERE session_id = ? AND stream = 'main'");
		const alive = (row: Row) => writerAlive(row, () => liveStreams.has(row.token));
		const found = probe.get(sessionId) as Row | undefined;
		if (!found || alive(found)) return;
		transaction(db, () => {
			const row = probe.get(sessionId) as Row | undefined;
			if (!row || alive(row)) return;
			const chunks = db.prepare("SELECT body FROM partial_chunks WHERE session_id = ? AND stream = 'main' ORDER BY n").all(sessionId) as { body: string }[];
			const message = assemblePartial(JSON.parse(row.head) as AssistantMessage, chunks.map((chunk) => JSON.parse(chunk.body) as PartialPiece[]));
			if (!message) return this.clearPartial(sessionId, row.token);
			this.write(sessionId, { type: "message", message }, false, Math.max(row.updated_at, this.metaOf(sessionId)?.updatedAt ?? 0), row.token);
		});
	}

	/** Whatever a dead process left half-written in this session, committed as what it amounts to. */
	private settle(sessionId: string): void {
		this.settlePartial(sessionId);
		this.settleCalls(sessionId);
	}

	// ---------------------------------------------------------------------------------------------
	// Tool calls in flight. See `live-calls.ts`.
	// ---------------------------------------------------------------------------------------------

	async openCall(sessionId: string, callId: string): Promise<void> {
		this.registerCall(sessionId, callId, "running");
	}

	private registerCall(sessionId: string, callId: string, phase: CallPhase): void {
		const inserted = this.db.prepare("INSERT OR REPLACE INTO live_calls (session_id, call_id, phase, output, owner_pid, updated_at) SELECT id, ?, ?, NULL, ?, ? FROM sessions WHERE id = ?")
			.run(callId, phase, process.pid, Date.now(), sessionId).changes;
		if (Number(inserted) > 0) liveCalls.add(callKey(this.path, sessionId, callId));
	}

	async markCall(sessionId: string, callId: string, phase: CallPhase): Promise<void> {
		this.db.prepare("UPDATE live_calls SET phase = ?, updated_at = ? WHERE session_id = ? AND call_id = ?").run(phase, Date.now(), sessionId, callId);
	}

	async saveCallOutput(sessionId: string, callId: string, output: string): Promise<void> {
		this.db.prepare("UPDATE live_calls SET output = ?, updated_at = ? WHERE session_id = ? AND call_id = ?").run(output, Date.now(), sessionId, callId);
	}

	private closeCall(sessionId: string, callId: string): void {
		this.db.prepare("DELETE FROM live_calls WHERE session_id = ? AND call_id = ?").run(sessionId, callId);
		liveCalls.delete(callKey(this.path, sessionId, callId));
	}

	/**
	 * Answer the calls a dead process left open, as what each had got to: not started, waiting for
	 * approval, or running with the output it had printed.
	 *
	 * Only when every call of the session is dead. One live call means its process is still working
	 * through the round, and the calls it has not started yet are about to be — answering them here
	 * would put results in front of the ones it is about to write.
	 *
	 * Stamped like `settlePartial`'s reply, with when the call was last heard from.
	 */
	private settleCalls(sessionId: string): void {
		const db = this.db;
		type Row = { call_id: string; phase: CallPhase; output: string | null; owner_pid: number; updated_at: number };
		const probe = db.prepare("SELECT call_id, phase, output, owner_pid, updated_at FROM live_calls WHERE session_id = ?");
		const dead = (rows: Row[]) => rows.length > 0 && !rows.some((row) => writerAlive(row, () => liveCalls.has(callKey(this.path, sessionId, row.call_id))));
		if (!dead(probe.all(sessionId) as Row[])) return;
		transaction(db, () => {
			const rows = probe.all(sessionId) as Row[];
			if (!dead(rows)) return;
			const live = new Map<string, LiveCall>(rows.map((row) => [row.call_id, { callId: row.call_id, phase: row.phase, output: row.output }]));
			const round = openRound(this.replay(sessionId, false).entries.map((entry) => entry.message));
			const calls = round?.reply.content.filter((block) => block.type === "toolCall") ?? [];
			// A round these rows are not from has moved on; they describe nothing left to answer.
			if (round && calls.some((call) => live.has(call.id))) {
				const at = Math.max(...rows.map((row) => row.updated_at), this.metaOf(sessionId)?.updatedAt ?? 0);
				for (const call of calls) {
					if (!round.answered.has(call.id)) this.write(sessionId, { type: "message", message: interruptedResult(call, live.get(call.id), at) }, false, at);
				}
			}
			db.prepare("DELETE FROM live_calls WHERE session_id = ?").run(sessionId);
		});
	}

	// ---------------------------------------------------------------------------------------------
	// Spend and space, for the settings pages.
	// ---------------------------------------------------------------------------------------------

	/** A model call that belongs to no conversation, such as the project memory pass. */
	async recordUsage(spent: { source: string; providerId: string; modelId: string; usage: Usage }): Promise<void> {
		const now = Date.now();
		this.insertSpend(null, auxiliaryCall(spent, now), now);
	}

	async storeId(): Promise<string> {
		return (this.db.prepare("SELECT value FROM info WHERE key = 'id'").get() as { value: string }).value;
	}

	async readSpend(afterId = 0): Promise<SpendRow[]> {
		const rows = this.db.prepare("SELECT id, session_id, stream, kind, ts, source, provider, model, call FROM spend WHERE id > ? ORDER BY id LIMIT ?").all(afterId, SPEND_PAGE) as {
			id: number;
			session_id: string | null;
			stream: string | null;
			kind: SpendRow["kind"];
			ts: number;
			source: string | null;
			provider: string | null;
			model: string | null;
			call: string | null;
		}[];
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			stream: row.stream,
			kind: row.kind,
			ts: row.ts,
			source: row.source,
			provider: row.provider,
			model: row.model,
			call: row.call ? JSON.parse(row.call) : null,
		}));
	}

	/**
	 * Per local day, how many conversations did anything and how many messages were written.
	 *
	 * A sub-agent reply or a side call makes the conversation active that day without being one of
	 * its messages. Deleted conversations are gone from here — this is activity, not spend.
	 */
	async activeDays(): Promise<ActiveDay[]> {
		return this.db.prepare(`
			SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
				COUNT(DISTINCT session_id) AS sessions,
				SUM(kind = 'message') AS messages
			FROM records WHERE kind IN ('message', 'usage', 'subagent_message')
			GROUP BY day ORDER BY day
		`).all() as unknown as ActiveDay[];
	}

	/** Bytes of records per session: what deleting it gives back. */
	async sizes(): Promise<Record<string, number>> {
		const rows = this.db.prepare("SELECT session_id, SUM(length(CAST(body AS BLOB))) AS bytes FROM records GROUP BY session_id").all() as { session_id: string; bytes: number }[];
		return Object.fromEntries(rows.map((row) => [row.session_id, row.bytes]));
	}
}
