import type { Message } from "@plume/core";

/** Only the current completed answer owns the temporary delivery surface. */
export function latestDeliveryTimestamp(messages: readonly Message[], running: boolean): number | null {
	if (running) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" && message.synthetic) continue;
		return message.role === "assistant" && message.stopReason !== "pending" && message.stopReason !== "toolUse" ? message.timestamp : null;
	}
	return null;
}
