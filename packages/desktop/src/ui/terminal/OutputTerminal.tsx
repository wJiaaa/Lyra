import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AppearanceSettings } from "@plume/core";
import { useEffect, useRef } from "react";
import { paletteFromTheme, typography } from "./palette.ts";

/** What feeds the view: called once on mount, returns how to stop. */
export type OutputSource = (sink: { write(text: string): void; reset(): void }) => () => void;

/** Where the view reads its look from. Passed in: a `ui` component does not read the store. */
export interface TerminalLook {
	appearance(): AppearanceSettings | undefined;
	defaults: { codeFont: string; codeFontSize: number };
	/** Called after a theme is written to the document — the only moment its colours can be read. */
	onApplied(listener: () => void): () => void;
}

/**
 * A terminal that only shows: the output of a process the agent started, which has no stdin to type
 * into. Same face and colours as the shell beside it, so a dev server's coloured log reads the way
 * it does there.
 *
 * Fed by the caller rather than by a PTY — where the text comes from (polling a log file) is the
 * caller's business; this owns only the xterm.
 */
export function OutputTerminal({ source, look, maxHeight, label }: { source: OutputSource; look: TerminalLook; maxHeight: number; label: string }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const appearance = look.appearance();
		const theme = paletteFromTheme(appearance);
		// The padding around the grid is the host's, so it has to wear the terminal's surface too.
		element.style.background = theme?.background ?? "";
		const terminal = new Terminal({
			...typography(appearance, look.defaults),
			theme,
			disableStdin: true,
			cursorBlink: false,
			cursorInactiveStyle: "none",
			// A log written through pipes has bare `\n`; without this every line starts where the last ended.
			convertEol: true,
			scrollback: 5000,
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(element);
		// Nothing will ever be typed here, so no cursor sitting at the end pretending otherwise.
		terminal.write("\x1b[?25l");
		const refit = () => { if (element.clientWidth > 0) fit.fit(); };
		/*
		 * As tall as what it holds, up to `maxHeight`, then it scrolls inside.
		 *
		 * A fixed height left two lines of a failed type check above a block of empty surface the size
		 * of twelve. The row height is read off a rendered row rather than worked out from the font:
		 * xterm rounds cells to device pixels, and an estimate drifts a few pixels per dozen lines.
		 */
		const grow = () => {
			const buffer = terminal.buffer.active;
			// Through the cursor's row: one short of it and xterm scrolls the first line away to make room.
			const used = Math.max(2, buffer.baseY + buffer.cursorY + 1);
			const row = element.querySelector(".xterm-rows > div")?.getBoundingClientRect().height || 17;
			const padding = Number.parseFloat(getComputedStyle(element).paddingTop) + Number.parseFloat(getComputedStyle(element).paddingBottom);
			const height = `${Math.min(maxHeight, Math.ceil(used * row + padding))}px`;
			if (element.style.height !== height) { element.style.height = height; refit(); }
		};
		grow();
		const observer = new ResizeObserver(refit);
		observer.observe(element);
		const offTheme = look.onApplied(() => {
			const next = paletteFromTheme(look.appearance());
			terminal.options.theme = next;
			element.style.background = next?.background ?? "";
		});
		const stop = source({ write: (text) => terminal.write(text, grow), reset: () => { terminal.reset(); terminal.write("\x1b[?25l", grow); } });
		return () => { stop(); offTheme(); observer.disconnect(); terminal.dispose(); };
	}, [source, look, maxHeight]);
	return <div ref={host} role="log" aria-label={label} data-output-terminal="" className="overflow-hidden rounded-md px-2 py-1.5" />;
}
