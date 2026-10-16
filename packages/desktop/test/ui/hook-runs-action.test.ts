/**
 * 回复操作排里的钩子按钮：全部顺利跑完的那一轮不出，出了岔子的那一轮才出。
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement as h } from "react";

import type { HookRun } from "@plume/core";
import { HookRunsAction } from "../../src/features/conversation/HookRunsAction.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount } from "../helpers/mount.ts";

function hook(id: string, status: HookRun["status"]): HookRun {
	return { id, event: "PostToolUse", source: "user", command: "node log.js", status, startedAt: 1, durationMs: 12, at: 1 };
}

async function show(runs: HookRun[]) {
	useApp.setState({ activeSessionId: "s", hookRuns: runs });
	return mount(h(HookRunsAction, { from: 0, to: 1 }));
}

afterEach(() => {
	useApp.setState({ hookRuns: [] });
});

test("全部顺利跑完：不出按钮", async () => {
	const view = await show([hook("h1", "success"), hook("h2", "success")]);
	try {
		assert.equal(view.all("button").length, 0);
	} finally {
		await view.unmount();
	}
});

for (const status of ["blocked", "failed", "timed_out"] as const) {
	test(`有一条 ${status}：按钮出来，数的是这一轮全部`, async () => {
		const view = await show([hook("h1", "success"), hook("h2", status)]);
		try {
			const buttons = view.all("button");
			assert.equal(buttons.length, 1);
			assert.equal(buttons[0]!.textContent?.trim(), "2");
			assert.match(buttons[0]!.className, /text-accent/);
		} finally {
			await view.unmount();
		}
	});
}
