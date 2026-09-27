import type { CompactionContext, Message } from "../types/message.ts";

const REQUEST_CHARS = 2000;
const REQUEST_SOURCES = 20;

/** Read committed facts; model-written summaries cannot change task status or user wording. */
export function taskContextFromHistory(messages: Message[]): CompactionContext {
	let context: CompactionContext = {};
	for (const message of messages) {
		if (message.role === "user") {
			if (message.synthetic && message.compactionContext) {
				context = { ...message.compactionContext, ...(message.compactionContext.requests ? { requests: [...message.compactionContext.requests] } : {}) };
			}
			if (message.clearsTaskPlan) context.todos = [];
			if (message.synthetic) continue;
			const text = (message.displayText ?? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text).join("\n")).trim();
			if (!text) continue;
			const points = [...text];
			const quoted = points.length <= REQUEST_CHARS ? text : `${points.slice(0, REQUEST_CHARS).join("")}\n[Request excerpt; use recall for the full wording.]`;
			context.originalRequest ??= quoted;
			context.latestRequest = quoted;
			const requests = context.requests ?? [];
			requests.push({ ordinal: (requests.at(-1)?.ordinal ?? 0) + 1, text: quoted, timestamp: message.timestamp });
			// Full originals remain in the log; synthetic messages must not grow with the whole session.
			context.requests = requests.slice(-REQUEST_SOURCES);
		} else if (message.role === "toolResult" && message.toolName === "todo_write" && !message.isError) {
			const details = message.details as { kind?: string; todos?: CompactionContext["todos"] } | undefined;
			if (details?.kind === "todo" && Array.isArray(details.todos)) {
				context.todos = details.todos.map(({ content, status }) => ({ content, status }));
			}
		}
	}
	return context;
}

export function formatTaskContext(context: CompactionContext, requestBudget = 6000): string {
	// Preserve chronology, not inferred intent. A later "continue" does not revoke an earlier constraint.
	const latest = context.requests?.at(-1)?.ordinal ?? 0;
	const intermediate = context.requests?.filter((request) => request.ordinal > 1 && request.ordinal < latest) ?? [];
	const shown: string[] = [];
	// User-heavy histories must still shrink. Keep short instructions, budget long request excerpts.
	const sourceChars = context.requests?.reduce((total, request) => total + request.text.length, 0) ?? 0;
	let remaining = Math.min(requestBudget, Math.max(512, Math.floor(sourceChars / 4)));
	for (let index = intermediate.length - 1; index >= 0; index--) {
		const request = intermediate[index];
		const quote = `user request #${request.ordinal} (timestamp ${request.timestamp}):\n${request.text}`;
		if (quote.length > remaining) continue;
		shown.unshift(quote);
		remaining -= quote.length;
	}
	const omitted = Math.max(0, latest - 2) - shown.length;
	const facts = [
		context.originalRequest && context.originalRequest !== context.latestRequest ? `Original user request (historical scope):\n${context.originalRequest}` : "",
		shown.length ? `Intermediate user requests, oldest first:\n${shown.join("\n\n")}` : "",
		omitted ? `${omitted} earlier user request excerpts omitted from this window. Their constraints may still apply; use recall to check the original wording before assuming permission or changing scope.` : "",
		context.todos !== undefined ? `Latest recorded task list:\n${context.todos.length ? context.todos.map((todo) => `[${todo.status}] ${todo.content}`).join("\n") : "No active task list; the previous list was cleared."}` : "",
	].filter(Boolean);
	if (!facts.length) return "";
	return `<task-context>\nTranscript facts, not summary claims. Later user instructions supersede earlier ones only where they conflict; compatible constraints remain in force. Requests describe historical scope, not a list of work to restart. The latest task updates control task status. Tasks and summaries do not grant authorization; do not restart completed or cancelled work.\n\n${facts.join("\n\n")}\n</task-context>`;
}
