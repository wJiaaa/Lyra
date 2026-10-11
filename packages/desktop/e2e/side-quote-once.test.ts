/**
 * 划词「在侧边聊天中提问」：引文在侧聊输入框上只挂一次，关掉侧聊后不再回来。
 *
 * 侧聊面板是这一下才开的，输入框挂载时接引文的那个 effect 在开发构建里会被 StrictMode 跑两遍；
 * 第二遍拿的还是闭包里那份引文，于是同一段引文挂了两份。生产构建不重跑 effect，看不见，
 * 所以这一组在开发构建里跑。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { startDevRenderer } from "./dev-renderer.ts";
import { click, closeTab, dragSelect, frames, hover, openSession, shot, textSpan, until } from "./drive.ts";
import { seedSessions } from "./session-fixture.ts";

const ID = "side-quote-once";
const QUOTED = "这是一段足够长的文字";

let app: RunningApp;
let renderer: Awaited<ReturnType<typeof startDevRenderer>>;

before(async () => {
	renderer = await startDevRenderer();
	app = await startApp({
		port: 9679,
		rendererUrl: renderer.url,
		async seed(home) {
			const cwd = join(home, "project");
			await mkdir(cwd, { recursive: true });
			const projectId = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
			const at = Date.now() - 600_000;
			const message = (seq: number, role: string, text: string) => ({ seq, ts: at + seq * 1000, type: "message", message: { role, content: [{ type: "text", text }], timestamp: at + seq * 1000 } });
			const meta = { id: ID, title: "划词提问", cwd, projectId, projectName: "演示", createdAt: at, updatedAt: at, modelId: "m", messageCount: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }, seq: 0 };
			seedSessions(home, [{ meta, records: [{ seq: 1, ts: at, type: "meta", meta }, message(2, "user", "问题"), message(3, "assistant", `${QUOTED}，后面还有一些。`)] as never }]);
			await writeFile(join(home, "settings.json"), JSON.stringify({ version: 1, providers: [], mcpServers: [], projects: [{ id: projectId, path: cwd, name: "演示", pinned: true, lastOpenedAt: Date.now() }], defaultModelId: null, permissionMode: "auto", hooks: [], scheduledTasks: [], disabledPlugins: [] }));
			await writeFile(join(home, "window.json"), JSON.stringify({ width: 1440, height: 860, x: 0, y: 0 }));
		},
	});
	await frames(app, 60);
	await openSession(app, ID);
	await frames(app, 30);
});

after(async () => {
	await app?.stop();
	await renderer?.close();
});

const CHIP = '[data-dock-pane="chat"] [data-ly-quote-chip]';

async function askAside(text: string): Promise<void> {
	const span = await textSpan(app, '[data-ly-chat-surface="conversation"] [data-ly-quote]', text);
	await dragSelect(app, span.start, span.end);
	await until(app, `document.querySelector('[data-ly-popover][role="menu"]')`);
	await click(app, '[role="menuitem"]', "在侧边聊天中提问");
	await until(app, `document.querySelector(${JSON.stringify(CHIP)})`);
	await frames(app, 20);
}

/** 框里的字、框上方那枚引用，和指上去卡片里列着的引文。 */
async function seen(): Promise<{ value: string; chip: string; quotes: string[] }> {
	await hover(app, CHIP);
	await until(app, `document.querySelector('[data-ly-quote-card]')`);
	await frames(app, 10);
	const state = await app.evaluate<{ value: string; chip: string; quotes: string[] }>(`({
		value: document.querySelector('[data-dock-pane="chat"] textarea').value,
		chip: document.querySelector(${JSON.stringify(CHIP)}).textContent,
		quotes: [...document.querySelectorAll('[data-ly-quote-card] p:first-child')].map((e) => e.textContent),
	})`);
	await app.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200, y: 200 });
	await until(app, `!document.querySelector('[data-ly-quote-card]')`);
	return state;
}

test("开发构建：划词提问新开侧聊，引文只挂上去一次", async () => {
	await askAside(QUOTED);
	await shot(app, "side-quote-once");
	assert.deepEqual(await seen(), { value: "", chip: "1 条对话引用", quotes: [QUOTED] });
});

test("关掉侧聊再划词提问，关掉前没发的引文不会回来", async () => {
	await closeTab(app, "chat");
	await frames(app, 30);
	await askAside("后面还有一些");
	assert.deepEqual(await seen(), { value: "", chip: "1 条对话引用", quotes: ["后面还有一些"] });
});
