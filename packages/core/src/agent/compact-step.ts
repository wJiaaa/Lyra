import { randomUUID } from "node:crypto";
import type { Compaction } from "../runtime/compaction.ts";
import type { CompactionObserver } from "../types/compaction.ts";
import type { AgentEventSink, CommandRun } from "./events.ts";
import type { Message, ModelConfig } from "../types.ts";
import { completedCompaction, interruptedCompaction } from "../runtime/compaction-lifecycle.ts";
import type { AgedToolPruner } from "../runtime/aged-prune.ts";

/**
 * `force`：不看 80% 线，现在就压——模型已经以「上下文超长」拒收了这次请求（`loop.ts` 的超长恢复）。
 * 实现方原样交给 `compactWith` 的同名字段。
 */
export type CompactHistory = (messages: Message[], model: ModelConfig, observer?: CompactionObserver, options?: { force?: boolean }) => Promise<Compaction | null>;

/** The completed operation and its new model view share one durable record. */
export async function compactStep(config: { compact?: CompactHistory; signal?: AbortSignal; pruner?: Pick<AgedToolPruner, "adopt"> }, messages: Message[], model: ModelConfig, emit: AgentEventSink, options?: { force?: boolean }) {
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
		}, options);
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
	/*
	 * 压缩里剪过的工具结果，在边界写盘成功后交给会话的剪枝器记住。边界只记摘要和保留条数，
	 * 下一轮从日志重建出的是原文：只剪枝时根本没有边界，摘要时保留尾部也回到原文。不记下的话
	 * 发给模型的和下一轮重建的不一致，前缀断开、实测 usage 失真。见 `AgedToolPruner`。
	 */
	config.pruner?.adopt(messages, result.messages, result.kept ?? (result.messages.length === messages.length ? messages.length : 0));
	return result;
}
