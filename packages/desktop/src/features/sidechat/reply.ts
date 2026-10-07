import type { AssistantMessage } from "@plume/core";

/**
 * 这条回复有没有东西可画——没有就不占行。
 *
 * 回复在 `message_start` 时就进了列表，内容是空的；第一个思考 token 往往要等几秒。那几秒里画出来的
 * 是一个空 `div`，自己高 0，却吃掉外层列的一份 `gap`，把底下的「思考中」先往下顶 10px，字到了再顶
 * 一次。主转录在 `grouping.ts` 的 `written()` 里挡的是同一件事。
 */
export function hasContent(message: AssistantMessage): boolean {
	if (message.stopReason === "error" && message.errorMessage) return true;
	return message.content.some((block) =>
		block.type === "toolCall" ||
		(block.type === "text" && block.text.length > 0) ||
		(block.type === "thinking" && (block.thinking.length > 0 || block.redacted === true)));
}
