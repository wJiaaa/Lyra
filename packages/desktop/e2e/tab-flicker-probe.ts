/**
 * Switching file tabs must not blank the pane.
 *
 * The report was a flash on every tab click. The cause was a state machine that moved `path` to
 * the new file immediately while `contents` still held the old one, and a panel that — seeing
 * `loading` — unmounted the whole viewer for a centred 「读取中…」 on an unthemed background. A
 * local file reads in single-digit milliseconds, so what that produced was one white frame
 * between two themed ones: too fast to read, plenty fast enough to see.
 *
 * Measured with a MutationObserver rather than by eye, because a frame is exactly the thing
 * screenshots miss. If the editor element is ever removed from the document during a tab switch,
 * the pane went blank — whatever it looked like afterwards.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const dir = process.argv[2] ?? "/tmp/lyra-flicker";
const project = join(dir, "proj");

async function seed(home: string): Promise<void> {
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "one.ts"), "export const one = 1;\n".repeat(40));
	await writeFile(join(project, "two.ts"), "export const two = 2;\n".repeat(40));
	await writeFile(join(project, "three.ts"), "export const three = 3;\n".repeat(40));
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1300, height: 900, x: 0, y: 0 }));
	await writeFile(
		join(home, "settings.json"),
		JSON.stringify({
			version: 1,
			providers: [],
			mcpServers: [],
			projects: [{ id: "e2e", name: "proj", path: project, pinned: true, lastOpenedAt: 1 }],
			defaultModelId: null,
			permissionMode: "auto",
			thinking: "medium",
			retryAttempts: 3,
			hooks: [],
			scheduledTasks: [],
			disabledPlugins: [],
			alwaysAllow: [],
			appearance: { theme: "light", codeLightTheme: "solarized-light", codeDarkTheme: "github-dark" },
		}),
	);
}

const app = await startApp({ port: 9485, seed });
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, passed: boolean, evidence: string): void {
	if (!passed) failures++;
	process.stdout.write(`${passed ? "✓" : "✗"} ${label}\n    ${evidence}\n`);
}

try {
	await mkdir(dir, { recursive: true });
	await settle(2400);

	const open = (name: string) =>
		app.evaluate(`(async () => {
			const wait = (ms) => new Promise((r) => setTimeout(r, ms));
			if (!document.querySelector("[data-ly-tree]")) {
				document.querySelector('button[aria-label="面板"]')?.click();
				await wait(250);
				[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.innerText.trim().startsWith("文件"))?.click();
				await wait(1100);
			}
			const row = [...document.querySelectorAll("[role=treeitem]")].find((r) => r.getAttribute("data-path")?.endsWith(${JSON.stringify(name)}));
			row?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			await wait(1400);
			return Boolean(row);
		})()`);

	// All three into the tab strip, so the switches below are strip clicks rather than first opens.
	await open("one.ts");
	await open("two.ts");
	await open("three.ts");
	await settle(1500);

	/*
	 * Watch for the editor leaving the document, and for the placeholder arriving.
	 *
	 * Two separate symptoms of the same bug, recorded separately because either one alone is the
	 * flash: the editor being torn down, or 「读取中…」 being rendered where it was.
	 */
	await app.evaluate(`(() => {
		window.__flicker = { editorRemoved: 0, placeholderShown: 0, frames: [] };
		const seen = () => Boolean(document.querySelector(".cm-editor"));
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node.nodeType !== 1) continue;
					if (node.classList?.contains("cm-editor") || node.querySelector?.(".cm-editor")) {
						window.__flicker.editorRemoved++;
					}
				}
				for (const node of record.addedNodes) {
					if (node.nodeType !== 1) continue;
					if ((node.textContent ?? "").trim() === "读取中…") window.__flicker.placeholderShown++;
				}
			}
		}).observe(document.body, { childList: true, subtree: true });
		return seen();
	})()`);

	/**
	 * Click a tab in the strip, on the element that actually handles the click.
	 *
	 * `data-file-tab` is on the wrapper; the handler is on the `role=tab` button inside it. An
	 * earlier version of this dispatched at the wrapper, where the event bubbles *upward* and never
	 * reaches the button — so nothing switched, and the probe reported zero flicker for six
	 * switches that never happened. Verified by returning the path afterwards.
	 */
	const clickTab = (name: string) =>
		app.evaluate<string>(`(() => {
			const tab = [...document.querySelectorAll("[data-file-tab]")].find((t) => t.getAttribute("data-file-tab").endsWith(${JSON.stringify(name)}));
			const button = tab?.querySelector('button[role="tab"]');
			if (!button) return "找不到";
			button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			return "已点击";
		})()`);

	// Six switches, back and forth, with only a frame or two between them.
	// Each switch is confirmed to have actually landed, so a silent no-op cannot be read as
	// "no flicker".
	/*
	 * Sample once per painted frame, which is the only sampling that answers the question.
	 *
	 * A DOM node removed and re-added inside one synchronous block is never painted in between —
	 * CodeMirror rebuilding its own view does exactly that, and a MutationObserver counts it as a
	 * removal even though nothing flashed. What the eye can catch is a frame that was *drawn*
	 * without the editor, or drawn with a background that is not the code theme's. rAF runs
	 * immediately before paint, so what it sees is what was shown.
	 */
	await app.evaluate(`(() => {
		window.__frames = [];
		window.__watching = false;
		const tick = () => {
			if (window.__watching) {
				const editor = document.querySelector(".cm-editor");
				window.__frames.push(editor ? getComputedStyle(editor).backgroundColor : "缺席");
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		return true;
	})()`);

	let switches = 0;
	for (const name of ["one.ts", "two.ts", "three.ts", "one.ts", "three.ts", "two.ts"]) {
		await app.evaluate(`(() => { window.__watching = true; return true; })()`);
		const hit = await clickTab(name);
		await settle(500);
		await app.evaluate(`(() => { window.__watching = false; return true; })()`);
		const now = await app.evaluate<string>(`document.querySelector(".cm-content")?.innerText?.slice(0, 20) ?? ""`);
		const landed = now.includes(name.replace(".ts", ""));
		if (landed) switches++;
		process.stdout.write(`  ${hit} ${name} → ${landed ? "已切换" : `没切过去（当前 ${JSON.stringify(now)}）`}\n`);
	}
	await settle(1200);

	const result = await app.evaluate<{ editorRemoved: number; placeholderShown: number }>(`window.__flicker`);
	const showing = await app.evaluate<string>(`document.querySelector(".cm-content")?.innerText?.slice(0, 24) ?? "无"`);
	const activeTab = await app.evaluate<string>(
		`[...document.querySelectorAll("[data-file-tab]")].find((t) => t.className.includes("bg-card-hover"))?.textContent?.trim() ?? "无"`,
	);

	process.stdout.write(`\n六次切换后：编辑器被卸载 ${result.editorRemoved} 次，「读取中…」出现 ${result.placeholderShown} 次\n\n`);
	/*
	 * Reported, not asserted on — it does not measure what it looks like it measures.
	 *
	 * CodeMirror rebuilds its own view when the document identity changes, which removes and
	 * re-adds `.cm-editor` inside one synchronous block. A MutationObserver counts that as an
	 * unmount; the compositor never draws the gap. The frame sampling below is the real check.
	 */
	process.stdout.write(`（CodeMirror 内部重建了 ${result.editorRemoved} 次视图——同步完成，不产生绘制帧）\n`);
	check("切标签时没有闪出「读取中…」", result.placeholderShown === 0, `${result.placeholderShown} 次`);
	/*
	 * Every frame drawn during the six switches, as distinct states.
	 *
	 * One entry means the pane looked identical throughout: the editor present, on the theme's
	 * background, in every painted frame. Anything else names what was drawn instead.
	 */
	const frames = await app.evaluate<string[]>(`window.__frames`);
	const distinct = [...new Set(frames)];
	process.stdout.write(`切换期间共绘制 ${frames.length} 帧，出现过的状态：${distinct.join(" / ")}\n`);
	check(
		"每一个被绘制的帧里编辑器都在，且都是主题背景",
		distinct.length === 1 && distinct[0] === "rgb(253, 246, 227)",
		distinct.join(" / "),
	);
	check("六次切换全部真的发生了", switches === 6, `${switches}/6`);
	check("最后停在正确的文件上", showing.includes("two"), `标签=${activeTab}  内容=${JSON.stringify(showing)}`);

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(dir, "after-switching.png"), Buffer.from(shot.data, "base64"));
	process.stdout.write(`\n截图：${join(dir, "after-switching.png")}\n`);
} finally {
	await app.stop();
}

process.exit(failures === 0 ? 0 : 1);
