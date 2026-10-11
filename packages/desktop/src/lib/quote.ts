/**
 * 从对话里划下来、带进输入框的一段话。
 *
 * 不再直接写成 `> …` 塞进输入框的字里：那样引文和要问的话混在一个框里，长一点的引文能把框撑满，
 * 删也只能一个字一个字删。现在它挂在草稿上，框上方画成一枚「N 条对话引用」，发出去那一刻才拼回
 * Markdown 引用块——模型收到的和从前一模一样。
 */

export interface DraftQuote {
	id: string;
	text: string;
	/** 划的是谁说的话，给引用卡片上那一行出处。 */
	from: "user" | "assistant";
}

/**
 * 写成 Markdown 引用块，后面空一行留给要说的话。
 *
 * 空一行不能省：紧跟在 `> …` 下面的一行在 Markdown 里会被并进引用，问题就成了引文的一部分。
 */
export function quoteBlock(text: string): string {
	const lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
	return `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

/** 引文排在要说的话前面，一段一个引用块。只有引文、没说话时，去掉末尾那行空行。 */
export function withQuotes(text: string, quotes: readonly Pick<DraftQuote, "text">[]): string {
	if (quotes.length === 0) return text;
	return `${quotes.map((quote) => quoteBlock(quote.text)).join("")}${text}`.trimEnd();
}
