/**
 * The figures on the card over a conversation row: one total cost up front, the token count and the
 * main conversation's hit rate beside it, then where the tokens went.
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

const usage = (over: Partial<Usage> & { dollars?: number }): Usage => {
	const { dollars = 0, ...rest } = over;
	return { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: dollars }, ...rest };
};
const meta = (over: Partial<SessionMeta>): SessionMeta => ({
	id: "a", title: "Refactor", cwd: "/work/plume", projectId: "plume", projectName: "plume",
	createdAt: 1, updatedAt: 1, modelId: "", messageCount: 84, seq: 2, usage: usage({}), ...over,
});

afterEach(() => useApp.setState({ sessions: [] }));

interface Read {
	cost: string;
	/** The two lines beside the cost: token count, then the main conversation's hit rate. */
	aside: string;
	figures: string[];
	foot: string;
}

async function read(session: SessionMeta): Promise<Read> {
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(SessionCard, { session, anchor: new DOMRect(0, 0, 240, 28) }) }));
	try {
		const card = document.body.querySelector("[data-ly-session-card]")!;
		const cost = card.querySelector("[data-ly-session-cost]")!;
		return {
			cost: cost.textContent ?? "",
			aside: cost.nextElementSibling?.textContent ?? "",
			figures: [...card.querySelector("[data-ly-session-figures]")!.children].map((stat) => stat.textContent ?? ""),
			foot: card.querySelector("[data-ly-session-foot]")?.textContent ?? "",
		};
	} finally {
		await view.unmount();
	}
}

test("one cost for everything, tokens by where they went, the hit rate the main conversation's", async () => {
	const card = await read(meta({
		turns: 3,
		steps: 41,
		// 主会话 1.0k 里有 400 是子智能体花的。
		usage: usage({ input: 800, output: 200, cacheRead: 100, dollars: 1.5 }),
		subagentUsage: usage({ input: 300, output: 100, dollars: 0.2 }),
		replyUsage: usage({ input: 100, output: 100, cacheRead: 900 }),
		sideUsage: usage({ input: 1500, output: 500, cacheRead: 900, dollars: 0.34 }),
	}));
	assert.equal(card.cost, "$1.84", "main, sub-agents and side chats in one figure");
	assert.equal(card.aside, "3.0k tokens主会话缓存命中 90%");
	assert.deepEqual(card.figures, ["轮次3 轮 · 41 步", "输入2.3k", "输出700", "主会话600", "侧边聊天2.0k", "子智能体400"]);
	assert.match(card.foot, /读缓存 1\.0k$/);
});

test("tokens spent on a model with no price read as unpriced, not as free", async () => {
	const card = await read(meta({ turns: 1, steps: 1, usage: usage({ input: 21_200, output: 166 }) }));
	assert.equal(card.cost, "未定价");
});

test("nothing sent yet is a dash, for the cost and for the hit rate", async () => {
	const card = await read(meta({ turns: 0 }));
	assert.equal(card.cost, "–");
	assert.equal(card.aside, "0 tokens主会话缓存命中 –");
});

test("no side chat and no sub-agent are dashes, not zeros", async () => {
	const card = await read(meta({ turns: 1, steps: 1, usage: usage({ input: 10, dollars: 0.01 }), subagentUsage: usage({}) }));
	assert.deepEqual(card.figures.slice(3), ["主会话10", "侧边聊天–", "子智能体–"]);
});

test("a rate just short of 100% keeps a decimal instead of rounding up", async () => {
	const card = await read(meta({ turns: 1, usage: usage({ input: 4, cacheRead: 9996 }), replyUsage: usage({ input: 4, cacheRead: 9996 }) }));
	assert.match(card.aside, /主会话缓存命中 99\.9%$/);
});

test("a row not yet counted dashes its turns and rates over everything", async () => {
	const card = await read(meta({ usage: usage({ input: 10, cacheRead: 30, output: 5 }) }));
	assert.equal(card.figures[0], "轮次–");
	assert.match(card.aside, /主会话缓存命中 75%$/);
});

test("steps ride beside turns once they have been counted", async () => {
	const card = await read(meta({ turns: 2, steps: 41 }));
	assert.equal(card.figures[0], "轮次2 轮 · 41 步");
});
