/**
 * The session database: one SQLite file, one connection per process.
 *
 * `node:sqlite` rather than a dependency for the reason `documents.ts` gives on the desktop side:
 * it ships with the runtime, and a native module would have to be rebuilt per platform on every
 * release.
 *
 * The API is synchronous, and that is load-bearing. A transaction here never spans an `await`, so
 * nothing else in this process can interleave with it — which is what lets the store drop the
 * per-session write queues the JSONL files needed. Keep it that way: **a transaction only reads and
 * writes the database**. No file I/O, no network, no waiting on anything, because every session in
 * every process queues on the same write lock.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Schema, one entry per version. Append; never edit an entry that has shipped.
 *
 * `records.body` is the whole record as JSON, so a new record type needs no migration — only a
 * change to the tables themselves does.
 */
const MIGRATIONS: string[] = [
	`
	CREATE TABLE sessions (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		message_count INTEGER NOT NULL,
		meta TEXT NOT NULL
	);
	CREATE INDEX sessions_recent ON sessions (updated_at DESC);

	-- body last: filtering on kind does not have to read a large body's overflow pages.
	CREATE TABLE records (
		id INTEGER PRIMARY KEY,
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		ts INTEGER NOT NULL,
		kind TEXT NOT NULL,
		body TEXT NOT NULL,
		UNIQUE (session_id, seq)
	);

	CREATE TABLE partials (
		session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
		stream TEXT NOT NULL,
		head TEXT NOT NULL,
		owner_pid INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (session_id, stream)
	);
	CREATE TABLE partial_chunks (
		session_id TEXT NOT NULL,
		stream TEXT NOT NULL,
		n INTEGER NOT NULL,
		body TEXT NOT NULL,
		PRIMARY KEY (session_id, stream, n),
		FOREIGN KEY (session_id, stream) REFERENCES partials (session_id, stream) ON DELETE CASCADE
	);

	-- No foreign key on purpose: deleting a conversation does not unspend its money.
	CREATE TABLE spend (
		id INTEGER PRIMARY KEY,
		session_id TEXT,
		stream TEXT,
		kind TEXT NOT NULL,
		ts INTEGER NOT NULL,
		source TEXT,
		provider TEXT,
		model TEXT,
		call TEXT
	);

	-- A name for this file, made once. A cursor kept outside it (the usage page's cache of spend rows
	-- read) checks the name first: a database recreated or restored from a backup numbers its rows
	-- afresh, and a cursor from the old one would skip everything new.
	CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	INSERT INTO info (key, value) VALUES ('id', lower(hex(randomblob(16))));
	`,
	`
	-- Which beginPartial a streamed copy belongs to. A new stream takes the same key, so without it a
	-- writer that had been taken over could still extend, drop or settle its successor's. A row from
	-- before this has no stream live anywhere and settles like a dead writer's.
	ALTER TABLE partials ADD COLUMN token TEXT NOT NULL DEFAULT '';
	`,
];

/** The session database would not open. Carries where it is, because the person has to go and look. */
export class SessionDbUnavailable extends Error {
	readonly path: string;
	/** What SQLite, or the version check, said. */
	readonly reason: string;

	constructor(path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`无法打开会话库 ${path}：${reason}`, { cause });
		this.name = "SessionDbUnavailable";
		this.path = path;
		this.reason = reason;
	}
}

/** What the WAL file is cut back to after a checkpoint. A few seconds of streaming, not a whole cleanup. */
const WAL_LIMIT_BYTES = 16 * 1024 * 1024;

const open = new Map<string, DatabaseSync>();

/**
 * The connection for `path`, opened and migrated on first use.
 *
 * Shared by every store on the same file in this process: the API is synchronous, so a second
 * connection buys no concurrency, and one connection is what keeps "which streams are live here"
 * a question with a single answer (see `partial.ts`).
 *
 * A file that cannot be opened is reported with its path and left alone. Rebuilding it would erase
 * every conversation to recover from what may be a transient lock or a half-synced copy.
 */
export function sessionDb(path: string): DatabaseSync {
	const known = open.get(path);
	if (known?.isOpen) return known;
	let db: DatabaseSync | undefined;
	try {
		mkdirSync(dirname(path), { recursive: true });
		db = new DatabaseSync(path, { timeout: 5_000 });
		// Only takes effect before the first table exists, which is why it comes first.
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");
		db.exec("PRAGMA journal_mode = WAL");
		/*
		 * NORMAL, not FULL. Under WAL it survives the process dying at any point; only a power cut
		 * can lose the last few commits. FULL would fsync every commit, and a streaming reply
		 * commits a dozen times a second.
		 */
		db.exec("PRAGMA synchronous = NORMAL");
		/*
		 * The WAL file is reused, never shrunk, unless this is set. Deleting 320MB of sessions wrote
		 * 313MB of relocated pages into it and the file stayed that size: the database got smaller and
		 * the disk did not. With a limit it is cut back the next time it is reset.
		 */
		db.exec(`PRAGMA journal_size_limit = ${WAL_LIMIT_BYTES}`);
		db.exec("PRAGMA foreign_keys = ON");
		migrate(db);
	} catch (cause) {
		if (db?.isOpen) db.close();
		throw new SessionDbUnavailable(path, cause);
	}
	open.set(path, db);
	closeAtExit();
	return db;
}

export function closeSessionDb(path: string): void {
	const db = open.get(path);
	open.delete(path);
	if (db?.isOpen) db.close();
}

/** Writes still held in memory, to land before the connections close at exit. */
const lastWrites = new Set<() => void>();

/** Register a synchronous flush to run at exit, before the database is closed. */
export function beforeSessionDbClose(flush: () => void): void {
	lastWrites.add(flush);
}

let exitHooked = false;

/*
 * Close every connection when the process exits normally, after the last writes.
 *
 * Closing is what folds the WAL back into the database file and removes it. Left open, a quit
 * leaves the newest commits only in `sessions.db-wal`, and "quit before copying `~/.plume`"
 * stops being true — measured: the main file held the header page and nothing else. `exit` runs
 * synchronously, which is enough here because every write in this module is synchronous.
 */
function closeAtExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.once("exit", () => {
		for (const flush of lastWrites) {
			try {
				flush();
			} catch {
				// One writer failing must not keep the rest of the data from being folded in.
			}
		}
		// Deleting the entry being visited is safe for a Map iterator.
		for (const path of open.keys()) closeSessionDb(path);
	});
}

/** Run `fn` inside one write transaction. Re-entrant: an inner call joins the outer one. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
	if (db.isTransaction) return fn();
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function userVersion(db: DatabaseSync): number {
	return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function migrate(db: DatabaseSync): void {
	if (userVersion(db) === MIGRATIONS.length) return;
	transaction(db, () => {
		// Read again under the write lock: another process may have migrated in the meantime.
		const from = userVersion(db);
		// An older build writing a newer schema is how a database gets quietly corrupted.
		if (from > MIGRATIONS.length) throw new Error(`会话库版本 ${from} 比这个版本的 Plume（${MIGRATIONS.length}）新，请升级`);
		for (let version = from; version < MIGRATIONS.length; version++) db.exec(MIGRATIONS[version]);
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
	});
}
