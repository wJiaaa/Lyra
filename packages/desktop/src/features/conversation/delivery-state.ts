import type { Message } from "@plume/core";
import { beforePlanTick } from "../../store/turn-stop.ts";

/** Only the current completed answer owns the temporary delivery surface. */
export function latestDeliveryTimestamp(transcript: readonly Message[], running: boolean): number | null {
	if (running) return null;
	// 回答之后补勾清单的那一段不算新的回答，交付仍归那条回答。
	const messages = beforePlanTick(transcript);
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.synthetic) continue;
		return message.role === "assistant" && message.stopReason !== "pending" && message.stopReason !== "toolUse" ? message.timestamp : null;
	}
	return null;
}
