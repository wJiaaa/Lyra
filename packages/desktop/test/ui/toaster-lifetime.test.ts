/**
 * Every toast goes on its own, whatever else happened while it was up.
 *
 * Two ways it used to stay for good. Closing a card with the pointer on it left the stack "held":
 * the card under the pointer unmounted, so its `mouseleave` never came, and every toast after that
 * waited for a hover that nobody was going to make. And any change to the list — another notice
 * arriving, or one leaving — restarted the clock on every card, so a steady trickle kept the whole
 * column up.
 *
 * The clock is mocked (the tick and `Date.now`); the exit animation's `setTimeout` stays real, so a
 * card that has been dismissed is waited out rather than assumed gone.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { act, createElement as h } from "react";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { TOAST_LIFETIME } from "../../src/features/toast/stack.ts";
import { Toaster } from "../../src/features/toast/Toaster.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

let view: Mounted | undefined;

beforeEach(() => {
	Object.defineProperty(window, "plume", { configurable: true, value: { platform: "darwin" } });
	mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
	// happy-dom's window keeps timers of its own; the tick is `window.setInterval`.
	mock.method(window, "setInterval", (run: () => void, ms: number) => setInterval(run, ms));
	mock.method(window, "clearInterval", (id: ReturnType<typeof setInterval>) => clearInterval(id));
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	mock.timers.reset();
	mock.restoreAll();
	useApp.setState({ notices: [] });
	window.localStorage.clear();
	Reflect.deleteProperty(window, "plume");
});

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-ly-toaster] [role=status]")].map((card) => card.textContent ?? "");

const notify = (message: string) => act(async () => useApp.getState().notify(message, "info"));

/** Move the mocked clock in tick-sized steps, then let a dismissed card finish leaving. */
async function elapse(ms: number): Promise<void> {
	await act(async () => {
		for (let left = ms; left > 0; left -= 200) mock.timers.tick(Math.min(200, left));
	});
	await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
}

test("closing a card from under the pointer does not keep the next one up", async () => {
	await notify("已标记为未读");
	view = await mount(h(LayoutProvider, { children: h(Toaster) }));
	const card = document.querySelector<HTMLElement>("[data-ly-toaster] [role=status]");
	assert.ok(card);
	const close = card.querySelector<HTMLButtonElement>("button[aria-label]");
	assert.ok(close);

	// The pointer reaches the close button the way a real one does: into the card, focus, click.
	await act(async () => {
		card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
		close.focus();
		close.click();
	});
	await elapse(0);
	assert.deepEqual(cards(), [], "the card that was closed is gone");

	await notify("已标记为已读");
	await elapse(TOAST_LIFETIME.info + 400);
	assert.deepEqual(cards(), [], "the next one left on its own");
});

test("a newer notice does not restart the clock on the cards already up", async () => {
	view = await mount(h(LayoutProvider, { children: h(Toaster) }));
	await notify("已标记为未读");
	await elapse(TOAST_LIFETIME.info - 2000);
	await notify("已标记为已读");
	await elapse(2400);
	assert.deepEqual(cards().map((text) => text.includes("已读")), [true], "only the newer card is still up");

	await elapse(TOAST_LIFETIME.info);
	assert.deepEqual(cards(), []);
});

test("the same message again is current again, so its own clock does restart", async () => {
	view = await mount(h(LayoutProvider, { children: h(Toaster) }));
	await notify("已标记为未读");
	await elapse(TOAST_LIFETIME.info - 2000);
	await notify("已标记为未读");
	await elapse(2400);
	assert.equal(cards().length, 1, "the repeat bought it a fresh lifetime");
});
