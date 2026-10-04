/**
 * Text greys where Windows draws the type.
 *
 * YaHei draws the interface's text thinner than PingFang, so the faint grey chosen on a Mac measured
 * 2.5:1 on white — the sidebar's empty hint, the composer's placeholder, the off switch's 关 all
 * washed out. `applyAppearance` darkens the two greys on a light theme when the preload has marked
 * the window as drawn by Windows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "@plume/core";
import { applyAppearance } from "../../src/features/settings/theme.ts";

function greys(platform: string | undefined, theme: AppearanceSettings["theme"]) {
	// The bridge only hears about the window's theme; an empty one is enough for that call to be skipped.
	if (!Reflect.has(window, "plume")) Reflect.set(window, "plume", {});
	const root = document.documentElement;
	if (platform === undefined) delete root.dataset.lyPlatform;
	else root.dataset.lyPlatform = platform;
	applyAppearance({ ...DEFAULT_APPEARANCE, theme });
	const read = (name: string) => root.style.getPropertyValue(name).trim();
	return { background: read("--color-shell"), muted: read("--color-ink-muted"), faint: read("--color-ink-faint") };
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

test("on Windows a light theme's text greys step toward the ink, and the faint one clears 3:1", (t) => {
	try {
		const mac = greys("darwin", "light");
		const windows = greys("win32", "light");
		t.diagnostic(JSON.stringify({ mac, windows }));
		assert.ok(contrast(windows.faint, windows.background) >= 3, `faint grey on Windows: ${contrast(windows.faint, windows.background).toFixed(2)}:1`);
		assert.ok(contrast(windows.faint, windows.background) > contrast(mac.faint, mac.background));
		assert.ok(contrast(windows.muted, windows.background) > contrast(mac.muted, mac.background));
		// Muted stays above faint, or the two steps become one.
		assert.ok(contrast(windows.muted, windows.background) > contrast(windows.faint, windows.background));
	} finally {
		greys(undefined, DEFAULT_APPEARANCE.theme);
		Reflect.deleteProperty(window, "plume");
	}
});

test("a Mac, a browser (no mark) and every dark theme keep the greys they had", () => {
	try {
		const unmarked = greys(undefined, "light");
		assert.deepEqual(greys("darwin", "light"), unmarked);
		assert.deepEqual(greys("linux", "light"), unmarked);
		assert.deepEqual(greys("win32", "dark"), greys(undefined, "dark"));
	} finally {
		greys(undefined, DEFAULT_APPEARANCE.theme);
		Reflect.deleteProperty(window, "plume");
	}
});
