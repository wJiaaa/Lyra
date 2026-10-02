import type { SideChatUpdate, Message } from "@plume/core";
import { summarizeToolCall } from "../../lib/tool-summary.ts";
import { noticeText } from "../../lib/notice-text.ts";
import { settleTail } from "../../lib/transcript.ts";
import type { ToolRun } from "../../store/tool-run.ts";

export interface SideConversation {
	modelId: string | null;
	messages: Message[];
	toolRuns: Record<string, ToolRun>;
	running: boolean;
	pending: Message | null;
	error: string | null;
}

export function reduceSideEvent(state: SideConversation, event: SideChatUpdate): SideConversation {
	let next: SideConversation = { modelId: state.modelId, messages: state.messages, toolRuns: state.toolRuns, running: state.running, pending: state.pending, error: state.error };
	const get = () => next;
	const set = (patch: Partial<SideConversation>) => { next = { ...next, ...patch }; };
	switch (event.type) {
		case "side_model":
			set({ modelId: event.modelId });
			break;
		case "notice":
			if (event.level === "error") set({ error: noticeText(event) });
			break;
		case "rewound": {
			const messages = get().messages.slice(0, event.messageCount);
			set({ messages, toolRuns: rebuildToolRuns(messages) });
			break;
		}
		case "agent_start":
			set({ running: true });
			break;

		case "message_start": {
			const messages = get().messages;
			// The composer already painted this one; swap in the real copy rather than
			// showing it twice. Matched by reference, so asking the same thing twice is
			// still two messages.
			const pending = get().pending;
			if (event.message.role === "user" && pending && messages.includes(pending)) {
				set({ messages: messages.map((m) => (m === pending ? event.message : m)), pending: null });
				break;
			}
			set({ messages: [...messages, event.message] });
			break;
		}

		case "message_update": {
			const messages = [...get().messages];
			const index = messages.length - 1;
			if (index >= 0 && messages[index].role === "assistant") messages[index] = event.message;
			else messages.push(event.message);
			set({ messages });
			break;
		}

		case "message_end": {
			const messages = [...get().messages];
			const index = findSlot(messages, event.message);
			if (index >= 0) messages[index] = event.message;
			else messages.push(event.message);
			set({ messages });
			break;
		}

		case "tool_start":
			set({
				toolRuns: {
					...get().toolRuns,
					[event.toolCallId]: {
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						summary: event.summary,
						args: event.args,
						status: "running",
						startedAt: Date.now(),
					},
				},
			});
			break;

		case "tool_end": {
			const run = get().toolRuns[event.toolCallId];
			set({
				toolRuns: {
					...get().toolRuns,
					[event.toolCallId]: {
						...(run ?? {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							summary: event.toolName,
							args: {},
							startedAt: Date.now(),
						}),
						status: event.isError ? "error" : "done",
						result: event.result,
						finishedAt: Date.now(),
					},
				},
			});
			break;
		}

		case "agent_end":
			// Same reason as the main store: a dropped connection never sends `message_end`,
			// so the last reply would stay marked as still being written.
			set({ running: false, pending: null, messages: settleTail(get().messages, event) });
			break;
	}
	return next;
}

/** Match an incoming final message to the slot its streaming version occupies. */
function findSlot(messages: Message[], incoming: Message): number {
	if (incoming.role === "toolResult") {
		return messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === incoming.toolCallId);
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

/** Rebuild tool cards when re-attaching to a conversation that ran while the panel was closed. */
export function rebuildToolRuns(messages: Message[]): Record<string, ToolRun> {
	const runs: Record<string, ToolRun> = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				runs[block.id] = {
					toolCallId: block.id,
					toolName: block.name,
					summary: summarizeToolCall(block.name, block.arguments),
					args: block.arguments,
					status: "running",
					startedAt: message.timestamp,
				};
			}
		} else if (message.role === "toolResult") {
			const run = runs[message.toolCallId];
			if (run) {
				run.status = message.isError ? "error" : "done";
				run.result = { content: message.content, details: message.details, isError: message.isError };
				run.finishedAt = message.timestamp;
			}
		}
	}
	return runs;
}
