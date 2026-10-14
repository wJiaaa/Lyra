/**
 * 上一轮收尾后猜的下一句：输入框空着时是灰字，Tab 填进去；框里有字时 Tab 不归它管。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { noteNextPrompt, useNextPrompt } from "../../src/store/next-prompt.ts";
import { mount, press } from "../helpers/mount.ts";

async function composerFor(draft?: string) {
	const previous = useApp.getState();
	useApp.setState({
		activeSessionId: "s",
		meta: null,
		workspace: null,
		scratchCwd: "/test",
		settings: null,
		messages: [],
		running: false,
		stopped: null,
		todos: [],
		drafts: draft ? { s: { text: draft, attachments: [], sessionRefs: [] } } : {},
	});
	Object.defineProperty(window, "plume", {
		configurable: true,
		value: { commands: { list: async () => ({ commands: [], skills: [], agents: [] }) }, sessions: { contextBreakdown: async () => null } },
	});
	const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }));
	return {
		field: () => view.find("textarea") as HTMLTextAreaElement,
		restore: async () => {
			await view.unmount();
			useApp.setState(previous, true);
			useNextPrompt.setState({ bySession: {} });
		},
	};
}

test("an empty box shows the guess and Tab fills it in", async () => {
	useNextPrompt.setState({ bySession: { s: "跑一下测试" } });
	const composer = await composerFor();
	try {
		assert.equal(composer.field().placeholder, "跑一下测试");
		await press(composer.field(), "Tab");
		assert.equal(composer.field().value, "跑一下测试");
	} finally {
		await composer.restore();
	}
});

test("with something typed, Tab is not taken", async () => {
	useNextPrompt.setState({ bySession: { s: "跑一下测试" } });
	const composer = await composerFor("换个说法");
	try {
		await press(composer.field(), "Tab");
		assert.equal(composer.field().value, "换个说法");
	} finally {
		await composer.restore();
	}
});

test("another conversation's guess is not this one's", async () => {
	useNextPrompt.setState({ bySession: { other: "跑一下测试" } });
	const composer = await composerFor();
	try {
		assert.notEqual(composer.field().placeholder, "跑一下测试");
		await press(composer.field(), "Tab");
		assert.equal(composer.field().value, "");
	} finally {
		await composer.restore();
	}
});

test("the guess goes when the next turn starts or history is rewound, and only for that conversation", () => {
	useNextPrompt.setState({ bySession: {} });
	noteNextPrompt("a", { type: "next_prompt", text: "提交" });
	noteNextPrompt("b", { type: "next_prompt", text: "推送" });
	noteNextPrompt("a", { type: "agent_start", sessionId: "a" });
	assert.deepEqual(useNextPrompt.getState().bySession, { b: "推送" });
	noteNextPrompt("b", { type: "rewound", messageCount: 1 });
	assert.deepEqual(useNextPrompt.getState().bySession, {});
});
