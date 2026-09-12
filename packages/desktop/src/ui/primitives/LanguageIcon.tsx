/**
 * A language's own mark, drawn wherever a language is named.
 *
 * The set is 58KB of path data — small for a download and far too large for the first paint, given
 * that most sessions never open a language list at all. So it is a module of its own, fetched the
 * first time one is needed and then held for the life of the window.
 *
 * The fetch is shared rather than per-instance. A language dropdown mounts fifty of these at once;
 * fifty components each starting their own import would be one request and forty-nine promises
 * waiting on it, plus fifty separate re-renders when it lands. Here there is one promise, one
 * module-level cache, and one notification that React batches into a single pass.
 *
 * Until it lands — and for the languages that have no mark — a neutral glyph stands in, rather than
 * a gap that fills in a moment later and shifts the row.
 */

import { useEffect, useReducer } from "react";
import { FileCode2 } from "lucide-react";

import type { LanguageMark } from "../../lib/code/language-icons.ts";

/** The marks, once fetched. Module scope, so every instance in the window shares one copy. */
let marks: Record<string, LanguageMark> | null = null;
/** The fetch in flight, so a hundred simultaneous mounts make one request. */
let pending: Promise<void> | null = null;
/** Instances mounted before the marks arrived, waiting to be told. */
const waiting = new Set<() => void>();

function fetchMarks(): Promise<void> {
	pending ??= import("../../lib/code/language-icons.ts")
		.then((module) => {
			marks = module.LANGUAGE_MARKS;
		})
		.catch(() => {
			// A failed chunk is not worth an error state: every icon simply stays the neutral glyph,
			// which is what an unmapped language shows anyway. Cleared so a later mount may retry.
			pending = null;
		})
		.finally(() => {
			for (const notify of waiting) notify();
			waiting.clear();
		});
	return pending;
}

/**
 * Start the fetch before anything needs to draw.
 *
 * For the control that *opens* a language list: called on the press, the marks are usually there by
 * the time the list paints, and the neutral glyph is never seen. Safe to call repeatedly.
 */
export function preloadLanguageMarks(): void {
	if (!marks) void fetchMarks();
}

export function LanguageIcon({
	language,
	size = 14,
	className = "",
}: {
	/** The catalog's key for the language — `ts`, `rs`, `dockerfile`. */
	language: string;
	size?: number;
	className?: string;
}) {
	const [, redraw] = useReducer((n: number) => n + 1, 0);

	useEffect(() => {
		// Already here: no subscription, no effect body worth running. This is the common case
		// after the first list has been opened.
		if (marks) return;
		waiting.add(redraw);
		void fetchMarks();
		return () => {
			waiting.delete(redraw);
		};
	}, []);

	const mark = marks?.[language];
	if (!mark) {
		return <FileCode2 size={size} strokeWidth={1.8} className={`shrink-0 text-ink-faint ${className}`} aria-hidden />;
	}

	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={`shrink-0 ${className}`}
			/*
			 * The brand colour, and a lifted one for dark surfaces where the mark would otherwise be
			 * invisible — see the generator. `light-dark()` rather than a theme lookup because the
			 * value is static per mark: no subscription, no re-render when the theme changes.
			 */
			style={{ fill: mark.dark ? `light-dark(#${mark.hex}, #${mark.dark})` : `#${mark.hex}` }}
			role="img"
			aria-label={mark.title}
		>
			<path d={mark.path} />
		</svg>
	);
}
