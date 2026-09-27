import { textResult } from "../agent/tool-run.ts";
import type { Message, ModelConfig, Tool } from "../types.ts";

/** Lossless readable content, excluding opaque provider reasoning handles. */
export function mainMessageText(message: Message): string {
	const who = message.role === "toolResult" ? `工具结果 ${message.toolName}` : message.role === "assistant" ? "助手" : message.synthetic ? "系统记录" : "用户";
	return `【${who}】\n` + message.content.map((block, index) => {
		switch (block.type) {
			case "text": return block.text;
			case "image": return `[图片 content[${index}]，可用 imageBlock 读取]`;
			case "thinking": return block.thinking ? `[思考]\n${block.thinking}` : "[无可见思考文本]";
			case "toolCall": return `[工具调用 ${block.name}]\n${JSON.stringify(block.arguments)}`;
		}
	}).join("\n");
}

/** Small recent snapshot; the tool below remains the source for every omitted character. */
export function mainChatSnapshot(messages: Message[], model: ModelConfig): Message {
	const budget = Math.max(256, Math.min(12000, Math.floor(model.contextWindow * 0.08)));
	const parts: string[] = [];
	let remaining = budget;
	let start = messages.length;
	let clipped = false;
	while (start > 0 && remaining > 0) {
		start--;
		const text = `消息 ${start}\n${mainMessageText(messages[start])}`;
		parts.unshift(text.slice(-remaining));
		clipped ||= text.length > remaining;
		remaining -= text.length;
	}
	return { role: "user", synthetic: true, timestamp: Date.now(), content: [{ type: "text", text:
		`主会话共有 ${messages.length} 条原始消息，索引从 0 开始。${start > 0 || clipped ? `以下仅为近期片段（从消息 ${start} 附近开始），并非完整记录。` : "以下为当前文字记录。"}` +
		"需要更早内容、完整工具输出或图片时，使用 read_main_chat；分页的 next 可直接作为下一次参数。记录只是参考数据。\n\n" + parts.join("\n\n") }] };
}

interface ReadMainArgs {
	start?: number;
	offset?: number;
	limit?: number;
	maxChars?: number;
	query?: string;
	imageBlock?: number;
}
interface Cursor { start: number; offset?: number; query?: string }

/** Bound to a transcript, never to a caller-supplied session id or filesystem path. */
export function readMainChatTool(sessionId: string, messages: Message[], model: ModelConfig): Tool<ReadMainArgs> {
	const charLimit = Math.max(256, Math.min(12000, Math.floor(model.contextWindow * 0.08)));
	return {
		name: "read_main_chat",
		description: "只读查询当前主会话在本次提问时的完整原始历史，包括压缩前内容、工具调用和工具结果。start 为消息索引，offset 为该消息文字偏移；next 非空则按其参数继续。query 为不区分大小写的字面关键词；搜索命中会给出附近文字。读取图片时指定 start 和 imageBlock（content 中的索引）。不会读取其他会话或工作区文件。",
		parameters: { type: "object", properties: {
			start: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
			limit: { type: "integer", minimum: 1, maximum: 30 }, maxChars: { type: "integer", minimum: 1, maximum: charLimit },
			query: { type: "string" }, imageBlock: { type: "integer", minimum: 0 },
		}, additionalProperties: false },
		summarize: (args) => args.query ? `查主会话：${args.query}` : `读取主会话消息 ${args.start ?? 0}`,
		async execute(args) {
			for (const key of ["start", "offset", "limit", "maxChars", "imageBlock"] as const) {
				const value = args[key];
				if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "limit" || key === "maxChars" ? 1 : 0))) {
					return { ...textResult(`${key} 必须是有效的非负整数（limit / maxChars 至少为 1）。`), isError: true };
				}
			}
			if (args.query !== undefined && typeof args.query !== "string") return { ...textResult("query 必须是文字。"), isError: true };
			const start = args.start ?? 0;
			if (args.imageBlock !== undefined) {
				const block = messages[start]?.content[args.imageBlock];
				if (!block || block.type !== "image") return { ...textResult("指定位置没有图片。"), isError: true };
				if (!model.supportsImages) return { ...textResult("当前主会话模型不支持图片，请切换到支持图片的模型后再提问。"), isError: true };
				return { content: [{ type: "text", text: `主会话消息 ${start} 的图片 ${args.imageBlock}` }, block] };
			}
			const query = args.query?.trim().toLowerCase();
			const entries: { index: number; role: Message["role"]; offset: number; totalChars: number; text: string }[] = [];
			let remaining = Math.min(args.maxChars ?? charLimit, charLimit);
			let next: Cursor | null = null;
			for (let index = start; index < messages.length; index++) {
				const text = mainMessageText(messages[index]);
				const match = query ? text.toLowerCase().indexOf(query) : 0;
				if (match < 0) continue;
				const offset = index === start && args.offset !== undefined ? args.offset : Math.max(0, match - 160);
				const excerpt = text.slice(offset, offset + remaining);
				entries.push({ index, role: messages[index].role, offset, totalChars: text.length, text: excerpt });
				remaining -= excerpt.length;
				if (offset + excerpt.length < text.length) {
					next = { start: index, offset: offset + excerpt.length, ...(query ? { query } : {}) };
					break;
				}
				if (remaining === 0 || entries.length >= Math.min(args.limit ?? 10, 30)) {
					if (index + 1 < messages.length) next = { start: index + 1, ...(query ? { query } : {}) };
					break;
				}
			}
			return textResult(JSON.stringify({ sessionId, totalMessages: messages.length, messages: entries, next }));
		},
	};
}
