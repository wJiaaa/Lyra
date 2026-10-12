/**
 * What did not draw in the model's interface blocks, told to it on its next turn.
 *
 * Without this the model never learns: a prop it misremembers is dropped where it is drawn, the
 * reply looks finished to it, and the same prop comes back in every block after. The note goes on
 * the next thing the person says — the first moment the model is listening again — and says which
 * element, which prop, and what happened to it.
 *
 * **Not in the transcript.** Built while the request is assembled, like `withSteeringNote`: worked
 * out from the history alone, so the same history always renders the same bytes and the prompt
 * cache is untouched. A history with no blocks, or none with problems, comes back as it was.
 */

import type { Message } from "../types.ts";
import { COMPONENTS } from "./catalog.ts";
import { checkBlock } from "./check.ts";

/** The ```ui blocks in a piece of Markdown, closing fence or not. */
export function interfaceBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	const lines = markdown.split("\n");
	for (let at = 0; at < lines.length; at++) {
		const open = /^\s*(`{3,}|~{3,})ui\s*$/.exec(lines[at]!);
		if (!open) continue;
		const body: string[] = [];
		const close = new RegExp(`^\\s*${open[1]![0] === "`" ? "`" : "~"}{${open[1]!.length},}\\s*$`);
		for (at++; at < lines.length && !close.test(lines[at]!); at++) body.push(lines[at]!);
		blocks.push(body.join("\n"));
	}
	return blocks;
}

/**
 * Components written straight into the prose, outside any fence: the reply shows them as text.
 *
 * Told to the model rather than drawn anyway — a reply quoting `<Card>` while explaining it would
 * otherwise turn into a control. Only a line that opens with a catalog component counts.
 */
export function unfencedComponents(markdown: string): string[] {
	const names = new Set<string>();
	const lines = markdown.split("\n");
	for (let at = 0; at < lines.length; at++) {
		const fence = /^\s*(`{3,}|~{3,})/.exec(lines[at]!);
		if (fence) {
			const close = new RegExp(`^\\s*${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}\\s*$`);
			for (at++; at < lines.length && !close.test(lines[at]!); at++);
			continue;
		}
		const tag = /^ {0,3}<([A-Z]\w*)[\s/>]/.exec(lines[at]!);
		if (tag && Object.hasOwn(COMPONENTS, tag[1]!)) names.add(tag[1]!);
	}
	return [...names];
}

function problemsIn(messages: Message[]): string[] {
	const problems: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			for (const source of interfaceBlocks(block.text)) problems.push(...checkBlock(source));
			const bare = unfencedComponents(block.text);
			if (bare.length) problems.push(`${bare.map((name) => `<${name}>`).join(" ")}: outside a \`\`\`ui fence, shown as plain text`);
		}
	}
	return [...new Set(problems)];
}

export function withInterfaceNotes(messages: Message[]): Message[] {
	let out: Message[] | null = null;
	let since = 0;
	for (let at = 0; at < messages.length; at++) {
		const message = messages[at]!;
		if (message.role !== "user" || message.synthetic) continue;
		const problems = problemsIn(messages.slice(since, at));
		since = at + 1;
		if (!problems.length) continue;
		out ??= [...messages];
		out[at] = {
			...message,
			content: [
				...message.content,
				{ type: "text", text: `<env>\n你上一条回复里的界面块有几处没按写的画出来，下次照 \`plume://ui\` 的写法来：\n${problems.map((problem) => `- ${problem}`).join("\n")}\n</env>` },
			],
		};
	}
	return out ?? messages;
}
