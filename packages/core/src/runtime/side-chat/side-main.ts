import type { QueuedTask } from "../../agent/events.ts";
import type { SessionMeta } from "../../session/types.ts";
import type { Message, UserContent } from "../../types.ts";

/**
 * 侧边聊天够得着的那一面主会话：读它的记录、看它在不在忙、往它的队里排活、让它停下或接着做。
 *
 * 不直接写 `AgentSession`：`session.ts` 要引侧边聊天这几个文件，它们再反过来引 `session.ts`，
 * 哪怕只是类型，`pnpm arch` 也会按环报出来。`AgentSession` 按结构满足它。
 */
export interface MainSession {
	readonly meta: SessionMeta;
	readonly messages: Message[];
	readonly running: boolean;
	readonly taskQueue: QueuedTask[];
	enqueueTask(text: string): Promise<QueuedTask>;
	resumeTask(taskId: string): Promise<boolean>;
	interruptedTask(): QueuedTask | null;
	discardTaskPlan(): Promise<void>;
	abort(): void;
	prompt(content: UserContent[], options: { synthetic: true }): Promise<unknown>;
}
