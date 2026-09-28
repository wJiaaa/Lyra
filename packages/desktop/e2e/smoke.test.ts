/**
 * The app, actually started.
 *
 * Unit tests know whether a function returns the right thing. They cannot tell you that the main
 * process boots, that the preload exposes what the renderer expects, or that the window paints
 * something rather than a white rectangle — and those are the failures that make an app look
 * broken to the person who opened it.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";

let app: RunningApp;

before(async () => {
	app = await startApp({ port: 9444 });
});

after(async () => {
	await app?.stop();
});

test("the window opens and paints the shell", async () => {
	const shape = await app.evaluate<{ shell: boolean; sidebar: boolean; title: string }>(`({
		shell: Boolean(document.querySelector(".ly-shell")),
		sidebar: Boolean(document.querySelector(".ly-sidebar-fill")),
		title: document.title,
	})`);

	assert.equal(shape.shell, true, "the app shell rendered");
	assert.equal(shape.sidebar, true, "so did the navigation pane");
	assert.equal(shape.title, "Plume");
});

test("the preload exposed the API the renderer is written against", async () => {
	const api = await app.evaluate<string[]>(`Object.keys(window.plume ?? {}).sort()`);
	for (const area of ["agent", "clipboard", "files", "sessions", "settings", "workspace"]) {
		assert.ok(api.includes(area), `window.plume.${area} is missing`);
	}
});

test("a first run lands somewhere you can act from", async () => {
	/*
	 * With a fresh profile there is no project and no conversation, so the composer may not be
	 * mounted yet — what has to be true is that the main column says something. A blank one is
	 * the failure this test exists to catch: it looks identical to a crash.
	 */
	const landing = await app.evaluate<{ text: number; composer: boolean }>(`(() => {
		const main = document.querySelector("main");
		return {
			text: (main?.textContent ?? "").trim().length,
			composer: Boolean(document.querySelector("main textarea")),
		};
	})()`);

	assert.ok(landing.text > 0 || landing.composer, "the main column is not blank");
});

test("the window is the size someone can use", async () => {
	// A window that opens at 0×0, or off-screen, is running and unusable at the same time.
	const size = await app.evaluate<{ w: number; h: number }>(`({ w: window.innerWidth, h: window.innerHeight })`);
	assert.ok(size.w >= 600, `window is ${size.w}px wide`);
	assert.ok(size.h >= 400, `window is ${size.h}px tall`);
});
