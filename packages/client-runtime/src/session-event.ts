import type { AgentEvent } from "@plume/core/client-types";
import { messageEvent } from "./message-event.ts";
import type { SessionSnapshot } from "./types.ts";

export function applySessionEvent(state: SessionSnapshot, event: AgentEvent): SessionSnapshot {
	switch (event.type) {
		case "message_start":
		case "message_update":
		case "message_end": {
			const existing = state.messages.find((message) => message.role === event.message.role && message.timestamp === event.message.timestamp);
			// 快照读取期间的事件可能已在快照里；旧分片不能覆盖已完成的回复。
			if (event.type === "message_start" && existing) return state;
			if (event.type === "message_update" && existing?.role === "assistant" && existing.stopReason !== "pending") return state;
			return { ...state, messages: messageEvent({ messages: state.messages, pendingUserMessage: null }, event, state.meta.id).messages };
		}
		case "agent_start": return { ...state, running: true };
		case "agent_end": return { ...state, running: false };
		case "approval_request": return { ...state, pendingApprovals: [...state.pendingApprovals.filter((request) => request.id !== event.requestId), { ...event, kind: event.kind as SessionSnapshot["pendingApprovals"][number]["kind"], id: event.requestId }] };
		case "approval_settled": return { ...state, pendingApprovals: state.pendingApprovals.filter((request) => request.id !== event.requestId) };
		default: return state;
	}
}
