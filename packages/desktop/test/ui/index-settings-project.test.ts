/**
 * The index page picks its own project and has nothing to do with the open conversation.
 *
 * It used to read the global workspace, so another project's index could only be seen by leaving
 * settings and opening one of that project's conversations — and a conversation outside any
 * project showed nothing at all.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, createElement as h } from "react";

import { IndexSettings } from "../../src/features/settings/IndexSettings.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

const ALPHA = { id: "/work/alpha", path: "/work/alpha", name: "alpha", lastOpenedAt: 2 };
const BETA = { id: "/work/beta", path: "/work/beta", name: "beta", lastOpenedAt: 1 };

afterEach(() => {
	useApp.setState({ sessions: [], workspace: null, settings: null });
	Reflect.deleteProperty(window, "plume");
});

test("the first listed project is shown whatever the open conversation belongs to, and the picker switches it", async () => {
	const asked: string[] = [];
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: {
			index: {
				stats: async (cwd: string) => {
					asked.push(cwd);
					return { exists: true, builtAt: 1, files: cwd === BETA.path ? 7 : 3, symbols: 1, bytes: 1024 };
				},
				search: async () => [],
			},
		},
	});
	useApp.setState({
		settings: { projects: [ALPHA, BETA] } as never,
		workspace: { path: BETA.path, name: BETA.name, isGitRepo: false, branch: null },
	});
	const view = await mount(h(I18nProvider, { locale: "en", children: h(IndexSettings) }));
	const filesRow = () => view.all("[data-settings-row]").find((row) => row.firstElementChild?.textContent === "Files indexed");
	try {
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
		assert.deepEqual(asked, [ALPHA.path]);
		assert.equal(filesRow()?.lastElementChild?.textContent, "3");

		await click(view.find("[data-ly-select]"));
		const beta = [...document.body.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.includes(BETA.name));
		assert.ok(beta, "beta is offered in the picker");
		await click(beta);
		await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
		assert.equal(asked.at(-1), BETA.path);
		assert.equal(filesRow()?.lastElementChild?.textContent, "7");
	} finally {
		await view.unmount();
	}
});
