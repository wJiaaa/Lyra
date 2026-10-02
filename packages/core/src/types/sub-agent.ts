/**
 * What a dispatched sub-agent looks like from outside: the roster row the window draws and the
 * `subagents` event carries. The registry that keeps these is `runtime/sub-agents.ts`.
 */

import type { Usage } from "./message.ts";

/**
 * Where a sub-agent is in its life.
 *
 * Five, and the last three are all terminal — which is the distinction that matters to everything
 * reading this: `running` is the only state you can steer, and the difference between the other
 * three is what the transcript should say happened.
 *
 * `queued` 是派出去了、还在并发闸门后面等名额。它和 `running` 一样是「还没完」（能停、不能续跑、
 * 不会被挤出名单），但不能操控——它还一句话都没读过。
 */
export type SubAgentStatus = "queued" | "running" | "done" | "failed" | "aborted";

/** What the tab strip and the tip need to describe one sub-agent without opening it. */
export interface SubAgentSummary {
	id: string;
	/** Which definition it is running under — `general`, `explore`, a workspace one. */
	agent: string;
	/** The parent's own 3-5 word summary of what it delegated. */
	description: string;
	status: SubAgentStatus;
	startedAt: number;
	endedAt?: number;
	/** How much it has done, for "is this stuck?" — the question a viewer actually has. */
	toolCalls: number;
	/**
	 * The last thing it did, in the words the tool used to describe itself.
	 *
	 * One line rather than a history: this is for a tip, and a sub-agent that has read thirty files
	 * is thirty lines of "读取文件" that say less than the newest one alone.
	 */
	lastActivity?: string;
	/**
	 * 它此刻正卡在重连上，以及卡了多少次。
	 *
	 * 和 `lastActivity` 分开，因为它们回答的不是同一个问题：那个说「它最后做成了什么」，这个说
	 * 「它现在没在做事，在等」。混在一起，一个重连 47 次的子代理在界面上看起来仍然停在半小时前
	 * 那次读文件上——而那恰恰是最需要说话的时刻。
	 *
	 * 之前这里什么都没有：子代理的 `retry` 只进了转录，主对话的抖动提示不解包它（见
	 * `apply-event.ts`），面板也不认识它。于是一次无限重试在界面上是彻底安静的，唯一的迹象是
	 * 一个一直转的 task。
	 *
	 * 接上就清掉——见 `retrying`。
	 */
	retrying?: { attempt: number; reason: string };
	/**
	 * The sub-agent that dispatched this one, by registry id; absent when the main conversation did.
	 *
	 * Enough to draw the lineage: every record names its parent, so the tree is a fold over the
	 * list rather than a second structure to keep in step with it.
	 */
	parentId?: string;
	/** 1 for a sub-agent the main conversation dispatched; each nested dispatch adds one. */
	depth: number;
	/**
	 * Tokens and cost across every request this sub-agent has made, summed as its messages arrive.
	 *
	 * Cost is the brake on orchestration. Fanning out eight sub-agents feels free from the
	 * parent's side — none of their context comes back — and this is where the bill for it shows.
	 */
	usage: Usage;
	/** Set on `done`; the only part the parent ever sees. */
	answer?: string;
	/**
	 * The validated object, when this agent declared an output schema and yielded against it.
	 *
	 * Kept beside the prose rather than instead of it, because they answer different questions:
	 * the text is what a person reads in the pane, and this is what `agent://<id>/<field>` indexes
	 * into so the parent can take one value without re-reading the whole reply.
	 */
	output?: Record<string, unknown>;
	/** Schema problems that were accepted rather than rejected. */
	warnings?: string[];
	/** Set on `failed`. */
	error?: string;
	/**
	 * Whether the answer is what it had rather than what it was asked for.
	 *
	 * True for a run that used up its rounds, went in circles, or lost the provider partway. The
	 * reason is already the first line of `answer` — this exists because that line has to survive
	 * being read quickly: the window strips symbols out of text it did not write (see
	 * `strip-emoji`), so a `⚠` in the prose is not a mark a reader can rely on, and `status` cannot
	 * carry it either — `done` is right for these (the work happened) and `failed` would put an
	 * error where there is a partial result.
	 */
	incomplete?: boolean;
	/**
	 * 停下了，但上下文还留着：派它来的那一方可以让它从停下的地方接着跑。
	 *
	 * 只在不跑的时候为真。界面据此把「重新派发」换成「接着跑」——前者是从零再来一遍，把它读过
	 * 的东西再读一遍；后者只付新增的那几轮。
	 */
	resumable?: boolean;
	/** 被续跑过几次。没有就是一次都没有。 */
	resumes?: number;
	/**
	 * 派它来的那一方已经不等它了。
	 *
	 * 主会话在等子代理的时候，人插了一句话：父会话先去回应人，这个子代理留在后台接着跑，跑完后
	 * 结果由运行时作为一条消息送回主会话（见 `delegation-waits.ts`）。界面据此不再把它算作
	 * 「主会话正卡在它身上」——那正是决定人再说话时要不要等的那件事。
	 */
	background?: boolean;
	/** 它正停在一次授权上，等人在主窗口里点。 */
	awaitingApproval?: boolean;
}
