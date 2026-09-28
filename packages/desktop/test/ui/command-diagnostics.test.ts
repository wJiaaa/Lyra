/**
 * The diagnostics cards above the command list: what their headers count, which card a line goes
 * under, and that a rescan leaves every line on screen exactly once.
 *
 * The page keyed its rows by path and counted lines, and one file can have several lines. A command
 * whose `---` is never closed is still named after its file, and if another file already has that
 * name it is shadowed as well: two lines, one path. React reports the repeated key on the first
 * render and doubles a row on a later one, and the header counted every line as a file.
 *
 * Nor did the header match what was under it. A command with a misspelt `deliver` loads (as
 * `prompt`, and its line says so), yet it was counted as failing to load.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement as h, type ReactElement } from "react";
import type { PlumeApi } from "../../electron/ipc-types.ts";
import { CommandsSettings } from "../../src/features/settings/CommandsSettings.tsx";
import { useApp } from "../../src/store/index.ts";
import { mount, type Mounted } from "../helpers/mount.ts";

type CommandList = Awaited<ReturnType<PlumeApi["commands"]["list"]>>;
type SlashCommand = CommandList["commands"][number];

// The loaders' own sentences: each row has to keep saying its own one.
const UNCLOSED = "开头的 `---` 没有闭合，整个文件都被当成了正文。";
const SHADOWED = "命令“review”已由 /work/.plume/commands/review.md 定义，这一个被遮蔽了。";
const BAD_NAME = "命令名只能是小写字母、数字和连字符，用冒号分组；当前是“Review_Diff”。";
const BAD_DELIVER = "`deliver` 只能是 prompt、steer、followUp；当前是“steering”，已按 prompt 处理。";
const BAD_YAML = "文件开头的 YAML 无法解析：Flow sequence in block collection must be sufficiently indented and end with a ]";

const commandList = (patch: Partial<CommandList>): CommandList => ({ commands: [], builtins: [], diagnostics: [], skills: [], ...patch });

const command = (name: string, path: string): SlashCommand => ({
	name,
	description: `${name} 是做什么的`,
	content: "……",
	path,
	scope: path.startsWith("/work/") ? "workspace" : "user",
	origin: path.includes("/.claude/") ? "claude" : "plume",
});

/** How many times `needle` appears on screen: a row doubled or dropped shows up here. */
const times = (view: Mounted, needle: string) => view.text().split(needle).length - 1;

/**
 * What the card whose header matches `heading` says: the header and the lines under it.
 *
 * The header is the innermost element saying it, and its card is what holds it and its rows. Read as
 * text, the way someone reading the page tells which lines a header is about.
 */
function card(view: Mounted, heading: RegExp): string {
	const header = view.all("div").findLast((element) => heading.test(element.textContent ?? ""));
	assert.ok(header, `no header matching ${heading}: ${view.text()}`);
	return (header.parentElement?.textContent ?? "").replace(/\s+/g, " ");
}

/** Answers each call with the next list, then keeps answering with the last. */
function answers<T>(lists: T[]): () => Promise<T> {
	let call = 0;
	return async () => lists[Math.min(call++, lists.length - 1)];
}

/**
 * Mount with this bridge, and collect React's duplicate-key reports while it is up.
 *
 * A repeated key still renders every row on the first pass: React says so on `console.error`, and
 * only drops or doubles a row on a later update. Listening is what makes the first render a test of
 * the keys at all.
 */
async function render(element: ReactElement, plume: object) {
	Object.defineProperty(window, "plume", { configurable: true, value: plume });
	useApp.setState({ workspace: null });
	const duplicateKeys: string[] = [];
	const report = console.error;
	console.error = (...args: unknown[]) => {
		if (String(args[0]).includes("two children with the same key")) duplicateKeys.push(String(args[1]));
		else report(...args);
	};
	let view: Mounted;
	try {
		view = await mount(element);
	} catch (thrown) {
		console.error = report;
		throw thrown;
	}
	return {
		view,
		duplicateKeys,
		async done() {
			await view.unmount();
			console.error = report;
		},
	};
}

/** Let a re-read that a handler started come back and render. */
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

test("a command is counted once however many lines it has, and one that loaded is not counted as failing", async () => {
	const focus = "/home/me/.plume/commands/focus.md";
	const draft = "/home/me/.claude/commands/Review_Diff.md";
	const review = "/home/me/.claude/commands/review.md";
	const page = await render(h(CommandsSettings), {
		commands: {
			list: answers([
				commandList({
					commands: [command("focus", focus), command("review", "/work/.plume/commands/review.md")],
					diagnostics: [
						{ path: focus, message: BAD_DELIVER },
						{ path: draft, message: BAD_NAME },
						// Never closed, so named after its file, and that name was taken by the project's.
						{ path: review, message: UNCLOSED },
						{ path: review, message: SHADOWED },
					],
				}),
			]),
		},
	});
	try {
		const failed = card(page.view, /个命令没能加载/);
		assert.match(failed, /^2 个命令没能加载/, `four lines about three files, one of which loaded: ${failed}`);
		for (const message of [BAD_NAME, UNCLOSED, SHADOWED]) assert.ok(failed.includes(message), message);
		assert.ok(!failed.includes(BAD_DELIVER), "the misspelt `deliver` loaded, as prompt");

		const loaded = card(page.view, /个命令需要留意/);
		assert.match(loaded, /^1 个命令需要留意/, loaded);
		assert.ok(loaded.includes(BAD_DELIVER), loaded);

		for (const message of [BAD_DELIVER, BAD_NAME, UNCLOSED, SHADOWED]) assert.equal(times(page.view, message), 1, message);
		assert.deepEqual(page.duplicateKeys, []);
	} finally {
		await page.done();
	}
});

test("coming back from the editor re-reads the commands, and a line that moved down is still there once", async () => {
	const draft = "/home/me/.claude/commands/Review_Diff.md";
	const review = "/home/me/.claude/commands/review.md";
	const before = [
		{ path: draft, message: BAD_NAME },
		{ path: review, message: UNCLOSED },
		{ path: review, message: SHADOWED },
	];
	// Written in the editor meanwhile: a project command, read first, whose YAML does not parse.
	const after = [{ path: "/work/.plume/commands/ship.md", message: BAD_YAML }, ...before];
	const page = await render(h(CommandsSettings), {
		commands: { list: answers([commandList({ diagnostics: before }), commandList({ diagnostics: after })]) },
	});
	try {
		assert.equal(times(page.view, UNCLOSED), 1, page.view.text());
		// The page re-reads on focus, which is what coming back from the editor is.
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await settle();

		const text = page.view.text();
		for (const message of [BAD_YAML, BAD_NAME, UNCLOSED, SHADOWED]) assert.equal(times(page.view, message), 1, `${message}\n${text}`);
		const order = [BAD_YAML, BAD_NAME, UNCLOSED, SHADOWED].map((message) => text.indexOf(message));
		assert.deepEqual([...order].sort((a, b) => a - b), order, "in the order the scan gave them");
		assert.deepEqual(page.duplicateKeys, []);
		assert.match(card(page.view, /个命令没能加载/), /^3 个命令没能加载/, "and the header follows the new scan");
	} finally {
		await page.done();
	}
});
