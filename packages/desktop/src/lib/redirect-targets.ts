import { splitCommands, splitWords } from "@plume/core/shell-split";

/** `>`, `>>`, `>|`, `&>`, `&>>`, with an optional fd in front; the target may be stuck to it. */
const WRITE = /^(?:\d*>[>|]?|&>>?)(.*)$/s;

/**
 * The files a command line writes its output into, as written in the command.
 *
 * A background job whose output went into a file has an empty log, and an empty box under a
 * failed job reads as "the output was lost". Naming the file says where it went instead.
 * `2>&1` and `>&2` move a stream to another one, not into a file; `/dev/null` keeps nothing.
 * Words come back unquoted, so `echo '>' x` names `x` too. Harmless here: that line prints, so its
 * log is never empty and nobody asks where the output went.
 */
export function redirectTargets(command: string): string[] {
	const found = new Set<string>();
	for (const piece of splitCommands(command)) {
		const words = splitWords(piece);
		for (let i = 0; i < words.length; i++) {
			const match = WRITE.exec(words[i]);
			if (!match) continue;
			const target = match[1] || words[++i];
			if (!target || target.startsWith("&") || target === "/dev/null") continue;
			found.add(target);
		}
	}
	return [...found];
}
