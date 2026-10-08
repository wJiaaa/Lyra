/**
 * A slash command that is fully typed runs on the first Enter.
 *
 * The list completes a name; it deliberately does not run what it highlights, because firing
 * `/clear` from a stray keystroke would cost a conversation. But once the name is typed in full
 * there is nothing left to complete — the completion appends a space and nothing else — so Enter
 * appeared to do nothing at all and the command had to be pressed twice, with nothing on screen
 * saying so. That is the whole of 「选了指令按回车一点反应都没有」.
 *
 * No model is configured here on purpose: what is being checked is that the command *ran*, and
 * 「还没有可用的模型」 is the built-in saying so out loud.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startApp, type RunningApp } from "./app.ts";
import { seedSessions, type FixtureRecord } from "./session-fixture.ts";

const DAY = 86_400_000;
const now = Date.now();
const SESSION = "sess-compact";
const PROJECT = "/tmp/plume-compact-demo";

let app: RunningApp;

const seed = async (home: string) => {
		await mkdir(PROJECT, { recursive: true });
		const meta = {
			id: SESSION,
			title: "压缩用的会话",
			cwd: PROJECT,
			projectId: "p1",
			projectName: "demo",
			createdAt: now - DAY,
			updatedAt: now,
			modelId: null,
			messageCount: 10,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
			seq: 1,
		};
		const records: FixtureRecord[] = [{ seq: 1, ts: now, type: "meta", meta }];
		for (let i = 0; i < 10; i++) {
			records.push(
				{
					seq: i + 2,
					ts: now + i,
					type: "message",
					message:
						i % 2 === 0
							? { role: "user", content: [{ type: "text", text: `第 ${i} 个问题，讲点什么` }], timestamp: now + i }
							: {
									role: "assistant",
									content: [{ type: "text", text: `第 ${i} 个回答，内容长一点好压缩。`.repeat(20) }],
									api: "openai-responses",
									provider: "p",
									model: "m",
									usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
									stopReason: "stop",
									timestamp: now + i,
								},
				},
			);
		}
		seedSessions(home, [{ meta, records }]);
		await writeFile(join(home, "window.json"), JSON.stringify({ width: 1280, height: 900, x: 0, y: 0 }));
		await writeFile(
			join(home, "settings.json"),
			JSON.stringify({
				version: 1,
				providers: [],
				mcpServers: [],
				projects: [{ path: PROJECT, name: "demo", pinned: false, lastOpenedAt: now }],
				defaultModelId: null,
				permissionMode: "auto",
				thinking: "medium",
				retryAttempts: 3,
				hooks: [],
				scheduledTasks: [],
				disabledPlugins: [],
				pluginRegistries: [],
				skillRegistries: [],
				alwaysAllow: [],
				appearance: { theme: "dark" },
			}),
		);
};

before(async () => {
	app = await startApp({ port: 9474, seed });
	await settle(2200);
	// Open the seeded conversation, which is what gives `/compact` something to act on.
	await app.evaluate<boolean>(`(() => {
		const row = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("压缩用的会话"));
		row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return Boolean(row);
	})()`);
	await settle(1600);
});

after(async () => {
	await app?.stop();
});

const type = async (value: string) => {
	await app.evaluate(`(() => {
		const field = document.querySelector("textarea");
		field.focus();
		field.select();
	})()`);
	await app.send("Input.insertText", { text: value });
};
const enter = async () => {
	await app.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13 });
	await app.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
};
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
/** What is in the composer right now. */
const field = () => app.evaluate<string>(`document.querySelector("textarea")?.value ?? ""`);
/** Whatever the built-in said, if it said anything. */
const feedback = () =>
	app.evaluate<string>(
		`(/已把之前的对话压缩|还没有可用的模型|对话还太短|已经够紧凑|找不到这个会话|正在进行中/.exec(document.body.innerText) ?? [""])[0]`,
	);

test("the list offers a command as it is typed", async () => {
	await type("/comp");
	await settle(700);
	assert.ok(
		await app.evaluate<boolean>(`[...document.querySelectorAll('[role="option"]')].some(row => row.textContent.includes('compact'))`),
		"the built-in is listed while the name is half typed",
	);
});

test("a half-typed name is completed by Enter rather than run", async () => {
	await type("/comp");
	await settle(500);
	await enter();
	await settle(700);

	assert.equal(await field(), "/compact ", "Enter finished the word");
	assert.ok(!(await feedback()), "and nothing ran");
});

test("a name typed in full runs on the first Enter", async () => {
	await type("/compact");
	await settle(500);
	await enter();
	await settle(2000);

	assert.equal(await field(), "", "the composer cleared, which is a command having been taken");
	assert.match(await feedback(), /还没有可用的模型/, "and the built-in answered");
});
