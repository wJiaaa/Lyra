/**
 * 一轮收尾、缓存还热的时候，把已经越过触发线的历史先压掉。
 *
 * 自动压缩原本只在每次请求之前看一眼（`agent/loop.ts` 的 `prepareHistory`）。一轮里的下一步紧跟在
 * 工具后面，缓存是热的；可越线常常发生在一轮的最后一次回复上，下一次请求要等人回来再说话——隔了
 * 五分钟以上，缓存已经过期，那次压缩只能走不吃缓存的独立请求。这里改在人还没开口时就分叉压掉：
 * 前缀几秒前刚写进缓存，摘要请求基本只付输出的钱，等待也落在人打字的那段时间里。
 *
 * 只做「热的分叉」这一种。缓存凉了、换了模型、没有可分叉的请求，就什么也不做，留给下一轮开头
 * 照原来的办法压——提前做一次凉的独立请求不省钱，人还可能根本不回来。
 *
 * 走的是和手动压缩同一把锁（`SessionActivity.compact`）：期间来的消息排在它后面，停止按钮能停下它。
 */

import { sessionPruner } from "../agent/aged-prune.ts";
import { compactStep } from "../agent/compact-step.ts";
import { lineageFrom } from "../agent/lineage.ts";
import { requestView } from "../agent/loop.ts";
import { resolveModel } from "../config/settings.ts";
import { textTokens, toolTokens } from "../tokens.ts";
import { compactWith } from "./compaction.ts";
import { forkable } from "./compaction-fork.ts";
import type { CompactionParts } from "./manual-compaction.ts";
import { compactionSpent, modelHistory, summaryStream } from "./session-turn.ts";

/** 越线且能热分叉时压一次。返回是否真的写下了一条边界。 */
export async function idleCompaction(parts: CompactionParts, signal: AbortSignal): Promise<boolean> {
	const { log, can } = parts;
	const settings = parts.settings();
	const resolved = resolveModel(settings, log.meta.modelId || settings.defaultModelId);
	if (!resolved) return false;
	const { provider, model } = resolved;
	await parts.preparePruner();
	const pruner = sessionPruner(can.state);
	const artifacts = { keep: (tool: string, content: string) => can.keepArtifact(tool, content) };
	// 和下一轮开头循环要发的同一份：剪枝器记下的视图，再接上日期块。
	const messages = pruner.prepare(modelHistory(log, provider, model), artifacts);
	const lineage = lineageFrom(can.state, requestView(messages, true));
	if (!forkable(lineage, provider, model)) return false;

	const result = await compactStep(
		{
			compact: (history, activeModel, observer, options) => compactWith({
				messages: history,
				model: activeModel,
				provider,
				streamFn: summaryStream(parts.streamFn, { retryPolicy: () => parts.settings().retryPolicy, signal }, compactionSpent(log)),
				overhead: textTokens(lineage.sent.systemPrompt) + toolTokens(lineage.sent.tools),
				artifacts,
				observer,
				lineage: options?.lineage,
			}),
			pruner,
		},
		signal,
		messages,
		model,
		parts.emit,
		{ provider, lineage, idle: true },
	);
	return result?.kept !== undefined;
}
