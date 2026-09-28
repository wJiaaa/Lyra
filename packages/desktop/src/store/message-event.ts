import type { AgentEvent, Message } from "@plume/core";
import type { AppState } from "./index.ts";

type State = Pick<AppState, "messages" | "pendingUserMessage">;
type Event = Extract<AgentEvent, { type: "message_start" | "message_update" | "message_end" }>;

/** The same message identity rules apply on screen and in a parked transcript. */
export function messageEvent(state: State, event: Event, sessionId: string): State {
	const { messages, pendingUserMessage: pending } = state;
	const incoming = event.message;
	const pendingMatch =
		pending &&
		pending.sessionId === sessionId &&
		messages.includes(pending.message);
	if (incoming.role === "user" && pendingMatch) {
		return { messages: messages.map((message) => message === pending.message ? incoming : message), pendingUserMessage: null };
	}

	const at = findMessageSlot(messages, incoming);
	if (event.type === "message_start") {
		if (incoming.role === "assistant" && at >= 0) return state;
		return { ...state, messages: [...messages, incoming] };
	}
	return { ...state, messages: at < 0 ? [...messages, incoming] : messages.map((message, index) => index === at ? incoming : message) };
}

function findMessageSlot(messages: Message[], incoming: Message): number {
	if (incoming.role === "toolResult") {
		return messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === incoming.toolCallId);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const candidate = messages[i];
		if (candidate.role !== incoming.role) continue;
		if (candidate.role === "assistant" && incoming.role === "assistant") {
			if (candidate.stopReason === "pending" || candidate.timestamp === incoming.timestamp) return i;
			return -1;
		}
		if (candidate.timestamp === incoming.timestamp) return i;
	}
	return -1;
}
