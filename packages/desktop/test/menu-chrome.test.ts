/**
 * Menu cards share one radius, one even inset, and a concentric hover.
 *
 * A 12px card, as ZCode draws it. The hover is the leftover after
 * that inset (12 − 4), so the active fill follows the card instead of
 * becoming a pill inside it. Both have to stay in the tokens, not as a
 * number at a call site.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("menu cards share one radius and one even inset", async () => {
	const tokens = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
	const scroll = await readFile(new URL("../src/styles/scroll.css", import.meta.url), "utf8");
	const misc = await readFile(new URL("../src/styles/misc.css", import.meta.url), "utf8");
	assert.match(tokens, /--radius-menu:\s*12px/);
	assert.match(tokens, /--ly-menu-inset:\s*4px/);
	assert.match(tokens, /--radius-item:\s*8px/);
	assert.match(tokens, /--ly-menu-row:\s*32px/);
	assert.match(scroll, /margin:\s*var\(--ly-menu-inset\)/);
	assert.doesNotMatch(scroll, /margin-right:\s*4px/);
	assert.match(misc, /\.ly-menu-card \.ly-item \{[\s\S]*?border-radius:\s*var\(--radius-item\)/);
});
