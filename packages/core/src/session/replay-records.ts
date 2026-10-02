/**
 * The transcript a session's records add up to.
 *
 * Pure, over records already read: the store decides which kinds to fetch (`REPLAY_KINDS`), this
 * decides what they mean. `truncate` is honoured here rather than by deleting rows — history is
 * never edited, so a reader has to know that a tail was voided and leave it out.
 */

import { completedCompaction, interruptedCompaction } from "../agent/compaction-lifecycle.ts";
import type { CommandRun, HookRun } from "../agent/events.ts";
import type { Message, Usage } from "../types.ts";
import { addUsage, emptyUsage } from "../types.ts";
import type { Boundary, SessionRecord } from "./types.ts";

/** The record kinds `replayRecords` reads. Everything else — prompts, requests, tool starts — is skipped unread. */
export const REPLAY_KINDS = ["message", "usage", "subagent_message", "compacted", "command_status", "hook_run", "truncate"] as const;

export interface Replayed {
	/** Kept with their sequence numbers so a truncate record can drop the right tail. */
	entries: { seq: number; message: Message }[];
	/**
	 * Where history was summarised, as positions in the transcript. Recorded while replaying rather
	 * than derived, because the messages themselves do not show it: the log keeps every original
	 * either way. The window draws a divider at each.
	 */
	compactions: number[];
	commandRuns: CommandRun[];
	hookRuns: HookRun[];
	/**
	 * And the newest of them in full, which is what the *model* is given. Only the latest matters:
	 * each compaction summarises the one before it.
	 */
	compaction: Boundary | null;
	/** Everything the surviving transcript spent, sub-agents and side calls included. */
	usage: Usage;
}

export function replayRecords(records: Iterable<SessionRecord>): Replayed {
	let entries: { seq: number; message: Message }[] = [];
	let auxiliaryUsage = emptyUsage();
	const compactions: number[] = [];
	const commandRuns = new Map<string, { seq: number; run: CommandRun }>();
	const hookRuns = new Map<string, { seq: number; run: HookRun }>();
	let subagentEntries: { seq: number; usage: Usage }[] = [];
	let compaction: Boundary | null = null;

	for (const record of records) {
		if (record.type === "event" && record.event.type === "command_status") {
			const run = record.event.command;
			commandRuns.set(run.id, { seq: record.seq, run });
		} else if (record.type === "event" && record.event.type === "hook_run") {
			hookRuns.set(record.event.run.id, { seq: record.seq, run: record.event.run });
		} else if (record.type === "event" && record.event.type === "compacted") {
			compactions.push(entries.length);
			/*
			 * `kept` is absent on pruning passes that moved no boundary: no boundary to restore, so
			 * the session opens on its full history and compacts again if it has to.
			 */
			const { summary, kept } = record.event;
			if (kept !== undefined) {
				compaction = { at: record.ts, summary: summary ?? "", keptFrom: Math.max(0, entries.length - kept) };
				// The boundary is the commit record; the UI completion event may not have reached disk.
				const entry = record.event.commandId ? commandRuns.get(record.event.commandId) : undefined;
				if (entry?.run.status === "running") {
					entry.seq = record.seq;
					entry.run = record.event.command ?? completedCompaction(entry.run, record.event.before, record.event.after);
				}
			}
		} else if (record.type === "event" && record.event.type === "subagent_message" && record.event.message.role === "assistant") {
			subagentEntries.push({ seq: record.seq, usage: record.event.message.usage });
		} else if (record.type === "message") {
			// `{"type":"message"}` is what an undefined message serialises to; a hole here once took the window down.
			if (record.message) entries.push({ seq: record.seq, message: record.message });
		} else if (record.type === "usage") {
			auxiliaryUsage = addUsage(auxiliaryUsage, record.usage);
		} else if (record.type === "truncate") {
			entries = entries.filter((e) => e.seq <= record.afterSeq);
			subagentEntries = subagentEntries.filter((e) => e.seq <= record.afterSeq);
			for (const [id, entry] of commandRuns) if (entry.seq > record.afterSeq) commandRuns.delete(id);
			for (const [id, entry] of hookRuns) if (entry.seq > record.afterSeq) hookRuns.delete(id);
			while (compactions.length && compactions[compactions.length - 1] > entries.length) compactions.pop();
			// A rewind past the boundary retires it: the tail it was paired with is gone.
			if (compaction && compaction.keptFrom > entries.length) compaction = null;
		}
	}

	let usage = auxiliaryUsage;
	for (const entry of subagentEntries) if (entry.usage) usage = addUsage(usage, entry.usage);
	for (const { message } of entries) if (message.role === "assistant" && message.usage) usage = addUsage(usage, message.usage);

	return {
		entries,
		compactions,
		compaction,
		commandRuns: [...commandRuns.values()].map(({ run }) => (run.status === "running" ? interruptedCompaction(run) : run)),
		hookRuns: [...hookRuns.values()].map(({ run }) => run),
		usage,
	};
}
