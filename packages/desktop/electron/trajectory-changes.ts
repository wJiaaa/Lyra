import { TrajectoryReader, type SessionStorage, type TrajectoryChanges } from "@plume/core";

const readers = new WeakMap<SessionStorage, TrajectoryReader>();

/** One projection reader per store; each caller keeps its own revision cursor. */
export function readTrajectoryChanges(store: SessionStorage, sessionId: string, cursor?: string, running = false): Promise<TrajectoryChanges> {
	let reader = readers.get(store);
	if (!reader) { reader = new TrajectoryReader(store); readers.set(store, reader); }
	return reader.changes(sessionId, cursor, running);
}
