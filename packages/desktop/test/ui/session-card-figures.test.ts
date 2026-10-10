/**
 * The figures on the card over a conversation row: three that stand alone, and a row that explains
 * the middle one.
 *
 * Turns, not messages: `messageCount` counts every tool result, so one turn of forty tool calls read
 * as eighty-odd. The hit rate is the main conversation's, not one diluted by sub-agents and side
 * calls. And a rate short of 100% never rounds up to it.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";
import type { SessionMeta, Usage } from "@plume/core";

import { SessionCard } from "../../src/features/sidebar/SessionCard.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

const cost = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
const usage = (over: Partial<Usage>): Usage => ({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost, ...over });
const meta = (over: Partial<SessionMeta>): SessionMeta => ({
	id: "a", title: "Refactor", cwd: "/work/plume", projectId: "plume", projectName: "plume",
	createdAt: 1, updatedAt: 1, modelId: "", messageCount: 84, seq: 2, usage: usage({}), ...over,
});

afterEach(() => useApp.setState({ sessions: [] }));

async function figures(session: SessionMeta): Promise<string[]> {
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionCard, { session, anchor: new DOMRect(0, 0, 240, 28) }) }));
	try {
		const grid = document.body.querySelector("[data-ly-session-card]")!.lastElementChild!;
		return [...grid.children].map((stat) => stat.textContent ?? "");
	} finally {
		await view.unmount();
	}
}

test("turns, fresh usage and the main conversation's hit rate", async () => {
	const stats = await figures(meta({
		turns: 3,
		// Everything: a sub-agent that re-read nothing drags the combined rate down to 50%.
		usage: usage({ input: 1000, cacheWrite: 0, cacheRead: 1000, output: 500 }),
		// The replies alone: 900 of 1000 read from the cache.
		replyUsage: usage({ input: 100, cacheRead: 900, output: 200 }),
	}));
	assert.deepEqual(stats, ["轮次3", "全程用量1.5k", "缓存命中90%", "输入1.0k", "输出500", "读缓存1.0k"]);
});

test("a rate just short of 100% keeps a decimal instead of rounding up", async () => {
	const stats = await figures(meta({ turns: 1, usage: usage({ input: 4, cacheRead: 9996 }), replyUsage: usage({ input: 4, cacheRead: 9996 }) }));
	assert.equal(stats[2], "缓存命中99.9%");
});

test("a row not yet counted dashes its turns and rates over everything", async () => {
	const stats = await figures(meta({ usage: usage({ input: 10, cacheRead: 30, output: 5 }) }));
	assert.deepEqual(stats, ["轮次–", "全程用量15", "缓存命中75%", "输入10", "输出5", "读缓存30"]);
});

test("nothing sent yet is a dash, not a 0% hit rate", async () => {
	const stats = await figures(meta({ turns: 0 }));
	assert.equal(stats[2], "缓存命中–");
});
