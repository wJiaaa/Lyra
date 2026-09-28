import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h } from "react";
import { Composer } from "../../src/features/composer/Composer.tsx";
import { LayoutProvider } from "../../src/app/layout.tsx";
import { I18nProvider } from "../../src/i18n/index.ts";
import { useApp } from "../../src/store/index.ts";
import { click, mount } from "../helpers/mount.ts";

for (const switched of [false, true]) {
	test(`a rejected send restores its session references ${switched ? "without changing another draft" : "in the visible composer"}`, async () => {
		const previous = useApp.getState();
		const refs = [{ id: "one", title: "同名引用" }, { id: "two", title: "同名引用" }];
		let finish!: (accepted: boolean) => void;
		let sentRefs: typeof refs | undefined;
		useApp.setState({ activeSessionId: "a", meta: null, workspace: null, scratchCwd: "/test", settings: null,
			messages: [], running: false, drafts: { a: { text: "恢复这条消息", attachments: [], sessionRefs: refs }, b: { text: "另一份草稿", attachments: [], sessionRefs: [{ id: "other", title: "独立引用" }] } },
			send: async (_content, options) => { sentRefs = options?.sessionRefs; return new Promise<boolean>((resolve) => { finish = resolve; }); },
		});
		Object.defineProperty(window, "plume", { configurable: true, value: { commands: { list: async () => ({ commands: [], skills: [], agents: [] }) } } });
		const view = await mount(h(I18nProvider, { locale: "zh-CN", children: h(LayoutProvider, { children: h(Composer) }) }));
		try {
			await click(view.find('[aria-label="发送"]'));
			assert.deepEqual(sentRefs, refs);
			assert.equal(view.find<HTMLTextAreaElement>("textarea").value, "");
			if (switched) await act(async () => { useApp.setState({ activeSessionId: "b" }); });
			await act(async () => { finish(false); });
			assert.deepEqual(useApp.getState().drafts.a.sessionRefs, refs);
			assert.equal(view.find<HTMLTextAreaElement>("textarea").value, switched ? "另一份草稿" : "恢复这条消息");
			if (switched) {
				assert.deepEqual(useApp.getState().drafts.b.sessionRefs, [{ id: "other", title: "独立引用" }]);
				assert.equal(view.all('[aria-label^="移除会话引用："]').length, 1);
			} else assert.equal(view.all('[aria-label^="移除会话引用："]').length, 2);
		} finally { await view.unmount(); useApp.setState(previous, true); }
	});
}
