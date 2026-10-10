import type { Message } from "@plume/core";

export type TurnStop = "user" | "interrupt" | "error" | null;

/**
 * Whether the conversation was left mid-turn.
 *
 * Two shapes mean the same thing. A reply still marked `pending` never reached its end; a
 * finished reply whose tool calls have no results was cut off between asking for the tools and
 * running them. Either way the work stopped somewhere it did not choose to.
 *
 * Exported because `derive.ts` re-exports it and the tests drive it directly. It used to live
 * there and was copied here when `howItStopped` moved; one of the two had to go, and the one the
 * application actually runs is this one.
 */
export function wasCutShort(transcript: readonly Message[]): boolean {
	const messages = beforePlanTick(transcript);
	/*
	 * A finished turn always ends with the agent saying something.
	 *
	 * Stopping between a tool's result and the reply to it leaves the result as the last message:
	 * the tools all ran, nothing is unanswered, and the old rules below therefore called it
	 * complete — while the one thing the turn was for, the answer, never arrived.
	 */
	if (messages[messages.length - 1]?.role === "toolResult") return true;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "pending") return true;
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.length === 0) return false;
		const answered = new Set(
			messages.slice(i + 1).flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
		);
		return calls.some((call) => call.type === "toolCall" && !answered.has(call.id));
	}
	return false;
}

/**
 * Why a turn ended, as the UI should describe it.
 */
export function howItStopped(transcript: readonly Message[], reason?: string): TurnStop {
	if (reason === "aborted") return "user";
	if (reason === "error") return "error";
	const messages = beforePlanTick(transcript);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "user";
		if (message.stopReason === "error") return "error";
		break;
	}
	return wasCutShort(messages) ? "interrupt" : null;
}

/**
 * 去掉回答之后补勾清单的那一段：[回答] [运行时问清单（core 的 `openPlanNote`）] [只调 todo_write] [它的结果]。
 *
 * 这一轮停在工具结果上，却不是没说完——回答在它前面已经说完了，循环在补勾之后有意不再要一段正文。
 * 只认这一种形状：同样停在 todo_write 结果上、前面却没有那句运行时的话，仍是真被打断（比如勾完清单
 * 正要写回答时退了应用），回答确实没来。
 */
export function beforePlanTick(messages: readonly Message[]): readonly Message[] {
	const ticked = (message: Message | undefined) => message?.role === "toolResult" && message.toolName === "todo_write";
	let at = messages.length - 1;
	while (ticked(messages[at])) at--;
	if (at === messages.length - 1) return messages;
	const tick = messages[at];
	if (tick?.role !== "assistant" || !tick.content.some((part) => part.type === "toolCall")) return messages;
	if (!tick.content.every((part) => (part.type === "toolCall" ? part.name === "todo_write" : part.type !== "text" || !part.text.trim()))) return messages;
	const asked = messages[at - 1];
	const answer = messages[at - 2];
	if (asked?.role !== "user" || !asked.synthetic) return messages;
	if (answer?.role !== "assistant" || answer.content.some((part) => part.type === "toolCall")) return messages;
	return messages.slice(0, at - 1);
}
