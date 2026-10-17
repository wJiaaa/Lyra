/**
 * The archive groups by the project a conversation is filed under, the way the sidebar does.
 *
 * It used to group by folder and name each group after the folder: two projects sharing one folder
 * came out as a single group, called whatever the folder was called when the first one began.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS, type SessionMeta } from "@plume/core";

import { ArchivedSettings } from "../../src/features/settings/ArchivedSettings.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const usage = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
const archived = (over: Partial<SessionMeta>): SessionMeta => ({
	id: "a", title: "a", cwd: "/work/codex", projectId: "codex", projectName: "codex",
	createdAt: 1, updatedAt: 2, modelId: "", messageCount: 1, seq: 2, usage, archived: true, ...over,
});

afterEach(() => {
	useApp.setState({ sessions: [], settings: null });
});

test("two projects on one folder keep their archived conversations apart, under their own names", async () => {
	useApp.setState({
		settings: {
			...DEFAULT_SETTINGS,
			projects: [
				{ id: "/work/codex", name: "codex 改名了", path: "/work/codex", lastOpenedAt: 1 },
				{ id: "proj-b", name: "B", path: "/work/codex", lastOpenedAt: 2 },
			],
		},
		sessions: [archived({ id: "old", project: "/work/codex" }), archived({ id: "in-b", project: "proj-b" }), archived({ id: "also-b", project: "proj-b" }), archived({ id: "bare", cwd: "/work/loose", projectName: "loose" })],
	});
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(ArchivedSettings) }));
	try {
		const groups = view.all("[data-ly-archive-group]").map((group) => group.getAttribute("data-ly-archive-group"));
		assert.deepEqual(groups, ["proj-b", "/work/codex", "/work/loose"]);
		const names = view.all("[data-ly-archive-toggle]").map((toggle) => toggle.getAttribute("aria-label")?.split("，")[0]);
		assert.deepEqual(names, ["B", "codex 改名了", "loose"], "one in no project is grouped by its folder, under the folder's name");
	} finally {
		await view.unmount();
	}
});
