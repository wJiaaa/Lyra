import type { AgentEvent, Message } from "@plume/core/client-types";


interface State { messages: Message[]; pendingUserMessage: { sessionId: string | null; message: Message } | null }
type Event = Extract<AgentEvent, { type: "message_start" | "message_update" | "message_end" }>;

/*
 * The timestamp a message was first drawn with, for messages that took over from an earlier copy.
 *
 * The optimistic copy of a prompt is stamped by the window, the committed one by the runtime a few
 * dozen milliseconds later. Rows are keyed by timestamp, so the swap unmounted the person's own
 * bubble — and the whole turn keyed on it — at the busiest moment of a send. A WeakMap rather than
 * a field: `Message` is core's shape, and which row a message sits in is only the screen's concern.
 */
const firstDrawn = new WeakMap<Message, number>();

/** The timestamp to key this message's row by: the one it was first drawn with. */
export function drawnAt(message: Message): number {
	return firstDrawn.get(message) ?? message.timestamp;
}

function succeeds(incoming: Message, earlier: Message): Message {
	if (incoming !== earlier && drawnAt(earlier) !== incoming.timestamp) firstDrawn.set(incoming, drawnAt(earlier));
	return incoming;
}

/** The same message identity rules apply on screen and in a parked transcript. */
export function messageEvent(state: State, event: Event, sessionId: string): State {
	const { messages, pendingUserMessage: pending } = state;
	const incoming = event.message;
	const pendingMatch =
		pending &&
		pending.sessionId === sessionId &&
		messages.includes(pending.message);
	if (incoming.role === "user" && pendingMatch) {
		return { messages: messages.map((message) => message === pending.message ? succeeds(incoming, message) : message), pendingUserMessage: null };
	}

	const at = findMessageSlot(messages, incoming);
	if (event.type === "message_start") {
		if (incoming.role === "assistant" && at >= 0) return state;
		return { ...state, messages: [...messages, incoming] };
	}
	return { ...state, messages: at < 0 ? [...messages, incoming] : messages.map((message, index) => index === at ? succeeds(incoming, message) : message) };
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
