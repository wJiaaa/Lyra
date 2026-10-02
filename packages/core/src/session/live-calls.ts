/**
 * Tool calls in flight, and what each one becomes when the process running it dies.
 *
 * A call's result is written when the call returns. A process that exits first — a crash, or a quit
 * whose `dispose` never finishes — used to leave only the gap: the reply that asked for the call,
 * and nothing after it. Reopened, the card had nothing to show but a red cross, and the model was
 * told by `sanitizeToolPairing` that the call "may or may not have taken effect" whatever had
 * happened — including when it had sat waiting for an approval nobody gave, and so certainly had not.
 *
 * So the session records how far each call got while it runs (`live_calls`), and the store turns
 * what a dead owner left into results once, the way `settlePartial` does for a reply. Nothing is
 * re-run: whether to try again is the model's call, made from an accurate account of what happened.
 * The choice of recording facts over resuming execution is ADR-0033.
 */

import type { AssistantContent, AssistantMessage, Message, ToolResultMessage } from "../types.ts";

/**
 * How far a call got. `running` from `tool_start` on, whatever the tool is doing; `approval` while
 * it waits for a person, which is the one stage a call is known not to have acted from.
 */
export type CallPhase = "running" | "approval";

export interface CallSink {
	/** A call is starting. Until its result is written, a dead owner leaves it for `settleCalls`. */
	openCall(sessionId: string, callId: string): Promise<void>;
	markCall(sessionId: string, callId: string, phase: CallPhase): Promise<void>;
	/** What the call has printed so far, the same text its card shows. */
	saveCallOutput(sessionId: string, callId: string, output: string): Promise<void>;
}

export interface LiveCall {
	callId: string;
	phase: CallPhase;
	output: string | null;
}

/**
 * How much of a call's output survives it.
 *
 * The tail, because a command that died is explained by where it stopped. Enough for a build's last
 * errors or a test run's summary; the result is read on every later request, so not the whole log.
 */
export const KEPT_OUTPUT_CHARS = 8_000;

/** How often a running call's output is written down. Bounds what a crash loses of it. */
export const OUTPUT_SAVE_MS = 1_000;

type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;

/**
 * The round a dead process left open: the newest reply, when it asked for tools, with the calls
 * that already have results.
 *
 * Null when anything but results follows that reply — a later message means the conversation moved
 * on, and a result appended now would land after it, where no provider accepts it.
 */
export function openRound(messages: readonly Message[]): { reply: AssistantMessage; answered: Set<string> } | null {
	const answered = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "toolResult") {
			answered.add(message.toolCallId);
			continue;
		}
		if (message.role !== "assistant" || !message.content.some((block) => block.type === "toolCall")) return null;
		return { reply: message, answered };
	}
	return null;
}

/** What to tell the model about a call that never returned. */
export function interruptedResult(call: ToolCall, live: LiveCall | undefined, at: number): ToolResultMessage {
	const base = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, isError: true, timestamp: at };
	if (!live || live.phase === "approval") {
		const text = live
			? "Not run: Plume exited while this call was waiting for approval, so it never started. Issue it again if it is still needed."
			: "Not run: Plume exited before this call started. Issue it again if it is still needed.";
		// Nothing happened, so not a failure: drawn like a call the person stopped.
		return { ...base, content: [{ type: "text", text }], details: { cancelled: true, interrupted: live ? "approval" : "not_started" } };
	}
	const output = live.output?.trim() ? `\n\nOutput before it stopped:\n${live.output.slice(-KEPT_OUTPUT_CHARS)}` : "";
	return {
		...base,
		content: [{ type: "text", text: `Interrupted: Plume exited while this call was running, so it never returned. It may or may not have taken effect; check the current state before running it again.${output}` }],
		details: { interrupted: "running" },
	};
}

/** The text of a progress update, as the card shows it. */
export function progressText(content: readonly { type: string; text?: string }[]): string {
	return content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
}
