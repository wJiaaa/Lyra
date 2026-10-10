/**
 * What a terminal is running right now, if it is something other than its shell.
 *
 * Two things read it: the tab, which says 「终端 1 · node」 rather than leaving you to remember which
 * tab has the dev server, and closing, which asks first when closing would end that program.
 *
 * node-pty answers with the name of the tty's foreground process. Windows has no such thing for a
 * ConPTY and reports the shell, so there this is always `null` — no name on the tab, no question on
 * close — rather than a guess.
 */

import { basename } from "node:path";
import type { IPty } from "node-pty";

/** The foreground program, or `null` when it is the shell itself or cannot be told. */
export function foregroundOf(pty: Pick<IPty, "process">, shell: string): string | null {
	let name: string;
	try {
		name = pty.process;
	} catch {
		return null;
	}
	if (!name) return null;
	// A login shell may be listed as `-zsh`; Windows names it with its extension.
	const own = basename(shell.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
	const seen = basename(name.replace(/\\/g, "/")).replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
	return seen === own ? null : basename(name.replace(/\\/g, "/")).replace(/^-/, "");
}

/**
 * Re-read the foreground after output settles, and report only changes.
 *
 * Output is the signal because both ends of a program show up there: the line echoed as Enter starts
 * it, and the prompt drawn when it ends. Read a moment later rather than on every chunk — a build
 * writes thousands of them, and the name does not change between them.
 */
export function watchForeground(
	pty: Pick<IPty, "process">,
	shell: string,
	report: (process: string | null) => void,
	delay = 300,
) {
	let current: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const check = () => {
		timer = null;
		const next = foregroundOf(pty, shell);
		if (next === current) return;
		current = next;
		report(next);
	};
	return {
		poke(): void {
			timer ??= setTimeout(check, delay);
		},
		get current(): string | null {
			return current;
		},
		dispose(): void {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
