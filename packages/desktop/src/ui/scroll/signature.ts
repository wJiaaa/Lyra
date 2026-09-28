/**
 * A value that changes when the end of a transcript does.
 *
 * `useFollowBottom` needs to answer "has anything actually arrived?" and cannot do it by comparing
 * arrays: opening a conversation hands React the same messages twice — once from the cache, once
 * when the read off disk lands — and those two arrays are different objects holding identical
 * content. An unread flag driven by identity called the second one new content, which is the
 * 「有新内容」 that greeted a conversation nobody had added anything to.
 *
 * So the question is asked of the content instead. Two numbers do it: how many messages there are,
 * and how big the last one is. A reply being written keeps the count and grows the size; a reply
 * finishing and another starting moves the count. A transcript re-read from disk moves neither.
 */

import type { Message } from "@plume/core";

/**
 * How much of a message exists, in whatever unit is cheap and monotonic.
 *
 * Text and reasoning are measured by length because that is what grows a token at a time.
 * Everything else counts as one: a tool call either exists or does not, and its arguments arrive
 * before it is ever shown.
 */
function sizeOf(message: Message): number {
	switch (message.role) {
		case "user":
			return message.content.length;
		case "assistant":
			return message.content.reduce((total, block) => {
				if (block.type === "text") return total + block.text.length;
				if (block.type === "thinking") return total + block.thinking.length;
				return total + 1;
			}, 0);
		default:
			return 0;
	}
}

/**
 * The signature of a transcript's tail.
 *
 * `extra` carries anything outside the message list that also counts as content arriving — how many
 * tool runs exist and how many have settled, a delegate's final report — because those change what
 * is on screen without touching a message.
 *
 * Two messages, not one, and that is not belt-and-braces. A reply that called a tool is still the
 * *pending* message when the tool's result lands behind it, and the store updates it in place (see
 * `findMessageSlot`): the array ends `[…, assistant(pending), toolResult]`, with the message that is
 * actually growing second from last. Asking only the last one yields
 * `toolResult:<fixed timestamp>:0` — a signature frozen for as long as that reply goes on — and a
 * frozen signature means the layout effect that follows the bottom never runs. Widening it is free:
 * both messages are already in hand, and no transcript has a third one changing at the same time.
 */
export function tailSignature(messages: readonly Message[], extra: string | number = ""): string {
	const last = messages[messages.length - 1];
	if (!last) return `-:${extra}`;
	const behind = messages[messages.length - 2];
	return `${last.role}:${last.timestamp}:${sizeOf(last)}:${
		behind ? `${behind.role}:${sizeOf(behind)}` : "-"
	}:${extra}`;
}
