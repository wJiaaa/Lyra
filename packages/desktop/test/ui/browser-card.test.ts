/**
 * 对话里的浏览器卡片：一个标签页一张，画它最新的样子，按「打开」把人带到那一页。
 *
 * 面板不再替 agent 弹出来之后，这张卡片是后台网页在对话里仅有的痕迹。所以它画错了东西——停在刚打开
 * 的那一刻、把同一页的两次导航画成两张、打开失败了还留一张空卡、点下去打开的是别的页面——就等于把
 * 那件事说错了。
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createElement as h } from "react";
import type { BrowserCommand, BrowserResultDetails, BrowserTab } from "../../shared/browser.ts";
import { SessionScope } from "../../src/app/session-scope.tsx";
import { BrowserCards, laterPageOpens } from "../../src/features/conversation/BrowserCard.tsx";
import type { TurnBlock } from "../../src/features/conversation/grouping.ts";
import { translate } from "../../src/i18n/translate.ts";
import { useApp, type ToolRun } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

/** What the main process says is open, and what the card asked it to do. */
let open: BrowserTab[] = [];
let sent: BrowserCommand[] = [];
beforeEach(() => {
	open = [];
	sent = [];
	Object.defineProperty(window, "plume", { configurable: true, value: {
		bootWindow: { id: "test", kind: "primary", sessionId: null, panelKind: null, panelScope: null },
		browser: {
			state: async () => ({ tabs: open, activeId: null }),
			command: async (command: BrowserCommand) => { sent.push(command); return { tabs: open, activeId: null }; },
		},
	} });
});
afterEach(() => {
	Reflect.deleteProperty(window, "plume");
	useApp.setState({ toolRuns: {}, activeSessionId: null });
});

/** Press 「打开」 and wait for the question to the main process and the command after it. */
async function press(target: Element): Promise<void> {
	await click(target);
	for (let i = 0; i < 20 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const ADDRESS = "http://127.0.0.1:5173/";

function record(id: string, toolName: string, details?: BrowserResultDetails, extra: Partial<ToolRun> = {}): ToolRun {
	return {
		toolCallId: id,
		toolName,
		summary: toolName,
		args: toolName === "browser_open" ? { url: ADDRESS } : {},
		status: details ? "done" : "running",
		startedAt: 1,
		...(details ? { result: { content: [], details } } : {}),
		...extra,
	};
}

/** In call order, which is the order the store keeps them in. */
function records(...list: ToolRun[]): Record<string, ToolRun> {
	return Object.fromEntries(list.map((entry) => [entry.toolCallId, entry]));
}

function tab(id: string, sessionId: string): BrowserTab {
	return { id, sessionId, url: ADDRESS, title: "", loading: false, canGoBack: false, canGoForward: false, zoom: 1, viewport: null };
}

const OPEN_A: BrowserResultDetails = { kind: "browser", tabId: "t1", url: `${ADDRESS}a`, title: "页面 A", opened: true };
const CLICK_A: BrowserResultDetails = { kind: "browser", tabId: "t1", url: `${ADDRESS}a`, title: "页面 A 点过之后" };
const READ_A: BrowserResultDetails = { kind: "browser", tabId: "t1", url: `${ADDRESS}a`, title: "页面 A 点过之后" };
const OPEN_B: BrowserResultDetails = { kind: "browser", tabId: "t1", url: `${ADDRESS}b`, title: "页面 B", opened: true };
const CLICK_B: BrowserResultDetails = { kind: "browser", tabId: "t1", url: `${ADDRESS}b`, title: "页面 B" };
const OTHER: BrowserResultDetails = { kind: "browser", tabId: "t2", url: "https://example.com/", title: "别的标签" };

test("a card follows its tab through later calls — past other tabs and calls without a picture — and stops at that tab's next open", async () => {
	useApp.setState({
		toolRuns: records(
			record("open-a", "browser_open", OPEN_A),
			record("click-a", "browser_act", CLICK_A),
			record("other", "browser_act", OTHER),
			record("read-a", "browser_act", READ_A),
			record("open-b", "browser_open", OPEN_B),
			record("click-b", "browser_act", CLICK_B),
		),
	});
	const first = await mount(h(BrowserCards, { calls: ["open-a"] }));
	try {
		const card = first.find("[data-browser-card]");
		assert.ok(card.textContent?.includes("页面 A 点过之后"), card.textContent ?? "");
		assert.ok(card.textContent?.includes("127.0.0.1:5173"), "the host, not the whole address");
		assert.equal(first.all("[data-browser-card] img").length, 0, "no picture: the page itself is in the panel, and a picture would pass for a preview");
	} finally {
		await first.unmount();
	}
	const second = await mount(h(BrowserCards, { calls: ["open-b"] }));
	try {
		assert.ok(second.find("[data-browser-card]").textContent?.includes("页面 B"));
	} finally {
		await second.unmount();
	}
});

test("one tab opened twice in one stretch is one page, drawn as it ended", async () => {
	useApp.setState({ toolRuns: records(record("open-a", "browser_open", OPEN_A), record("open-b", "browser_open", OPEN_B)) });
	const view = await mount(h(BrowserCards, { calls: ["open-a", "open-b"] }));
	try {
		const cards = view.all("[data-browser-card]");
		assert.equal(cards.length, 1);
		assert.ok(cards[0].textContent?.includes("页面 B"), cards[0].textContent ?? "");
	} finally {
		await view.unmount();
	}
});

test("a page that failed to open leaves no card; one still opening says so and offers nothing to press", async () => {
	useApp.setState({ toolRuns: records(record("failed", "browser_open", undefined, { status: "error" }), record("opening", "browser_open")) });
	const view = await mount(h(BrowserCards, { calls: ["failed", "opening"] }));
	try {
		const cards = view.all("[data-browser-card]");
		assert.equal(cards.length, 1, "the failure is said on the tool row; a card would be a page that is not there");
		assert.ok(cards[0].textContent?.includes(translate("browser.card.opening")), cards[0].textContent ?? "");
		assert.ok(cards[0].textContent?.includes("127.0.0.1:5173"), "the address it was asked for, before there is a title");
		assert.ok(!cards[0].querySelector("button"), "nothing to open yet");
	} finally {
		await view.unmount();
	}
});

test("「打开」 brings the tab that is still there forward, and reopens the address of one that is gone", async () => {
	// The card's conversation holds the live slot, where its records are: a card reads its own screen's.
	useApp.setState({ activeSessionId: "s", toolRuns: records(record("open-a", "browser_open", OPEN_A)) });
	open = [tab("t1", "s")];
	const live = await mount(h(SessionScope.Provider, { value: "s" }, h(BrowserCards, { calls: ["open-a"] })));
	try {
		await press(live.find("[data-browser-card-row] button"));
		assert.deepEqual(sent, [{ type: "select", id: "t1" }]);
	} finally {
		await live.unmount();
	}

	sent = [];
	open = [];
	const gone = await mount(h(SessionScope.Provider, { value: "s" }, h(BrowserCards, { calls: ["open-a"] })));
	try {
		await press(gone.find("[data-browser-card-row] button"));
		assert.deepEqual(sent, [{ type: "open", url: `${ADDRESS}a`, sessionId: "s", newTab: true }]);
	} finally {
		await gone.unmount();
	}
});

test("a tab of the same id owned by another conversation is not this card's page", async () => {
	useApp.setState({ activeSessionId: "s", toolRuns: records(record("open-a", "browser_open", OPEN_A)) });
	open = [tab("t1", "someone-else")];
	const view = await mount(h(SessionScope.Provider, { value: "s" }, h(BrowserCards, { calls: ["open-a"] })));
	try {
		await press(view.find("[data-browser-card-row] button"));
		assert.equal(sent[0]?.type, "open", "reopened here rather than reaching into another conversation's tab");
	} finally {
		await view.unmount();
	}
});

/** 改一次页面、开个新标签再看一遍：每次都是新标签页，地址只差一个 `?v=`。 */
const VERSION = (n: number, tabId: string): BrowserResultDetails => ({ kind: "browser", tabId, url: `${ADDRESS}plane.html?v=${n}`, title: "大飞机", opened: true });

test("one page reopened in new tabs through a turn is one card, the last one — even when the last is in a later stretch", async () => {
	useApp.setState({ toolRuns: records(
		record("v1", "browser_open", VERSION(1, "t1")),
		record("v2", "browser_open", VERSION(2, "t2")),
		record("other", "browser_open", OTHER),
		record("v3", "browser_open", VERSION(3, "t3")),
		record("failed", "browser_open", undefined, { status: "error", args: { url: `${ADDRESS}plane.html?v=4` } }),
	) });
	const here = await mount(h(BrowserCards, { calls: ["v1", "v2", "other"], later: ["v3", "failed"] }));
	try {
		const cards = here.all("[data-browser-card]");
		assert.equal(cards.length, 1, "v1 and v2 are the same page as v3, which comes later in the turn");
		assert.ok(cards[0].textContent?.includes("别的标签"), cards[0].textContent ?? "");
	} finally {
		await here.unmount();
	}
	const last = await mount(h(BrowserCards, { calls: ["v3"], later: ["failed"] }));
	try {
		const cards = last.all("[data-browser-card]");
		assert.equal(cards.length, 1, "a reopen that failed leaves no card, so it takes nothing away");
		assert.ok(last.find("[data-browser-card] [data-ly-tip]").getAttribute("data-ly-tip")?.endsWith("?v=3"), "the last version's address");
	} finally {
		await last.unmount();
	}
});

test("what comes later is counted within the turn, and only from stretches that draw cards", () => {
	const opens = (...ids: string[]) => [{ kind: "tools", calls: ids.map((id) => ({ block: { id, name: "browser_open" } })) }];
	const block = (turn: number, kind: TurnBlock["kind"], ...ids: string[]) => ({ kind, turn, counts: { tools: ids.length, thinking: 0 }, runs: opens(...ids) }) as unknown as TurnBlock;
	assert.deepEqual(laterPageOpens([block(1, "process", "a"), block(1, "plain", "b"), block(1, "process", "c"), block(2, "process", "d")]), [["c"], ["c"], [], []]);
});
