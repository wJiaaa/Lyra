import type { AgentEvent, Message } from "@plume/core/client-types";
import { tailProse } from "./running.ts";


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

/*
 * 回复末尾那段正文上一次变长是什么时候。
 *
 * 运行行看这个判断字是不是还在落（`STALL_MS`）。从前那个钟长在画运行行的组件里，从它**看见**长度变了
 * 起算：切到别的会话再切回来，看见的长度换了两次，钟就重新走一遍——字明明已经停了一分钟，运行行
 * 还是要再藏 2.5 秒，模型说完一段话接着想的那段时间里，切回来就是一片空白。记在消息合并这一步，
 * 后台会话收到的每一次更新也经过这里，时刻就是字真正落下来的时刻。
 *
 * 只在前后长度不同时记新时刻；长度没变就沿用前一份的。没有记录（从快照读进来的）就当它没在写。
 */
const proseAt = new WeakMap<Message, number>();

/** 这条回复的正文最后一次变长的时刻；不知道就是 `undefined`。 */
export function proseGrewAt(message: Message | undefined): number | undefined {
	return message ? proseAt.get(message) : undefined;
}

function grew(incoming: Message, earlier: Message | undefined): void {
	const length = tailProse(incoming);
	if (length === null || incoming === earlier) return;
	const before = earlier ? proseAt.get(earlier) : undefined;
	if (earlier && tailProse(earlier) === length) {
		if (before !== undefined) proseAt.set(incoming, before);
		return;
	}
	proseAt.set(incoming, Date.now());
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
		grew(incoming, undefined);
		return { ...state, messages: [...messages, incoming] };
	}
	grew(incoming, at < 0 ? undefined : messages[at]);
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
