/**
 * 收尾：把跑出来的东西拼成交给派它那一方的答案，在名单上记下它怎么结束的，并留下上下文给续跑。
 *
 * `runSubAgent` 的最后一段，只在运行没抛异常时走到——抛了的在 `sub-agent-run.ts` 里已经记过账。
 */

import type { AgentRunResult } from "../../agent/run-config.ts";
import type { Message } from "../../types.ts";
import type { SubAgentAnswer, SubAgentOptions } from "./sub-agent-options.ts";
import { STOPPED_BY_USER, type Dispatched } from "./sub-agent-dispatch.ts";
import type { SubAgentRan } from "./sub-agent-run.ts";
import { renderYield, YIELD_KEY, type YieldOutcome } from "./yield-tool.ts";

export async function finishSubAgent(
	options: SubAgentOptions,
	{ id, definition, controller, subState, chosen }: Dispatched,
	{ result, produced, view, salvaged, steps }: SubAgentRan,
	ending: { checkpoint: number; envDate: string },
): Promise<SubAgentAnswer> {
	const registry = options.registry;
	/*
	 * A yielded object is the answer; the last thing it said is the fallback.
	 *
	 * Both halves used to be able to come back empty, and between them that is how a sub-agent could
	 * run for half an hour and hand the parent an empty string:
	 *
	 *   - `renderYield` of `{ summary: "", files: [] }` is `""`. The schema check asks whether the
	 *     required fields are present and typed, not whether they were filled in, so that object is
	 *     accepted and delivers nothing. Hence `|| prose` rather than a plain ternary.
	 *   - the fallback read only the *last* assistant message, and the last message of a run that
	 *     hit its round cap, stalled or died mid-request is a bare tool call with no text in it.
	 *     `lastProse` walks back to the newest thing it actually said.
	 */
	const yielded = subState.get(YIELD_KEY) as YieldOutcome | undefined;
	const prose = lastProse(produced);
	const delivered = (yielded ? renderYield(yielded) : "") || prose;

	/*
	 * How it ended, in the answer itself.
	 *
	 * `runTurn` reports its reason and nothing here read it, so a run that used up its rounds, went
	 * in circles, or lost the provider mid-stream was filed as `done` with an empty answer — and the
	 * parent, the transcript and the roster all said the same thing a clean finish says. The parent
	 * has no other channel to learn this on: it sees one string.
	 *
	 * In front of the report rather than after it, because its job is to stop a partial finding
	 * being read as a conclusion — which has to happen before the finding, not after.
	 */
	const aborted = controller.signal.aborted;
	const cutShort = aborted ? null : incompleteNote(result.reason, result.error, salvaged, ending.checkpoint);
	const answer = cutShort ? [cutShort, delivered].filter(Boolean).join("\n\n") : delivered;

	/*
	 * Aborted is not failed, and neither is out of rounds.
	 *
	 * A sub-agent stopped on purpose has done exactly what was asked of it, and recording that as a
	 * failure would put an error in the parent's transcript for a button the user pressed. A run
	 * that used up its rounds or stopped going anywhere is not a failure either — it did the work,
	 * it just did not get to the end of it, and the note above says so. Only a provider that failed
	 * the request is `failed`.
	 */
	const status = aborted ? "aborted" : result.reason === "error" ? "failed" : "done";
	/*
	 * 被按停的那次，也要把它已经交出来的东西留下。
	 *
	 * 这里曾经是干干净净的 `{ status: "aborted" }`——什么都不带。而按停最常发生的时刻，恰恰是它
	 * 已经交付、然后卡在别的什么地方的时候：报告早就在 `state` 里躺着，人等得不耐烦按了停止，
	 * 面板上于是一片空白。派它来的那个模型还能从 `answer` 里读到（下面那行一直是带着的），只有
	 * 看着界面的人什么都拿不到——而按停止的正是他。
	 *
	 * 只带东西，不带 `incomplete`。那个标记会让面板画上「没跑完，只是它手上的一部分」，而按停止
	 * 这件事上面那段已经定过调子了：人按下的按钮不是一桩要报告的事故。带回他的东西，别给他一条
	 * 警告。
	 */
	registry?.finish(
		id,
		aborted
			? { status: "aborted", ...(delivered ? { answer, output: yielded?.value, warnings: yielded?.warnings } : {}) }
			: {
					status,
					answer,
					output: yielded?.value,
					warnings: yielded?.warnings,
					// Same fact the first line of `answer` states, in a form the pane can draw.
					...(cutShort ? { incomplete: true } : {}),
					...(result.error ? { error: result.error } : {}),
				},
	);
	/*
	 * 不管怎么结束的，上下文都留着。
	 *
	 * 跑到检查点的、上游出错的、原地打转的、被按停的、正常做完的——每一种都可能有人想让它接着来：
	 * 接着干完、换个方向、服务恢复后再试、追问一句它刚才说的东西。留着的代价是内存里多一份引用
	 * （消息对象跟转录是同一批），扔掉的代价是下一个从零开始，把它读过的再读一遍。
	 */
	registry?.keep(id, { agent: definition.name, view, state: subState, envDate: ending.envDate, model: chosen.model.id });
	await options.emit({
		type: "subagent_done",
		id,
		steps,
		answer,
		status,
		...(result.error ? { error: result.error } : {}),
	});
	return {
		text: answer,
		output: yielded?.value,
		warnings: yielded?.warnings,
		// 没有登记簿就没有地方留上下文，给了 id 也续不上。
		...(registry ? { id } : {}),
		...(cutShort ? { incomplete: true } : {}),
		...(aborted && controller.signal.reason === STOPPED_BY_USER ? { stoppedByUser: true } : {}),
	};
}

/**
 * The newest thing the run actually said, rather than the newest message.
 *
 * A turn that ends on a tool call has no text in it, so reading the last message alone answers
 * "what did it conclude" with silence for exactly the runs that were cut off — the ones where the
 * question is worth asking.
 */
function lastProse(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * What to say about an ending that was not the end of the work.
 *
 * Written for the parent model first — it is the one that has to decide whether to resume it, take
 * over, or carry on with a partial answer — and read by a person second. Each names the cause and
 * what is left, because "没有输出" gives neither.
 *
 * 从前这里对跑满的那种说「把任务拆小再派一次」。派它来的模型照做了：新派的那个从零开始，读
 * 同样的文件，又跑满，再派，还是跑满——反馈里「重开三个子代理、个个 60 步、最后主会话自己做了」
 * 就是这句话一手促成的。它的上下文明明还在，该说的是「它还在，可以接着跑」。具体怎么续由
 * `task` 在结果末尾交代（那是说给模型的话，面板上用不着）。
 */
function incompleteNote(reason: AgentRunResult["reason"], error: string | undefined, salvaged: boolean, rounds: number): string | null {
	if (reason === "max_turns") {
		return salvaged
			? `⚠ 到了检查点（这一段 ${rounds} 轮），它还没做完。下面是它交的阶段性交接，不是完整结论。它的上下文都还留着，可以接着跑。`
			: `⚠ 到了检查点（这一段 ${rounds} 轮），它还没做完，也没交出交接，下面是它停下前最后说的话。它的上下文都还留着，可以接着跑。`;
	}
	if (reason === "stalled") {
		return "⚠ 它反复用同样的参数调同一个工具、每次拿到的结果都一样，已经停下。下面是它停下前最后说的话，不是完整结论。它的上下文还留着，可以换个方向让它接着跑。";
	}
	if (reason === "error") {
		return `⚠ 模型服务出错，这次派发没跑完${error ? `：${error}` : ""}。下面是它中断前最后说的话，不是完整结论。它的上下文还留着，服务恢复后可以让它接着跑，不必重派。`;
	}
	return null;
}
