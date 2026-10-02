import type { CommandRun } from "./events.ts";

export function completedCompaction(command: CommandRun, before: number, after: number): CommandRun {
	const fallback = command.automatic?.phase === "fallback";
	return {
		...command, status: "done",
		...(command.automatic ? { automatic: { ...command.automatic, before, after, delayMs: undefined, outcome: fallback ? "fallback" as const : "summary" as const } } : {}),
		detail: `${fallback ? "摘要生成失败，已使用本地兜底整理上下文" : "已压缩上下文"}：${before} 条消息整理为 ${after} 条，完整对话仍可查看。`,
	};
}

export function interruptedCompaction(command: CommandRun): CommandRun {
	return { ...command, status: "cancelled", detail: "压缩中断，保留最近已保存的上下文，未完成的操作没有自动重试。" };
}
