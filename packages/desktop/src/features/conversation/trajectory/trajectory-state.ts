import type { TrajectoryChanges } from "@plume/core";
import { entryKey, type Entry } from "@plume/core/trajectory-view";

/** Preserve untouched entries so selecting, searching and streaming reuse the same render work. */
export function applyTrajectoryChanges(previous: Entry[], changes: TrajectoryChanges): Entry[] {
	if (changes.reset) return changes.upserts;
	if (!changes.upserts.length && !changes.removals.length) return previous;
	const removed = new Set(changes.removals);
	const replacements = new Map(changes.upserts.map(entry => [entryKey(entry), entry]));
	const result: Entry[] = [];
	for (const entry of previous) {
		const id = entryKey(entry);
		if (!removed.has(id)) result.push(replacements.get(id) ?? entry);
		replacements.delete(id);
	}
	result.push(...replacements.values());
	return result;
}
