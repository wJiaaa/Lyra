/**
 * A web address in a reply: a click opens it in the system browser by default, a right-click asks
 * where — the system browser by name, the built-in one — or copies it.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, createElement as h } from "react";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { Markdown } from "../../src/features/conversation/Markdown.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp, type AppState } from "../../src/store/index.ts";
import { click, fire, mount, type Mounted } from "../helpers/mount.ts";

const URL = "https://github.com/wJiaaa/TokenRouter";

let calls: unknown[][];
let notices: string[];
let previous: AppState;
let view: Mounted | undefined;

beforeEach(() => {
	calls = [];
	notices = [];
	previous = useApp.getState();
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			system: {
				defaultBrowser: async () => "Google Chrome",
				openExternal: async (url: string) => void calls.push(["external", url]),
			},
			browser: { command: async (command: { url: string; sessionId: string }) => void calls.push(["builtin", command.url, command.sessionId]) },
			clipboard: { write: async (text: string) => void calls.push(["copy", text]) },
		},
	});
	useApp.setState({ activeSessionId: "b", settings: { browser: {} } as unknown as AppState["settings"], notify: (message: string) => void notices.push(message) });
});

afterEach(async () => {
	await view?.unmount();
	view = undefined;
	useApp.setState(previous, true);
	Reflect.deleteProperty(window, "plume");
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

async function reply(): Promise<HTMLAnchorElement> {
	view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionScope.Provider, { value: "a" }, h(Markdown, { text: `仓库 [wJiaaa/TokenRouter](${URL})。` })) }));
	return view.find<HTMLAnchorElement>("a");
}

async function rightClick(target: Element) {
	await fire(target, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
	await settle();
}

function rows(): string[] {
	return [...document.body.querySelectorAll('[role="menu"] button')].map((button) => (button.textContent ?? "").trim());
}

function row(label: string): HTMLElement {
	const found = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] button')].find((button) => (button.textContent ?? "").trim() === label);
	assert.ok(found, `no 「${label}」 row`);
	return found;
}

test("a click opens the address in the system browser when the setting is left alone", async () => {
	await click(await reply());
	assert.deepEqual(calls, [["external", URL]]);
});

test("right-clicking names the system browser, offers the built-in one, and copies the address", async () => {
	const link = await reply();
	await rightClick(link);
	assert.deepEqual(rows(), ["在 Google Chrome 中打开", "在内置浏览器打开", "复制链接"]);

	await click(row("在 Google Chrome 中打开"));
	await settle();
	assert.deepEqual(rows(), [], "choosing a row closes the menu");
	assert.deepEqual(calls, [["external", URL]], "the row's click does not also reach the link");

	await rightClick(link);
	await click(row("在内置浏览器打开"));
	// The conversation the link is in, not the one with focus.
	assert.deepEqual(calls.at(-1), ["builtin", URL, "a"]);

	await rightClick(link);
	await click(row("复制链接"));
	assert.deepEqual(calls.at(-1), ["copy", URL]);
	assert.deepEqual(notices, ["已复制链接"]);
	assert.equal(calls.length, 3);
});
