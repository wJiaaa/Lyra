/**
 * The terminal's colours and type, read from the live theme — shared by the shell and by the
 * read-only view of a background job's output, so the two look like the same kind of thing.
 */

import type { Terminal } from "@xterm/xterm";
import type { AppearanceSettings } from "@plume/core";
import { findCodeTheme } from "../../lib/code/themes.ts";
import { type CodeTypography, terminalTypography } from "./typography.ts";

function readVar(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 代码外观, translated into the options xterm understands — see `typography.ts` for which of the
 * four settings the terminal follows and which it must not.
 *
 * One function for both uses — building the terminal and updating it — because they had drifted
 * apart in exactly the way two copies do: the constructor hard-coded `lineHeight: 1.35`, so the
 * settings had no path here at all. The fallbacks come from the live
 * CSS variables, which is what the rest of the app renders with before settings have loaded.
 */
export function typography(appearance: CodeTypography | undefined, defaults: { codeFont: string; codeFontSize: number }) {
	return terminalTypography(appearance, {
		font: readVar("--ly-code-font") || defaults.codeFont,
		size: Number.parseFloat(readVar("--text-code")) || defaults.codeFontSize,
	});
}

/**
 * xterm needs literal colours, so the palette is read out of the live CSS variables.
 *
 * The sixteen ANSI slots are fixed rather than derived: they are what programs mean by "red"
 * and "green", and remapping them to the app's accent would make `git diff` lie about which
 * lines were added.
 */
export function paletteFromTheme(appearance?: AppearanceSettings): Terminal["options"]["theme"] {
	const dark = document.documentElement.classList.contains("dark");
	/*
	 * The code theme's surface, not the app's chrome.
	 *
	 * These read `--color-shell` and `--color-ink` — the *UI* tokens — so the terminal followed
	 * the window's background and had no connection to 代码高亮主题 at all. Choosing Solarized
	 * Light gave the editor its warm surface and left the terminal on the app's white, which is
	 * the seam you notice: two panes side by side, both showing code, only one of them themed.
	 *
	 * The sixteen ANSI slots below stay as they are, deliberately. They are what programs mean by
	 * "red" and "green", and remapping them to a theme's palette would make `git diff` lie about
	 * which lines were added.
	 */
	/*
	 * Which code theme is chosen comes from the settings object; whether it is dark, and the
	 * background an inheriting theme takes, from the document.
	 *
	 * Reading the document is only right after `applyAppearance` has written it — from a component's
	 * own effect it is the theme being left, because `App`'s effect writes it and React runs a
	 * child's effects first. So a theme change reaches the terminal through `onAppearanceApplied`,
	 * and the only other caller is the terminal being built, long after the app themed itself.
	 */
	const theme = appearance
		? findCodeTheme(dark ? appearance.codeDarkTheme : appearance.codeLightTheme, dark ? "dark" : "light")
		: null;
	/*
	 * `inherit` means "whatever the app's background is", which only the CSS variable knows.
	 *
	 * The default theme does not carry a surface of its own — see `--ly-code-bg` in `theme.ts` —
	 * so resolving it from the spec would paint the terminal a fixed white over a background the
	 * user may have tinted. For every other theme the spec is authoritative and is used directly,
	 * which is what keeps this correct on the render before the variable has been written.
	 */
	const background = (theme && !theme.inherit ? theme.background : readVar("--ly-code-bg")) || (dark ? "#171717" : "#ffffff");
	const foreground = (theme && !theme.inherit ? theme.foreground : readVar("--ly-code-fg")) || (dark ? "#ededed" : "#1a1c1f");
	return {
		background,
		foreground,
		cursor: foreground,
		cursorAccent: background,
		selectionBackground: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)",
		black: dark ? "#3b3b3b" : "#2c2c2c",
		red: dark ? "#f07171" : "#c8402f",
		green: dark ? "#7fc98a" : "#33803f",
		yellow: dark ? "#e3c07b" : "#9a6a00",
		blue: dark ? "#79b8ff" : "#2b62c6",
		magenta: dark ? "#c39ac9" : "#8a45a5",
		cyan: dark ? "#6fd2c8" : "#0f7d78",
		white: dark ? "#d6d6d6" : "#5f5f5f",
		brightBlack: dark ? "#6b6b6b" : "#8a8a8a",
		brightRed: dark ? "#ff8f8f" : "#d94f3d",
		brightGreen: dark ? "#98e3a3" : "#3d9950",
		brightYellow: dark ? "#f2d69a" : "#b07d0d",
		brightBlue: dark ? "#9ecbff" : "#3a76dd",
		brightMagenta: dark ? "#d6b3db" : "#9d59b8",
		brightCyan: dark ? "#8fe4db" : "#12938d",
		brightWhite: dark ? "#ffffff" : "#2c2c2c",
	};
}
