/**
 * The two text greys, measured on every surface they are drawn on.
 *
 * They used to be checked against the page alone, and on the page they passed. On a dark menu the
 * muted grey was 3.9:1 and on a light theme the faint one was 2.3:1 — the greys were chosen for the
 * page and then drawn on cards, fields and menus that are lighter than it. The floor is the lightest
 * surface, so that is what is measured.
 *
 * This file was once a Windows-only test: YaHei draws thinner, and the light greys were darkened
 * there alone. Every platform is past that step now, so the greys are the same everywhere.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "@plume/core";
import { applyAppearance } from "../../src/features/settings/theme.ts";

const SURFACES = ["shell", "sidebar", "card", "input", "float"] as const;

function palette(theme: AppearanceSettings["theme"]) {
	// The bridge only hears about the window's theme; an empty one is enough for that call to be skipped.
	if (!Reflect.has(window, "plume")) Reflect.set(window, "plume", {});
	applyAppearance({ ...DEFAULT_APPEARANCE, theme });
	const read = (name: string) => document.documentElement.style.getPropertyValue(`--color-${name}`).trim();
	return {
		muted: read("ink-muted"),
		faint: read("ink-faint"),
		surfaces: Object.fromEntries(SURFACES.map((name) => [name, read(name)])),
	};
}

/** WCAG contrast of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
	const luminance = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

for (const theme of ["light", "dark"] as const) {
	test(`${theme}: muted clears 4.5:1 and faint 3:1 on every surface, and the two stay apart`, (t) => {
		try {
			const { muted, faint, surfaces } = palette(theme);
			t.diagnostic(JSON.stringify({ muted, faint, surfaces }));
			for (const [name, surface] of Object.entries(surfaces)) {
				const m = contrast(muted, surface);
				const f = contrast(faint, surface);
				assert.ok(m >= 4.5, `muted on ${name}: ${m.toFixed(2)}:1`);
				assert.ok(f >= 3, `faint on ${name}: ${f.toFixed(2)}:1`);
				// Muted stays clearly above faint, or the two steps read as one.
				assert.ok(m / f >= 1.3, `muted vs faint on ${name}: ${m.toFixed(2)} / ${f.toFixed(2)}`);
			}
		} finally {
			palette(DEFAULT_APPEARANCE.theme);
			Reflect.deleteProperty(window, "plume");
		}
	});
}
