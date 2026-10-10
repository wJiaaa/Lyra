/**
 * What is clickable in the terminal: web addresses, and paths to files in the project.
 *
 * `pnpm dev` prints `http://localhost:5173` and a failing build prints `src/app.ts:42:7`; both were
 * text, to be selected and pasted somewhere else. Now ⌘-click (Ctrl-click off a Mac) opens them —
 * the modifier because a plain click in a terminal is how a selection starts, and iTerm2 and VS
 * Code both ask for it for that reason.
 *
 * Addresses open where links in the conversation open (`settings.browser.openLinks`); Shift sends
 * one to the system browser instead, as it does there. Paths open in the file pane, and only paths
 * that `files.exists` confirms — which answers only inside an open project, so a path the shell
 * printed cannot open a file the file pane would refuse. A relative one that is not there is looked
 * for in the project the way a reply's links are: `pnpm --filter desktop typecheck` prints paths
 * relative to `packages/desktop`, not to the project the terminal is in.
 */

import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { resolveAsset } from "../../lib/markdown/assets.ts";
import { macKeyboard } from "../../ui/keyboard.ts";

export interface LinkActions {
	/** Where a relative path is relative to — the terminal's project; `""` when there is none. */
	base(): string;
	exists(path: string): Promise<boolean>;
	/** The one file in the project a relative path can mean, or null — see `services/locate.ts`. */
	locate(relative: string): Promise<string | null>;
	openUrl(url: string, external: boolean): void;
	openFile(path: string): void;
}

/** ⌘ on a Mac, Ctrl elsewhere: the key that turns a click on a link into opening it. */
export function opensLink(event: MouseEvent, platform = navigator.platform): boolean {
	return macKeyboard(platform) ? event.metaKey : event.ctrlKey;
}

/**
 * A path as compilers, test runners and stack traces print it, with an optional line and column:
 * `src/a.ts:12:3`, `./b.js`, `/abs/c.py:7`, `C:\x\d.cs(12,3)`, or a bare `e.go:9`.
 *
 * Not preceded by anything that would make it the tail of a URL or of a longer word. A path with a
 * separator must end in an extension, which is what keeps directories out — the file pane opens
 * files. A bare name counts only with a line number after it; alone, `index.ts` in a sentence is
 * prose, not a reference.
 */
const PATH = /(?<![\w:/\\.~@+-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w@+-][\w.@+-]*\.[A-Za-z0-9]+|[\w@+-][\w.@+-]*\.[A-Za-z0-9]+(?=:\d))(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?/g;

export interface PathMatch {
	/** The whole match, line suffix included: what gets underlined. */
	text: string;
	/** The path alone. */
	path: string;
	start: number;
	line?: number;
}

export function pathsIn(text: string): PathMatch[] {
	const found: PathMatch[] = [];
	for (const match of text.matchAll(PATH)) {
		const line = match[2] ?? match[4];
		found.push({ text: match[0], path: match[1], start: match.index ?? 0, ...(line ? { line: Number(line) } : {}) });
		if (found.length >= 20) break;
	}
	return found;
}

/**
 * A buffer line as text, and which cell each character is in.
 *
 * `translateToString` loses the second: a Chinese character is one character and two cells, so a
 * path after one was underlined a cell to the left of where it is drawn.
 */
function readLine(line: IBufferLine): { text: string; cellAt: number[] } {
	let text = "";
	const cellAt: number[] = [];
	for (let x = 0; x < line.length; x++) {
		const cell = line.getCell(x);
		if (!cell || cell.getWidth() === 0) continue;
		const chars = cell.getChars() || " ";
		for (let i = 0; i < chars.length; i++) cellAt.push(x);
		text += chars;
	}
	return { text, cellAt };
}

const ABSOLUTE = /^([A-Za-z]:)?[\\/]/;

/** How long an answer from `exists` is trusted: hovering a line asks for every path on it. */
const EXISTS_TTL = 5_000;

export function fileLinks(terminal: Terminal, actions: LinkActions): ILinkProvider {
	const known = new Map<string, { exists: Promise<boolean>; at: number }>();
	const exists = (path: string) => {
		const cached = known.get(path);
		if (cached && Date.now() - cached.at < EXISTS_TTL) return cached.exists;
		const answer = actions.exists(path).catch(() => false);
		known.set(path, { exists: answer, at: Date.now() });
		return answer;
	};
	return {
		provideLinks(y, callback) {
			const line = terminal.buffer.active.getLine(y - 1);
			const base = actions.base();
			if (!line) return callback(undefined);
			const { text, cellAt } = readLine(line);
			const candidates = pathsIn(text).flatMap((match) => {
				const path = resolveAsset(base || "/", match.path);
				// Relative with no project to be relative to: nothing to resolve it against.
				if (!path || (!base && !ABSOLUTE.test(match.path))) return [];
				return [{ match, path }];
			});
			if (candidates.length === 0) return callback(undefined);
			const target = async ({ match, path }: (typeof candidates)[number]) =>
				(await exists(path)) ? path : ABSOLUTE.test(match.path) ? null : actions.locate(match.path).catch(() => null);
			void Promise.all(candidates.map(target)).then((targets) => {
				const links: ILink[] = candidates
					.flatMap(({ match }, i) => (targets[i] ? [{ match, path: targets[i] }] : []))
					.map(({ match, path }) => ({
						text: match.text,
						range: {
							start: { x: cellAt[match.start] + 1, y },
							end: { x: cellAt[match.start + match.text.length - 1] + 1, y },
						},
						activate: (event) => {
							if (opensLink(event)) actions.openFile(path);
						},
					}));
				callback(links.length > 0 ? links : undefined);
			});
		},
	};
}

/** Both kinds, on one terminal. */
export function linkify(terminal: Terminal, actions: LinkActions): void {
	terminal.loadAddon(
		new WebLinksAddon((event, uri) => {
			if (opensLink(event)) actions.openUrl(uri, event.shiftKey);
		}),
	);
	terminal.registerLinkProvider(fileLinks(terminal, actions));
}
