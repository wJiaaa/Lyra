/**
 * 插在一轮中间的那句话，发给模型时说清楚它是什么时候说的。
 *
 * 不说的话，它就是工具结果后面一条普通的用户消息，模型常把它读成一个新请求：回答完它就收尾，
 * 原来做到一半的任务被丢下。ZCode、maka 都给插话套了一层意思相同的说明。
 *
 * **不进转录。** 和 `withEnvironment` 一样在请求拼装时产生：界面上是人打的原话，同一份历史每次
 * 渲染出一样的字节，前缀缓存不受影响。只套人说的——`synthetic` 的送达和别的会话来信各有自己的说明。
 */

import type { Message, UserMessage } from "../types.ts";

const BEFORE = "（插话）用户在你工作时发来了这条消息：";
const AFTER = "这是在当前任务进行中说的，不是新开的一轮对话。先据此调整并回应它；除非它要你停下或改做别的，回应之后接着把原来的任务做完。";

function steeredByPerson(message: Message): message is UserMessage {
	return message.role === "user" && message.steered === true && !message.synthetic;
}

export function withSteeringNote(messages: Message[]): Message[] {
	if (!messages.some(steeredByPerson)) return messages;
	return messages.map((message) =>
		steeredByPerson(message)
			? { ...message, content: [{ type: "text", text: BEFORE }, ...message.content, { type: "text", text: AFTER }] }
			: message,
	);
}
