/**
 * What `session://` reads: the recent conversations, and one of them as lines a model can skim.
 *
 * Given two methods of the store rather than the store: this address reads transcripts, and should
 * not come with the ability to delete a session.
 */

import type { SessionLookup } from "../resources/more-handlers.ts";
import type { SessionStorage } from "../session/storage.ts";
import type { Message } from "../types.ts";

/**
 * 一条消息渲染成一行给人读的文本。
 *
 * 转录里工具调用占绝大多数，而对「上次我们怎么解决这个的」这个问题，有用的是**说过的话**。
 * 工具调用留一行名字：完全不提会让对话看起来像凭空得出结论，而把参数和结果都铺开，
 * 读一次别人的会话就要花掉这次会话的上下文。
 */
function renderMessage(message: Message): string {
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();

	if (message.role === "user") return message.synthetic ? "" : `用户：${text}`;
	if (message.role !== "assistant") return "";

	const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []));
	const parts = [text && `助手：${text}`, calls.length > 0 && `（调用了 ${calls.join("、")}）`].filter(Boolean);
	return parts.join("\n");
}

export function sessionLookup(store: Pick<SessionStorage, "listSessions" | "get" | "messages">): SessionLookup {
	return {
		recent: async (limit) =>
			(await store.listSessions())
				.filter((meta) => !meta.archived)
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, limit)
				.map((meta) => ({ id: meta.id, title: meta.title ?? "", updatedAt: meta.updatedAt })),
		transcript: async (id) => {
			const meta = await store.get(id);
			if (!meta) return null;
			const messages = await store.messages(id);
			return { title: meta.title ?? "", lines: messages.map(renderMessage).filter(Boolean) };
		},
	};
}
