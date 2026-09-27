export const INSTRUCTION_BYTE_LIMIT = 100 * 1024;
const MEMORY_LINE_LIMIT = 200;
const MEMORY_CHAR_LIMIT = 25_000;

/** Cut at a UTF-8 boundary, with an explicit path back to the complete instruction file. */
export function budgetInstructions(content: string, path: string): { content: string; truncated: boolean } {
	if (Buffer.byteLength(content, "utf8") <= INSTRUCTION_BYTE_LIMIT) return { content, truncated: false };
	const bytes = Buffer.from(content, "utf8");
	let end = INSTRUCTION_BYTE_LIMIT;
	while ((bytes[end] & 0xc0) === 0x80) end--;
	return { content: `${bytes.subarray(0, end).toString("utf8")}\n\n[Instructions truncated at 100 KiB. Read the complete file at ${JSON.stringify(path)} before acting on rules outside this excerpt.]`, truncated: true };
}

/** Bound the body before adding XML wrappers, so truncation cannot remove the closing tag. */
export function budgetMemory(content: string): string {
	const lines = content.split("\n");
	if (lines.length <= MEMORY_LINE_LIMIT && content.length <= MEMORY_CHAR_LIMIT) return content;
	let excerpt = lines.slice(0, MEMORY_LINE_LIMIT).join("\n");
	if (excerpt.length > MEMORY_CHAR_LIMIT) {
		const newline = excerpt.lastIndexOf("\n", MEMORY_CHAR_LIMIT);
		excerpt = excerpt.slice(0, newline > 0 ? newline : MEMORY_CHAR_LIMIT);
		if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
	}
	return `${excerpt}\n\n[Memory excerpt: limited to 200 lines and 25,000 characters. Consult the project's memory files for details; keep the index concise.]`;
}
