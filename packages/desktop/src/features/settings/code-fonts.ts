/**
 * The monospace faces worth offering by name.
 *
 * The setting is a CSS font stack and always has been — it has to be, because the first choice may
 * not be installed and something has to catch that. What was wrong was making people *type* one:
 * getting `"JetBrains Mono", ui-monospace, Menlo, "PingFang SC", monospace`
 * right by hand, quotes and all, to change a font.
 *
 * So each entry is a whole stack with its own sensible fallbacks, chosen by the name at the front.
 * Other monospace faces installed on the machine follow them — see `queryInstalledFonts`. Anyone
 * with a face neither list finds still has the text field — see 自定义 in `AppearanceSettings`.
 *
 * Whether a preset is installed is answered from that same list rather than guessed at: a name
 * that is not installed would silently render as something else, and the menu would be lying
 * about what you picked.
 */

import type { MessageKey } from "../../i18n/messages/index.ts";

export interface CodeFontOption {
	/** What the menu calls it. */
	label: string;
	/** The full stack, which is what gets stored. */
	stack: string;
	/** The first family, for the availability check and for the sample. */
	/**
	 * Only the entry that is not a typeface's own name carries a key.
	 *
	 * 「JetBrains Mono」 is called that in every language; the last row is a description, so it is
	 * the one that has to move. Looked up by the picker rather than here — this table is built at
	 * import time, before the language is settled.
	 */
	labelKey?: MessageKey;
	family: string;
}

export const CODE_FONTS: CodeFontOption[] = [
	// The default; see `CODE_DEFAULTS.codeFont`.
	{
		label: "System monospace",
		labelKey: "codeFonts.systemMono",
		family: "ui-monospace",
		stack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace',
	},
	{
		label: "JetBrains Mono",
		family: "JetBrains Mono",
		stack: '"JetBrains Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "SF Mono",
		family: "SF Mono",
		stack: '"SF Mono", SFMono-Regular, ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{ label: "Menlo", family: "Menlo", stack: 'Menlo, ui-monospace, "SF Mono", "PingFang SC", monospace' },
	{ label: "Monaco", family: "Monaco", stack: 'Monaco, Menlo, ui-monospace, "PingFang SC", monospace' },
	{
		label: "Fira Code",
		family: "Fira Code",
		stack: '"Fira Code", "Fira Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Cascadia Code",
		family: "Cascadia Code",
		stack: '"Cascadia Code", "Cascadia Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Source Code Pro",
		family: "Source Code Pro",
		stack: '"Source Code Pro", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "IBM Plex Mono",
		family: "IBM Plex Mono",
		stack: '"IBM Plex Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{
		label: "Roboto Mono",
		family: "Roboto Mono",
		stack: '"Roboto Mono", ui-monospace, Menlo, "PingFang SC", monospace',
	},
	{ label: "Consolas", family: "Consolas", stack: 'Consolas, ui-monospace, Menlo, "PingFang SC", monospace' },
];

/** The stack a face found on the machine is stored as: the fallbacks the presets lean on. */
function installedStack(family: string): string {
	return `"${family}", ui-monospace, Menlo, "PingFang SC", monospace`;
}

const INSTALLED_STACK = /^"([^"]+)", ui-monospace, Menlo, "PingFang SC", monospace$/;

/** What this machine has, as far as the menu is concerned. */
export interface LocalFonts {
	/** Every family installed, for telling a preset that is there from one that is not. */
	families: Set<string>;
	/** Monospace faces the presets do not already name, sorted for the menu. */
	extra: CodeFontOption[];
}

/**
 * Ask the browser which faces are installed.
 *
 * `queryLocalFonts` lists every face and says nothing about width, so monospace is measured: the
 * narrowest and widest letters and a period must all advance the same. The fallback is `serif`
 * on purpose — a face with no Latin letters falls through to it and measures as proportional,
 * instead of borrowing a monospace fallback's widths and passing. Symbol faces (Wingdings 2) are
 * fixed-width too; their 「.」 is a full-height glyph where a text face has a dot on the baseline.
 *
 * Resolves to null when the list cannot be had — an engine without the API, or the `local-fonts`
 * permission refused (it then answers with an empty list rather than an error) — so the caller
 * knows not to mark every preset as missing.
 */
export async function queryInstalledFonts(): Promise<LocalFonts | null> {
	const query = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
	if (!query) return null;
	let faces: { family: string }[];
	try {
		faces = await query();
	} catch {
		return null;
	}
	if (faces.length === 0) return null;
	const families = new Set(faces.map((face) => face.family));
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return { families, extra: [] };
	const named = new Set(CODE_FONTS.map((option) => option.family));
	const extra = [...families]
		// A quote would end the family early in the stored stack.
		.filter((family) => !named.has(family) && !family.includes('"') && isMonospace(ctx, family))
		.sort((a, b) => a.localeCompare(b))
		.map((family) => ({ label: family, family, stack: installedStack(family) }));
	return { families, extra };
}

function isMonospace(ctx: CanvasRenderingContext2D, family: string): boolean {
	ctx.font = `16px "${family}", serif`;
	const narrow = ctx.measureText("iiiiiiiiii").width;
	if (narrow === 0) return false;
	if (Math.abs(narrow - ctx.measureText("WWWWWWWWWW").width) > 0.5) return false;
	if (Math.abs(narrow - ctx.measureText("..........").width) > 0.5) return false;
	return ctx.measureText(".").actualBoundingBoxAscent < ctx.measureText("H").actualBoundingBoxAscent * 0.4;
}

/**
 * Whether this face is actually installed.
 *
 * Read from the installed list rather than `document.fonts.check`, which answers true for any
 * name it has no web font for — installed or not — so the 「本机不可用」 mark never showed. Without a
 * list there is nothing to go on, and offering the face is better than hiding it.
 */
export function fontAvailable(option: CodeFontOption, local: LocalFonts | null): boolean {
	// A generic keyword always resolves to something.
	if (option.family.startsWith("ui-")) return true;
	return local ? local.families.has(option.family) : true;
}

/**
 * The rows of the code font menu: the presets this machine has, then the other monospace faces it
 * has, and the one in use even when it is not there — the caller marks that one, so the menu never
 * claims you are looking at something you are not.
 *
 * A preset that is not installed is left out rather than listed and marked. On Windows that was SF
 * Mono, Menlo and Monaco: three rows offering fonts that would all draw as Consolas.
 */
export function codeFontMenu(local: LocalFonts | null, current: CodeFontOption | null): CodeFontOption[] {
	const options = [
		...CODE_FONTS.filter((font) => fontAvailable(font, local) || font.stack === current?.stack),
		...(local?.extra ?? []),
	];
	// A face picked earlier and since uninstalled, or the list not back yet: still the selected row.
	if (current && !options.some((font) => font.stack === current.stack)) options.push(current);
	return options;
}

/** Which entry a stored stack corresponds to, or null when it was typed by hand. */
export function matchCodeFont(stack: string): CodeFontOption | null {
	const normalised = stack.trim();
	const preset = CODE_FONTS.find((option) => option.stack === normalised);
	if (preset) return preset;
	/*
	 * A face picked from the installed list is stored in one fixed shape, so it is recognised from
	 * the stack alone — before the list has come back, and after the face has been uninstalled.
	 */
	const family = INSTALLED_STACK.exec(normalised)?.[1];
	return family ? { label: family, family, stack: installedStack(family) } : null;
}
