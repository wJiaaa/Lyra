/**
 * Reading the session log as a trajectory.
 *
 * One pass over the append-only records, turning each into the entries a person would recognise.
 * The interesting part is that this is the *only* reader: resuming, forking and replaying all go
 * through it, so there is one answer to "what happened" rather than three that can disagree.
 *
 * `truncate` records are honoured here rather than by deleting records — history is never edited,
 * so a trajectory has to know that a tail was voided and leave it out.
 */

import type { SessionRecord } from "../session/store.ts";
import type { Entry } from "./types.ts";
import { projectTrajectory } from "./project.ts";

export interface TrajectorySource {
	read(sessionId: string, sinceSeq?: number): AsyncGenerator<SessionRecord>;
}

export async function readTrajectory(
	store: TrajectorySource,
	sessionId: string,
	running = false,
): Promise<Entry[]> {
	const records: SessionRecord[] = [];
	for await (const record of store.read(sessionId)) {
		if (record.type === "truncate") {
			while (records.length && records[records.length - 1].seq > record.afterSeq) records.pop();
		} else records.push(record);
	}
	return projectTrajectory(records, running);
}
