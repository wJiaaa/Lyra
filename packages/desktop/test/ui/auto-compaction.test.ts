import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import type { CommandRun } from "@lyra/core";
import { CommandRunRow } from "../../src/features/conversation/CommandRunRow.tsx";
import { mount } from "../helpers/mount.ts";

test("automatic fallback stays visible without inventing a user command or a running animation", async () => {
	const command: CommandRun = { id: "auto", name: "compact", input: "", at: 0, timestamp: 1, status: "running", detail: "", automatic: { phase: "retrying", retries: 2 } };
	const view = await mount(h(CommandRunRow, { command }));
	try {
		assert.equal(view.all(".ly-command-token").length, 0);
		assert.match(view.text(), /2/);
		await view.rerender(h(CommandRunRow, { command: { ...command, status: "done", automatic: { phase: "fallback", retries: 2, outcome: "fallback", before: 24, after: 8 } } }));
		assert.match(view.text(), /24.*8/);
		assert.match(view.text(), /fallback|本地/);
		assert.equal(view.all(".ly-glide").length, 0);
		assert.equal(view.find("[data-command-status]").getAttribute("data-command-status"), "done");
	} finally { await view.unmount(); }
});

test("manual compaction still displays the user's trailing instructions", async () => {
	const view = await mount(h(CommandRunRow, { command: { id: "manual", name: "compact", input: "/compact 保留未完成的任务", at: 0, timestamp: 1, status: "done", detail: "已压缩" } }));
	try {
		assert.equal(view.all(".ly-command-token").length, 1);
		assert.match(view.text(), /保留未完成的任务/);
	} finally { await view.unmount(); }
});
