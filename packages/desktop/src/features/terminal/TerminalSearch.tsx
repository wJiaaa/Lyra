/**
 * Find in the terminal's scrollback — ⌘F, or Ctrl+Shift+F off a Mac (see `terminalKey`).
 *
 * Five thousand lines of a build log were only reachable by scrolling. This searches what xterm
 * holds, highlights every match and counts them; Enter and Shift+Enter step through, Escape closes
 * and hands the keyboard back to the shell.
 *
 * Floating in the terminal's corner, over the output, the way VS Code and Windows Terminal place it:
 * a bar across the top would push every row down and reflow the shell on each open and close.
 */

import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { useEffect, useRef, useState } from "react";
import { translate } from "../../i18n/translate.ts";
import { ChevronDown, ChevronUp, X } from "../../ui/icons/index.ts";
import { IconButton } from "../../ui/primitives/IconButton.tsx";

/**
 * The highlight colours. xterm takes `#RRGGBB` only, so these cannot be CSS variables; amber on
 * both schemes, light under dark text and deep under light text, so the matched text stays legible.
 */
function decorations(): NonNullable<ISearchOptions["decorations"]> {
	const dark = document.documentElement.classList.contains("dark");
	return dark
		? { matchBackground: "#5c4813", matchOverviewRuler: "#a8862c", activeMatchBackground: "#a8740a", activeMatchColorOverviewRuler: "#e0a526" }
		: { matchBackground: "#fde9a8", matchOverviewRuler: "#e0b84a", activeMatchBackground: "#f7c04a", activeMatchColorOverviewRuler: "#c98a00" };
}

export function TerminalSearch({ search, request, onClose }: {
	search: SearchAddon;
	/** Bumped by every ⌘F, so pressing it again with the bar open goes back to the query. */
	request: number;
	onClose(): void;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<{ index: number; count: number } | null>(null);
	const input = useRef<HTMLInputElement>(null);

	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, [request]);

	useEffect(() => {
		const off = search.onDidChangeResults(({ resultIndex, resultCount }) => setResults({ index: resultIndex, count: resultCount }));
		return () => {
			off.dispose();
			search.clearDecorations();
		};
	}, [search]);

	// Searched as it is typed, starting from the match already in front rather than skipping past it.
	useEffect(() => {
		if (!query) {
			search.clearDecorations();
			setResults(null);
			return;
		}
		search.findNext(query, { incremental: true, decorations: decorations() });
	}, [query, search]);

	const step = (back: boolean) => {
		if (!query) return;
		if (back) search.findPrevious(query, { decorations: decorations() });
		else search.findNext(query, { decorations: decorations() });
	};

	const none = query.length > 0 && results !== null && results.count === 0;

	return (
		<div
			data-terminal-search
			className="ly-menu-card absolute top-2 right-3 z-10 flex items-center gap-0.5 border border-line-float py-0.5 pr-1 pl-2.5"
		>
			<input
				ref={input}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					} else if (event.key === "Enter") {
						event.preventDefault();
						step(event.shiftKey);
					}
				}}
				placeholder={translate("terminal.findPlaceholder")}
				aria-label={translate("terminal.findPlaceholder")}
				spellCheck={false}
				className={`w-44 bg-transparent text-label outline-none placeholder:text-ink-faint ${none ? "text-danger" : "text-ink"}`}
			/>
			<span className="min-w-[4.5em] shrink-0 text-right text-detail text-ink-faint tabular-nums">
				{none ? translate("terminal.findNone") : results && results.count > 0 ? `${results.index + 1}/${results.count}` : ""}
			</span>
			<IconButton size="sm" label={translate("common.previous")} icon={<ChevronUp size={15} />} disabled={!query || none} onClick={() => step(true)} />
			<IconButton size="sm" label={translate("common.next")} icon={<ChevronDown size={15} />} disabled={!query || none} onClick={() => step(false)} />
			<IconButton size="sm" label={translate("common.close")} icon={<X size={15} />} onClick={onClose} />
		</div>
	);
}
