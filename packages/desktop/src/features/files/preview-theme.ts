/**
 * The app's theme, as the variables a generated page is told it can style against.
 *
 * Read off the document rather than worked out from the settings: `applyAppearance` has already
 * resolved every token — custom backgrounds, contrast, the code theme — and a second derivation here
 * would be a second formula that sooner or later disagrees with the first. Call it after the theme is
 * on the document, which is what `onAppearanceApplied` is for.
 *
 * The names are the ones a model already writes without being told twice (`--foreground`,
 * `--muted-foreground`, `--chart-1` …); the values are Plume's. The list the model is shown is in
 * `previewTool`'s description, and every name there has to be one written here.
 */

import type { PreviewTheme } from "../../../shared/preview.ts";

/*
 * What the app has no token for. Charts need several hues that sit together, and the app's palette
 * is one accent and three states; these follow the accent as its neighbours, tuned per scheme so
 * none of them vanishes against the page.
 */
const CHART = {
	dark: ["#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"],
	light: ["#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"],
};
const WARNING = { dark: "#fbbf24", light: "#d97706" };

/** The colour actually painted behind `element`: the first ancestor with a background of its own. */
function surfaceBehind(element: Element | null): string | null {
	for (let at = element; at; at = at.parentElement) {
		const background = getComputedStyle(at).backgroundColor;
		if (background && background !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(background)) return background;
	}
	return null;
}

function channels(colour: string): [number, number, number] | null {
	const hex = /^#([0-9a-f]{6})$/i.exec(colour);
	if (hex) return [0, 2, 4].map((at) => Number.parseInt(hex[1].slice(at, at + 2), 16)) as [number, number, number];
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(colour);
	return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** Text that reads on a solid fill of `colour` — the label on a primary button. */
export function readableOn(colour: string): string {
	const rgb = channels(colour.trim());
	if (!rgb) return "#ffffff";
	const [r, g, b] = rgb.map((value) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111111" : "#ffffff";
}

/**
 * The theme for a page shown inside `host`.
 *
 * `--background` is what is really behind the card, not a token: the conversation sits on different
 * surfaces in a pane, a side chat and a sub-agent's panel, and a page that fills a box with
 * `var(--background)` should vanish into whichever one it is in.
 */
export function previewTheme(host: Element | null): PreviewTheme {
	const root = document.documentElement;
	const style = getComputedStyle(root);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const scheme = root.classList.contains("light") || (!root.classList.contains("dark") && style.colorScheme.includes("light")) ? "light" : "dark";
	const ink = read("--color-ink");
	const accent = read("--color-accent");
	const card = read("--color-card");
	const danger = read("--color-danger");
	const vars: Record<string, string> = {
		"--background": surfaceBehind(host) ?? read("--color-shell"),
		"--foreground": ink,
		"--muted": card,
		"--muted-foreground": read("--color-ink-muted"),
		"--faint-foreground": read("--color-ink-faint"),
		"--card": card,
		"--card-foreground": ink,
		"--popover": read("--color-float"),
		"--popover-foreground": ink,
		"--border": read("--color-line"),
		"--input": read("--color-line"),
		"--ring": accent,
		"--primary": accent,
		"--primary-foreground": readableOn(accent),
		"--accent": accent,
		"--accent-foreground": readableOn(accent),
		"--success": read("--color-ok"),
		"--info": read("--color-info"),
		"--warning": WARNING[scheme],
		"--danger": danger,
		"--destructive": danger,
		"--code-background": read("--ly-code-bg") || card,
		"--code-foreground": read("--ly-code-fg") || ink,
		"--chart-1": accent,
		...Object.fromEntries(CHART[scheme].map((colour, index) => [`--chart-${index + 2}`, colour])),
		"--radius": "10px",
		"--font-sans": getComputedStyle(document.body).fontFamily,
		"--font-mono": read("--ly-code-font") || read("--font-mono"),
		"--font-size": read("--ly-ui-size") || "14px",
	};
	// A token the stylesheet never set comes back empty; leaving it out lets a page's own fallback apply.
	return { scheme, vars: Object.fromEntries(Object.entries(vars).filter(([, value]) => value !== "")) };
}
