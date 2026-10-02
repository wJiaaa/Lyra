/**
 * Which model a conversation runs on and how hard it thinks — both written into its log.
 *
 * They live in the log rather than in a window because they belong to the conversation: they have
 * to survive a restart, reach the phone through the same sync every other change reaches it through,
 * and apply to a turn started from anywhere.
 */

import { stripStaleHandles } from "../agent/model-switch.ts";
import type { SessionMeta } from "../session/store.ts";
import type { ThinkingLevel } from "../types.ts";
import type { SessionLog } from "./session-log.ts";

/**
 * Pick or change the model, at any point. Returns whether it changed.
 *
 * Changing it partway through also records where that happened: the reasoning handles written
 * before it belong to the previous provider and cannot be replayed to this one. See
 * `stripStaleHandles`.
 */
export async function recordModel(log: SessionLog, modelId: string): Promise<boolean> {
	const changed = log.meta.modelId !== modelId;
	const switching = log.messages.length > 0 && changed;
	const meta: SessionMeta = {
		...log.meta,
		modelId,
		...(switching ? { modelSwitchedAt: log.messages.length } : {}),
	};
	log.meta = meta;
	await log.append({ type: "meta", meta });
	// The running session holds the same messages the next turn will encode, so clean those too.
	if (switching) {
		// Same transcript, same marks — a model switch rewrites handles, not where history was summarised.
		log.restore(stripStaleHandles(log.messages, meta.modelSwitchedAt), log.compaction, log.compactions);
	}
	return changed;
}

/**
 * The running turn really has switched: move the switch point to now.
 *
 * `recordModel` marks the moment the person pressed the switch. But the request that was already
 * answering finishes, and that reply — from the old model, carrying the old provider's handles —
 * lands after the switch point. When the next turn rebuilds history from the log it hands that
 * reply to the new model as is, and the whole request is refused. The loop calls this at the
 * moment the switch actually takes effect, so the point is right.
 *
 * Stripped and marked synchronously: the loop does not wait here, and the next message may be
 * written straight away. Writing to disk can come a little later.
 */
export function adoptModelSwitch(log: SessionLog): void {
	const at = log.messages.length;
	if (at === 0 || log.meta.modelSwitchedAt === at) return;
	const meta: SessionMeta = { ...log.meta, modelSwitchedAt: at };
	log.meta = meta;
	log.restore(stripStaleHandles(log.messages, at), log.compaction, log.compactions);
	void log.append({ type: "meta", meta }).catch(() => {});
}

/**
 * How hard this conversation asks the model to think, from here on.
 *
 * `null` gives the conversation back to the app default rather than pinning it to whatever the
 * default happens to be right now — a distinction that only shows itself later, when the default
 * moves and a session that was never given an opinion should move with it.
 */
export async function recordThinking(log: SessionLog, thinking: ThinkingLevel | null): Promise<void> {
	/*
	 * `undefined`, not `delete`.
	 *
	 * A `meta` record is merged over the store's copy (`Object.assign` in `applyRecord`), so a
	 * key that is simply missing leaves the previous value standing — clearing the level by deleting
	 * the field wrote a record that changed nothing. Present-and-undefined overwrites, and
	 * `JSON.stringify` drops it on the way to disk, so the reloaded log has no level at all, which
	 * is what was meant.
	 */
	const meta: SessionMeta = { ...log.meta, thinking: thinking ?? undefined };
	log.meta = meta;
	await log.append({ type: "meta", meta });
}
