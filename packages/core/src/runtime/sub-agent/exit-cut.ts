/**
 * 应用退出时还在后台跑的子代理：重开之后，人下一次开口时一起告诉主会话。
 *
 * 派出即放手以后（`delegation-waits.ts`），`task` 那条结果早就是「已派出」了。进程一没，它的结果
 * 永远不会送回来，而主会话只知道自己在等——人说「继续」，模型要么接着空等，要么从零重派、把读过的
 * 再读一遍。从前 `task` 挂着等的时候，那条调用会被记成「Plume 退出时还在跑」（`live-calls.ts`），
 * 续跑的 id 就在里面；现在这句话得另外说。
 *
 * 不在打开会话时就开一轮：人还没开口，替他花钱去接一件他未必还要的事，不对。
 */

import type { Message } from "../../types.ts";
import { deliveryMessage } from "./delegation-waits.ts";
import type { RestoredSubAgent } from "./sub-agent-restore.ts";

/** 历史里派出去、还没送回过结果、又被退出打断的那些，合成一条送达；没有就是 `null`。 */
export function exitCutDelivery(restored: readonly RestoredSubAgent[], history: readonly Message[]): Message | null {
	// 按历史顺序走：送达过的划掉，之后又续跑出去的再记上。
	const awaited = new Set<string>();
	for (const message of history) {
		if (message.role === "toolResult") {
			const details = message.details as { subAgentId?: unknown; detached?: unknown } | undefined;
			if (details?.detached === true && typeof details.subAgentId === "string") awaited.add(details.subAgentId);
		}
		if (message.role === "user" && message.delivery) for (const report of message.delivery) awaited.delete(report.id);
	}
	const cut = restored.filter((one) => one.cutByExit && awaited.has(one.summary.id));
	if (cut.length === 0) return null;
	return deliveryMessage(cut.map(({ summary, conversation }) => ({ report: { id: summary.id, answer: { text: note(summary.id, Boolean(conversation)), incomplete: true } }, summary })));
}

function note(id: string, resumable: boolean): string {
	return resumable
		? `Plume 退出时它还在跑，没做完，结果也就没能送回来。它的上下文还在：用户还要这件事的话，调 \`task\` 传 \`resume: "${id}"\`，prompt 里写接着做什么——它会从停下的地方继续。不要重新派一个做同样的事。`
		: "Plume 退出时它还在跑，没做完，结果没能送回来，上下文也没能留下。用户还要这件事的话，只能重新派一个。";
}
