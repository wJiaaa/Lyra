import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal } from "@xterm/xterm";

/**
 * Character widths as the shell counts them.
 *
 * xterm ships Unicode 6's table, where 👍, ⚡ and ✅ are one cell. The shell's libc says two, so
 * the character after an emoji was drawn on top of it (measured: `👍|` put the bar a cell left of
 * `AA|`), and a prompt with an emoji in it put the cursor one cell off for the rest of the line.
 */
export function matchShellWidths(terminal: Terminal): void {
	terminal.loadAddon(new Unicode11Addon());
	terminal.unicode.activeVersion = "11";
}
