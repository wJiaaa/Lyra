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
 * One message rendered as a line of human-readable text.
 *
 * Tool calls make up the vast majority of a transcript, but for the question "how did we solve
 * this last time", what is useful is **what was said**. Tool calls keep one line with their names:
 * leaving them out entirely makes the conversation look like it reached conclusions out of thin
 * air, while laying out their arguments and results means reading someone else's session once
 * spends this session's context.
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
