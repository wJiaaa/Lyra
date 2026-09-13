/**
 * Which of the three things the composer's send button is, and when.
 *
 * The button has one position and three states — send, continue, stop — and two of them are a
 * filled triangle and a hollow arrow inside the same circle. So which one is drawn is not a detail
 * of styling; it is the app's answer to "is there work left in this conversation?", and it is
 * legible enough to be wrong.
 *
 * The reported bug: a turn that ended cleanly, with the model asking the reader a question and the
 * input box empty, still showed 「继续」. `stopReason: "stop"` is the ordinary way a reply ends, so
 * the triangle had become the resting state of every finished conversation and the arrow appeared
 * only once you had typed something.
 *
 * The invariant the last test states is the one `ResumeRow` already claims in its own comments:
 * both entry points ask `carryOnPrompt`, so they cannot disagree about whether a turn is finished.
 * They did.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { AssistantMessage, Message, TodoItem } from "@lyra/core";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { ResumeRow } from "../../src/features/conversation/ResumeRow.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import type { TurnStop } from "../../src/store/derive.ts";
import { mount } from "../helpers/mount.ts";

function reply(stopReason: AssistantMessage["stopReason"], text = "请问你想查询哪座城市的天气呢？"): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		stopReason,
		timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function todo(status: TodoItem["status"]): TodoItem {
	return { content: "一件事", status, activeForm: "做一件事" };
}

/**
 * Enough of the preload bridge for the composer to mount.
 *
 * `ContextMeter` asks for a breakdown as soon as the transcript is non-empty, and these tests are
 * all about a conversation that has messages in it — so unlike the draft tests, the meter's call
 * has to have somewhere to land.
 */
function stubBridge() {
	Object.defineProperty(window, "lyra", {
		configurable: true,
		value: {
			commands: { list: async () => ({ commands: [], skills: [], agents: [] }) },
			sessions: { contextBreakdown: async () => null },
		},
	});
}

/** A conversation in a given end state, with an empty composer. */
async function composerFor({
	stopped = null,
	todos = [],
	messages = [reply("stop")],
	draft,
}: {
	stopped?: TurnStop;
	todos?: TodoItem[];
	messages?: Message[];
	draft?: string;
} = {}) {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s",
		meta: null,
		workspace: null,
		scratchCwd: "/test",
		settings: null,
		messages,
		running: false,
		stopped,
		todos,
		drafts: draft ? { s: { text: draft, attachments: [], sessionRefs: [] } } : {},
	});
	stubBridge();
	const view = await mount(
		h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }),
	);
	return {
		view,
		/** "send" | "continue" | "stop" — stated on the element so this needs no icon archaeology. */
		state: () => view.find("[data-composer-send]").getAttribute("data-composer-send"),
		restore: async () => {
			await view.unmount();
			useApp.setState(previous, true);
		},
	};
}

test("a turn that ended cleanly leaves a send button, not a continue — the reported bug", async () => {
	/*
	 * The screenshot: the model has answered and asked the reader which city they meant, the input
	 * box is empty, and the button is a triangle. Nothing is unfinished — pressing it sent 「继续推进
	 * 当前任务」 to a model that was waiting for a place name.
	 */
	const composer = await composerFor();
	try {
		assert.equal(composer.state(), "send");
	} finally {
		await composer.restore();
	}
});

test("a paused turn offers to carry on", async () => {
	const composer = await composerFor({ stopped: "user" });
	try {
		assert.equal(composer.state(), "continue");
	} finally {
		await composer.restore();
	}
});

for (const stopped of ["interrupt", "error"] as const) {
	test(`a turn cut short by ${stopped === "error" ? "a failed request" : "a crash or a quit"} offers to carry on`, async () => {
		const composer = await composerFor({ stopped });
		try {
			assert.equal(composer.state(), "continue");
		} finally {
			await composer.restore();
		}
	});
}

test("a clean finish with items still on the list offers to carry on", async () => {
	// The quiet one: nothing went wrong, the model simply stopped with its own plan unfinished.
	const composer = await composerFor({ todos: [todo("completed"), todo("pending")] });
	try {
		assert.equal(composer.state(), "continue");
	} finally {
		await composer.restore();
	}
});

test("a clean finish with every item ticked off is finished", async () => {
	const composer = await composerFor({ todos: [todo("completed"), todo("completed")] });
	try {
		assert.equal(composer.state(), "send");
	} finally {
		await composer.restore();
	}
});

test("anything typed is a message to send, whatever is left undone", async () => {
	// The arrow is about what is in the box; it outranks the offer to pick work back up.
	const composer = await composerFor({ stopped: "user", draft: "换个说法再来一次" });
	try {
		assert.equal(composer.state(), "send");
	} finally {
		await composer.restore();
	}
});

test("a reply still arriving is a stop button", async () => {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s", meta: null, workspace: null, scratchCwd: "/test", settings: null,
		messages: [reply("pending")], running: true, stopped: null, todos: [], drafts: {},
	});
	stubBridge();
	const view = await mount(
		h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }),
	);
	try {
		assert.equal(view.find("[data-composer-send]").getAttribute("data-composer-send"), "stop");
	} finally {
		await view.unmount();
		useApp.setState(previous, true);
	}
});

test("the button and the row under the transcript never disagree", async () => {
	/*
	 * The invariant, stated where it can fail.
	 *
	 * `ResumeRow` says in its own comments that the composer's button asks `carryOnPrompt` the same
	 * way it does, "so the two cannot end up disagreeing about whether this turn is finished". They
	 * did: the button carried an extra `|| stopReason === "stop"`, so a conversation that ended
	 * cleanly had no row beneath it and a continue triangle in the corner.
	 */
	const cases: { stopped: TurnStop; todos: TodoItem[]; carryOn: boolean }[] = [
		{ stopped: null, todos: [], carryOn: false },
		{ stopped: null, todos: [todo("completed")], carryOn: false },
		{ stopped: null, todos: [todo("in_progress")], carryOn: true },
		{ stopped: "user", todos: [], carryOn: true },
		{ stopped: "interrupt", todos: [], carryOn: true },
		{ stopped: "error", todos: [], carryOn: true },
	];

	for (const { stopped, todos, carryOn } of cases) {
		const previous = useApp.getState();
		useApp.setState({
			activeSessionId: "s", meta: null, workspace: null, scratchCwd: "/test", settings: null,
			messages: [reply("stop")], running: false, stopped, todos, drafts: {},
		});
		stubBridge();
		const view = await mount(
			h(I18nProvider, {
				locale: "zh-CN",
				children: h(LayoutProvider, { children: h("div", null, h(ResumeRow), h(Composer)) }),
			}),
		);
		try {
			const where = `stopped=${stopped}, ${todos.length} 项待办`;
			const button = view.find("[data-composer-send]").getAttribute("data-composer-send");
			const row = view.all("button").some((el) => ((el.getAttribute("aria-label") ?? el.textContent) ?? "").includes("继续"));
			assert.equal(button === "continue", carryOn, `按钮该是 ${carryOn ? "continue" : "send"}（${where}）`);
			assert.equal(row, carryOn, `转录下面那行该${carryOn ? "出现" : "消失"}（${where}）`);
		} finally {
			await view.unmount();
			useApp.setState(previous, true);
		}
	}
});
