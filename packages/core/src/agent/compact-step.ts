import { randomUUID } from "node:crypto";
import type { Compaction } from "../runtime/compaction.ts";
import type { CompactionObserver } from "../types/compaction.ts";
import type { AgentEventSink, CommandRun } from "./events.ts";
import type { Message, ModelConfig } from "../types.ts";
import { completedCompaction, interruptedCompaction } from "../runtime/compaction-lifecycle.ts";

export type CompactHistory = (messages: Message[], model: ModelConfig, observer?: CompactionObserver) => Promise<Compaction | null>;

/** The completed operation and its new model view share one durable record. */
export async function compactStep(config: { compact?: CompactHistory; signal?: AbortSignal }, messages: Message[], model: ModelConfig, emit: AgentEventSink) {
	if (!config.compact) return null;
	let command: CommandRun | undefined;
	const report = async (next: CommandRun) => {
		command = next;
		await emit({ type: "command_status", command: next });
	};
	let result;
	try {
		result = await config.compact(messages, model, {
			signal: config.signal,
			progress: async (progress) => {
				command ??= { id: randomUUID(), name: "compact", timestamp: Date.now(), at: messages.length, input: "", status: "running", detail: "", automatic: { phase: "summarizing", retries: 0 } };
				const automatic = { ...command.automatic!, ...progress };
				if (progress.phase === "retrying") automatic.retries++;
				await report({ ...command, automatic, detail: progress.phase === "summarizing" ? "正在自动压缩上下文…" : progress.phase === "retrying" ? `自动压缩遇到故障，等待第 ${automatic.retries} 次重试…` : "摘要生成失败，正在尝试本地兜底整理…" });
			},
		});
	} catch (cause) {
		if (command) await report(config.signal?.aborted ? interruptedCompaction(command) : { ...command, status: "failed", detail: "自动压缩失败，保留最近已保存的上下文。" });
		throw cause;
	}
	if (config.signal?.aborted) {
		if (command) await report(interruptedCompaction(command));
		return null;
	}
	if (!result) {
		if (command) await report({ ...command, status: "failed", automatic: { ...command.automatic!, fault: command.automatic?.fault ?? { kind: "no_reduction" } }, detail: "自动压缩未能缩小上下文，原上下文保持不变。" });
		return null;
	}
	await emit({
		type: "compacted", before: messages.length, after: result.messages.length, summary: result.summary, kept: result.kept,
		...(command ? { commandId: command.id, command: completedCompaction(command, messages.length, result.messages.length) } : {}),
	});
	return result;
}
