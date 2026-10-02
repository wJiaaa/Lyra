/**
 * `/compact`: shortening a session's history because someone asked, and saying how it went.
 *
 * The boundary is stored exactly as it is when compaction happens on its own — there is one way a
 * session's history gets shortened, and this only changes what starts it. Whether it may start at
 * all (not mid-turn, not twice) is `AgentSession.compact` and `SessionActivity.compact`.
 */

import { randomUUID } from "node:crypto";
import type { AgentEventSink, CommandRun } from "../agent/events.ts";
import { sessionPruner } from "../agent/aged-prune.ts";
import type { StreamFn } from "../agent/run-config.ts";
import { resolveModelRef } from "../config/model-roles.ts";
import { resolveModel, type Settings } from "../config/settings.ts";
import { compactWith } from "./compaction.ts";
import type { CompactOutcome } from "./session-activity.ts";
import type { SessionCapabilities } from "./session-capabilities.ts";
import type { SessionLog } from "./session-log.ts";
import { compactionSpent, modelHistory, summaryStream } from "./session-turn.ts";

export interface CompactionParts {
	log: SessionLog;
	can: SessionCapabilities;
	settings: () => Settings;
	streamFn: StreamFn | undefined;
	emit: AgentEventSink;
	/** Put the pruner's remembered views back before reading the history; see `AgentSession.preparePruner`. */
	preparePruner: () => Promise<void>;
}

/** Run one manual compaction, reported as a command in the transcript from start to finish. */
export async function manualCompaction(parts: CompactionParts, instructions: string, signal: AbortSignal): Promise<CompactOutcome> {
	const { log, emit } = parts;
	const command: CommandRun = { id: randomUUID(), name: "compact", timestamp: Date.now(), input: `/compact${instructions.trim() ? ` ${instructions.trim()}` : ""}`,
		at: log.messages.length, status: "running", detail: "正在压缩会话…" };
	await emit({ type: "command_status", command });
	try {
		const result = await compactHistory(parts, instructions, signal, command.id);
		await emit({ type: "command_status", command: { ...command, status: result.ok ? "done" : "skipped",
			detail: result.ok ? `已压缩上下文：${result.before} 条消息整理为 ${result.after} 条，完整对话仍可查看。` : result.reason ?? "无需进一步压缩。" } });
		return result;
	} catch (cause) {
		// A committed boundary remains successful even if delivery of the completion event failed.
		if (log.commandRuns.some((run) => run.id === command.id && run.status === "done")) return { ok: true };
		const reason = signal.aborted ? "压缩已取消，原上下文保持不变。" : `压缩失败：${cause instanceof Error ? cause.message : String(cause)}`;
		await emit({ type: "command_status", command: { ...command, status: signal.aborted ? "cancelled" : "failed", detail: reason } });
		return { ok: false, reason };
	}
}

async function compactHistory(parts: CompactionParts, instructions: string, signal: AbortSignal, commandId: string): Promise<CompactOutcome> {
	const { log, can, emit } = parts;
	const resolved = resolveModel(parts.settings(), log.meta.modelId || parts.settings().defaultModelId);
	if (!resolved) return { ok: false, reason: "还没有配置模型。" };

	await parts.preparePruner();
	const history = modelHistory(log, resolved.provider, resolved.model);
	if (history.length <= 6) return { ok: false, reason: "对话还太短，没什么可压缩的。" };

	const summarizer = resolveModelRef(parts.settings(), "@compact", resolved);
	/*
	 * Through the seam, not around it.
	 *
	 * This called `compactIfNeeded` directly, which meant `/compact` ran the built-in policy
	 * even where a host had installed another one — so replacing compaction replaced it for
	 * the loop and not for the user. There is one way a session's history gets shortened; this
	 * only changes what starts it, which is what `force` says.
	 */
	const compaction = await compactWith({
		messages: history,
		model: resolved.model,
		provider: resolved.provider,
		streamFn: summaryStream(parts.streamFn, { retryPolicy: () => parts.settings().retryPolicy, signal }, compactionSpent(log)),
		force: true,
		// The trimmed originals are kept; the placeholders point at them with an `artifact://` address.
		artifacts: { keep: (tool, content) => can.keepArtifact(tool, content) },
		manual: { instructions, signal },
		summarizer,
	});
	/*
	 * Two different outcomes, and they used to say the same thing.
	 *
	 * `null` means the pass ran and decided the result would not be smaller — on a short or
	 * already-compacted conversation that is the correct answer, not a failure, and telling
	 * someone to "try again later" invites them to keep pressing something that will keep
	 * declining for the same good reason.
	 *
	 * `kept === undefined` is the other one: pruning trimmed some oversized tool output but no
	 * boundary moved, so there is nothing to record. Worth saying plainly too — the window did
	 * get a little smaller, just not by summarising anything.
	 */
	if (!compaction) return { ok: false, reason: "已经够紧凑了，这次压缩不会更小。" };
	if (signal.aborted) throw new Error("压缩已取消。");
	/*
	 * The trimmed tool results are handed to the session's pruner to remember, the same as
	 * `compactStep` does in the loop: a boundary records only the summary and how many messages it
	 * kept, so without this the next turn rebuilds the originals from the log and sends what was
	 * just trimmed all over again. When only pruning happened there is no boundary to write, and
	 * this is the only way it takes effect.
	 */
	const adopt = () => sessionPruner(can.state).adopt(history, compaction.messages, compaction.kept ?? (compaction.messages.length === history.length ? history.length : 0));
	if (compaction.kept === undefined) {
		adopt();
		return { ok: false, reason: "只裁掉了几段过长的工具输出，没有需要总结的历史。" };
	}

	await emit({
		type: "compacted",
		commandId,
		before: history.length,
		after: compaction.messages.length,
		summary: compaction.summary,
		kept: compaction.kept,
	});
	adopt();
	return { ok: true, before: history.length, after: compaction.messages.length };
}
