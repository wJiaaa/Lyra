import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import type { DiffHunk } from "@plume/core";
import { DiffView } from "../../src/features/git/DiffView.tsx";
import { loadFenceLanguage } from "../../src/lib/code/highlight.ts";
import { mount } from "../helpers/mount.ts";

for (const [path, language, code] of [
	["Example.cs", "cs", 'public class Example { string name = "Plume"; int n = 42; }'],
	["config.yaml", "yaml", 'name: "Plume"\nenabled: true'],
	["Dockerfile", "dockerfile", 'FROM node:24\nRUN echo "hello"'],
] as const) {
	test(`added ${path} lines retain syntax classes`, async () => {
		await loadFenceLanguage(language);
		const hunks: DiffHunk[] = [{ oldStart: 1, newStart: 1,
			lines: code.split("\n").map((text, i) => ({ type: "add", text, newLine: i + 1 })) }];
		const view = await mount(h(DiffView, { hunks, path }));
		try {
			await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
			assert.ok(view.all(".ly-diff-add span[class]").filter((span) => span.className.startsWith("ͼ")).length > 1,
				`syntax tokens missing: ${view.host.innerHTML}`);
		} finally {
			await view.unmount();
		}
	});
}
