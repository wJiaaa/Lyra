/**
 * Sessions written straight into the database the app reads.
 *
 * Fixtures need records the store would never produce on its own — a fixed clock, a damaged
 * message, five thousand turns in one go — so they bypass `append` and insert rows. Everything a
 * reader relies on is still filled in the way `append` would: one sessions row carrying the final
 * meta, records numbered from 1, and the spend rows those records imply.
 */

import { join } from "node:path";
import type { SessionMeta } from "@plume/core";
import type { SessionRecordInput } from "../../core/src/session/types.ts";
import { SessionStore } from "../../core/src/session/store.ts";
import { closeSessionDb, sessionDb, transaction } from "../../core/src/session/db.ts";
import { recordKind } from "../../core/src/session/apply-record.ts";
import { spendOf } from "../../core/src/session/spend.ts";

/** A record as a fixture writes it. `seq` is only used to resolve a truncate's `afterSeq`; rows are renumbered from 1. */
export type FixtureRecord = SessionRecordInput & { seq?: number; ts?: number };

export interface FixtureSession {
	meta: SessionMeta;
	records: FixtureRecord[];
}

export function sessionsDbPath(home: string): string {
	return join(home, "sessions", "sessions.db");
}

/**
 * Write these sessions, replacing any with the same id (spend included), and close the
 * connection so the app opens a checkpointed file.
 *
 * `meta.seq` is set to the last record's number; everything else in `meta` is taken as given, so
 * `messageCount`, `usage` and `updatedAt` say whatever the fixture needs them to.
 */
export function seedSessions(home: string, sessions: FixtureSession[]): SessionMeta[] {
	const path = sessionsDbPath(home);
	const db = sessionDb(path);
	const seeded: SessionMeta[] = [];
	try {
		transaction(db, () => {
			for (const { meta, records } of sessions) {
				db.prepare("DELETE FROM sessions WHERE id = ?").run(meta.id);
				// Replacing a session replaces what it spent too; a re-seeded fixture must not bill twice.
				db.prepare("DELETE FROM spend WHERE session_id = ?").run(meta.id);
				const renumbered = new Map<number, number>();
				const rows = records.map((record, index) => {
					const { seq, ts, ...payload } = record;
					if (seq !== undefined) renumbered.set(seq, index + 1);
					return { seq: index + 1, ts: ts ?? meta.updatedAt, payload: payload as SessionRecordInput };
				});
				const final: SessionMeta = { ...meta, seq: rows.length };
				db.prepare("INSERT INTO sessions (id, project_id, seq, created_at, updated_at, archived, message_count, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
					.run(final.id, final.projectId, final.seq, final.createdAt, final.updatedAt, final.archived ? 1 : 0, final.messageCount, JSON.stringify(final));
				const insert = db.prepare("INSERT INTO records (session_id, seq, ts, kind, body) VALUES (?, ?, ?, ?, ?)");
				const spend = db.prepare("INSERT INTO spend (session_id, stream, kind, ts, source, provider, model, call) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
				for (const row of rows) {
					let payload = row.payload;
					if (payload.type === "truncate") payload = { ...payload, afterSeq: renumbered.get(payload.afterSeq) ?? payload.afterSeq };
					insert.run(final.id, row.seq, row.ts, recordKind(payload), JSON.stringify({ seq: row.seq, ts: row.ts, ...payload }));
					for (const entry of spendOf(payload, row.ts)) {
						spend.run(final.id, entry.stream, entry.kind, row.ts, entry.source, entry.provider ?? null, entry.model ?? null, entry.call ? JSON.stringify(entry.call) : null);
					}
				}
				seeded.push(final);
			}
		});
	} finally {
		closeSessionDb(path);
	}
	return seeded;
}

/** Every session in `home`, most recent first — what the sidebar will list. */
export async function seededSessions(home: string): Promise<SessionMeta[]> {
	const store = new SessionStore(join(home, "sessions"));
	try {
		return await store.listSessions();
	} finally {
		store.close();
	}
}

/** A store on `home`, for fixtures that build sessions the way the app does. Close it before launching the app. */
export function fixtureStore(home: string): SessionStore {
	return new SessionStore(join(home, "sessions"));
}
