import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionRecord } from "../session/store.ts";
import type { TrajectorySource } from "./read.ts";
import { projectTrajectory } from "./project.ts";
import { entryKey, type Entry, type TrajectoryChanges } from "./types.ts";

interface Snapshot {
	epoch: string;
	revision: number;
	/** Highest record seq already folded into `records`. */
	seq: number;
	records: SessionRecord[];
	entries: Map<string, { entry: Entry; revision: number }>;
	removals: Map<string, number>;
	running: boolean;
	pending: Promise<void>;
}

/** Each client owns its cursor; reading a delta never consumes another subscriber's updates. */
export class TrajectoryReader {
	private readonly store: TrajectorySource;
	private readonly snapshots = new Map<string, Snapshot>();
	private readonly capacity: number;

	constructor(store: TrajectorySource, capacity = 4) {
		this.store = store;
		this.capacity = capacity;
	}

	async changes(sessionId: string, cursor?: string, running = false): Promise<TrajectoryChanges> {
		const key = sessionId;
		let snapshot = this.snapshots.get(key);
		if (!snapshot) {
			snapshot = { epoch: randomUUID(), revision: 0, seq: 0, records: [], entries: new Map(), removals: new Map(), running, pending: Promise.resolve() };
		}
		this.snapshots.delete(key);
		this.snapshots.set(key, snapshot);
		if (this.snapshots.size > this.capacity) {
			const oldest = this.snapshots.keys().next().value;
			if (oldest !== undefined) this.snapshots.delete(oldest);
		}
		const current = snapshot;
		const update = current.pending.then(() => this.refresh(current, sessionId, running));
		// A failed I/O attempt remains visible to its caller without poisoning future refreshes.
		current.pending = update.catch(() => {});
		await update;
		const parts = cursor?.split(":");
		const revision = parts?.length === 2 && parts[0] === current.epoch ? Number(parts[1]) : -1;
		const reset = !Number.isSafeInteger(revision) || revision < 0 || revision > current.revision;
		return {
			cursor: `${current.epoch}:${current.revision}`,
			reset,
			upserts: [...current.entries.values()].filter(item => reset || item.revision > revision).map(item => item.entry),
			removals: reset ? [] : [...current.removals].filter(([, removedAt]) => removedAt > revision).map(([id]) => id),
		};
	}

	/** Only the records appended since the last look: the log is append-only, so the prefix never changes. */
	private async refresh(snapshot: Snapshot, sessionId: string, running: boolean): Promise<void> {
		const incoming: SessionRecord[] = [];
		for await (const record of this.store.read(sessionId, snapshot.seq)) incoming.push(record);
		if (incoming.length === 0 && snapshot.running === running && snapshot.revision > 0) return;
		const records = [...snapshot.records];
		for (const record of incoming) {
			if (record.type === "truncate") {
				while (records.length && records[records.length - 1].seq > record.afterSeq) records.pop();
			} else records.push(record);
		}
		const projected = projectTrajectory(records, running);
		const revision = snapshot.revision + 1;
		const entries = new Map<string, { entry: Entry; revision: number }>();
		for (const entry of projected) {
			const id = entryKey(entry);
			const previous = snapshot.entries.get(id);
			entries.set(id, previous && isDeepStrictEqual(previous.entry, entry) ? previous : { entry, revision });
			snapshot.removals.delete(id);
		}
		for (const id of snapshot.entries.keys()) if (!entries.has(id)) snapshot.removals.set(id, revision);
		snapshot.entries = entries;
		snapshot.revision = revision;
		snapshot.records = records;
		snapshot.seq = incoming.at(-1)?.seq ?? snapshot.seq;
		snapshot.running = running;
	}
}
