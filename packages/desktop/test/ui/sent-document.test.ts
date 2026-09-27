/**
 * 发出去的文档，点它的标记能打开。
 *
 * 有路径的附件从前一律拿路径算出一张图的地址，于是文档也被当成图：点下去交给看图器，看图器找不到
 * 图，什么都不做。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { DEFAULT_SETTINGS } from "@lyra/core";
import { UserMessage } from "../../src/features/conversation/UserMessage.tsx";
import { useApp } from "../../src/store/index.ts";
import { useOpenFile } from "../../src/store/openFile.ts";
import { click, mount } from "../helpers/mount.ts";

test("点已发送文档的标记，打开的是那个文件", async () => {
	const opened: string[] = [];
	Object.defineProperty(window, "lyra", {
		configurable: true,
		value: {
			platform: "darwin",
			files: { mediaUrl: (path: string) => `lyra-media://test${path}` },
			system: { openTargets: async () => [], pathExists: async () => true, openIn: async () => {} },
		},
	});
	useApp.setState({
		settings: { ...DEFAULT_SETTINGS, projects: [{ id: "p", name: "p", path: "/p" }] },
		workspace: { path: "/p", name: "p" },
		activeSessionId: "s",
		messages: [],
		running: false,
		notices: [],
	} as never);
	useOpenFile.setState({ open: (async (entry: { path: string }) => void opened.push(entry.path)) as never });

	const message = {
		role: "user" as const,
		timestamp: 1,
		content: [{ type: "text" as const, text: "读取【文档 1】" }],
		attachments: [{ name: "notes.md", label: "文档 1", kind: "text", path: "/p/notes.md", mimeType: "text/markdown" }],
	};
	const view = await mount(h(UserMessage, { message, index: 0 }));
	try {
		await click(view.find(".ly-attachment-token"));
		assert.deepEqual(opened, ["/p/notes.md"]);
	} finally {
		await view.unmount();
	}
});
