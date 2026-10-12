import type { Failure } from "../ai/failure.ts";
import type { PrefixSegment } from "../ai/prefix-fingerprint.ts";
import type { Message, RequestPrefix } from "./message.ts";
import type { ThinkingLevel } from "./provider.ts";
import type { ToolSpec } from "./tool.ts";

/**
 * 上一次真正发出去的主请求的请求头：压缩从这里分叉。
 *
 * 只记请求头，不记消息——消息由调用方按当下的视图给（`CompactionLineage.messages`），它和上一次
 * 发出去的那份应当只差末尾新接上的几条。差的不止这些时，发出前的前缀核对会拦下来。
 */
export interface SentRequest {
	providerId: string;
	/** `ModelConfig.id`，不是服务商那边的名字。 */
	modelId: string;
	systemPrompt: string;
	tools: ToolSpec[];
	thinking: ThinkingLevel | undefined;
	temperature: number | undefined;
	/** 配置上要的输出上限，按上下文折算之前的那个数；分叉请求照同一个算法再折一次。 */
	maxTokens: number | undefined;
	cacheKey: string | undefined;
	/** 开始发送的时刻。缓存在预填充时续期，从这里起算它还热不热。 */
	at: number;
}

/**
 * 压缩请求从哪条前缀上分叉：上一次的请求头，加上这一次要发的完整消息（已是发送形态）。
 *
 * 有了它，摘要请求就是「上一次请求原样再发一遍、末尾多一条指令」，前缀上的缓存照常命中。
 * 没有它（超长恢复、宿主没给、缓存已冷），退回独立的摘要请求。
 */
export interface CompactionLineage {
	sent: SentRequest;
	/** 这次要发的全部消息，发送形态：日期块、插话说明都已接好，和主循环下一次请求的消息部分相同。 */
	messages: Message[];
	/** 上一次请求体的分段指纹（`ai/prefix-fingerprint.ts`）。有它才能在发出前核对前缀。 */
	segments?: PrefixSegment[];
}

/**
 * 摘要是怎么来的：`fork` 从主请求分叉，`independent` 单独发的摘要请求，`fallback` 两条都没拿到、
 * 本地机械整理，`dropped` 连本地整理也放不下、直接丢了最老的几轮。只剪了工具输出时没有这一项。
 */
export type CompactionVia = "fork" | "independent" | "fallback" | "dropped";

/** Keep classifications, never provider bodies which may echo credentials or prompt content. */
export interface CompactionFault {
	kind: Failure["kind"] | "empty" | "no_reduction" | "unknown";
	hint?: Failure["hint"];
}

type CompactionProgress =
	| { phase: "summarizing"; provider: string; model: string }
	| { phase: "retrying"; delayMs: number; fault: CompactionFault }
	| { phase: "fallback"; fault: CompactionFault };

export interface CompactionObserver {
	signal?: AbortSignal;
	progress(event: CompactionProgress): Promise<void>;
}

export interface AutoCompactionState {
	phase: CompactionProgress["phase"];
	retries: number;
	provider?: string;
	model?: string;
	delayMs?: number;
	before?: number;
	after?: number;
	fault?: CompactionFault;
	outcome?: "summary" | "fallback";
	/**
	 * 一轮收尾之后才开始的（`runtime/compaction/idle-compaction.ts`）。一轮里的自动压缩跟着那一轮亮灭，这一种外面
	 * 没有轮，界面要像手动压缩一样自己显示「进行中」，期间发的消息才看得出在排队。
	 */
	idle?: true;
}

/**
 * Compaction's result: the history to send, and everything needed to store the decision.
 *
 * The messages alone were what compaction used to return, and that is precisely what made it
 * non-durable — the caller could apply the result but had no way to write it down, because the
 * summary was buried inside a synthetic message and the boundary was implicit in the array's
 * length. Both are stated here.
 */
export interface Compaction {
	/** The history the model should be given from now on. */
	messages: Message[];
	/**
	 * The summary text, so the session can store it and rebuild this history later.
	 *
	 * Empty when history was discarded without one — the summariser was unreachable and dropping
	 * the oldest turns was the only way to get under the line. The boundary still moved, so it is
	 * still recorded; what is missing is the account of what was behind it.
	 */
	summary: string;
	/**
	 * How many real messages survived, counted from the newest.
	 *
	 * A count rather than an index, because the array this was computed from is the loop's own —
	 * already compacted, possibly more than once — while the boundary has to be resolved against
	 * the session log, which holds every original message. An index into one means nothing in the
	 * other; "the last N still apply" means the same thing in both.
	 *
	 * Absent when nothing was summarised away. Pruning oversized tool results rewrites messages
	 * without removing any, so it changes what is sent and not where history begins. 它不能靠
	 * 「下一轮再剪一次」补回来：下一轮的压缩判断读的是这次剪过之后的 usage，不会再触发，原文
	 * 就照发了。剪过的副本由 `compactStep` 交给会话的 `AgedToolPruner` 记住，摘要时保留尾部同理。
	 */
	kept?: number;
	/** 摘要走的哪条路，缓存验收按它分开统计。 */
	via?: CompactionVia;
	/**
	 * 分叉请求发出前核对的结果：上一次请求是不是它的前缀。只在核对过时有。
	 * 有 `change` 说明分叉没对上、被拦下改走了独立请求——那是一个要查的 bug，不是正常路径。
	 */
	prefix?: RequestPrefix;
}
