/**
 * What 代码高亮主题 actually changes, in light mode, measured rather than assumed.
 *
 * The report is that picking Solarized Light shows a warm yellow preview in settings and leaves
 * the editor looking untouched. Two separate things could produce that and they need different
 * fixes, so this separates them:
 *
 *   - the token colours — are the spans painted in the theme's palette, or the previous one's?
 *   - the surface — is the editor's background the theme's `#fdf6e3`, or the app's own white?
 *
 * Every measurement is compared against the theme's own declared values in `code-themes.ts`, so
 * "it changed" is not good enough: it has to have changed *to the right colour*.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp } from "./app.ts";

const dir = process.argv[2] ?? "/tmp/plume-light";
const project = join(dir, "proj");

/** The user's own file from the screenshot, near enough: comments, globs, values. */
const GITATTRIBUTES = `# Line endings are decided here
* text=auto eol=lf

# Generated: kept in the repo
pnpm-lock.yaml linguist-generated=true
*.lock linguist-generated=true

# Binary, so git never tries to merge them
*.png binary
*.woff2 binary
`;

const TS = `// 一个注释
export function greet(name: string): string {
	const count = 42;
	return \`Hello, \${name}\`;
}
`;

/** Solarized Light, restated from `code-themes.ts` so the probe compares against the source. */
const SOLARIZED_LIGHT = {
	background: "#fdf6e3",
	foreground: "#657b83",
	keyword: "#859900",
	string: "#2aa198",
	number: "#d33682",
	comment: "#93a1a1",
	function: "#268bd2",
	type: "#b58900",
};

/** GitHub Light — what the app falls back to, so a "no change" is recognisable. */
const _OTHER_LIGHT_HINT = "#cf222e";

function hexToRgb(hex: string): string {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function seed(home: string): Promise<void> {
	await mkdir(project, { recursive: true });
	await writeFile(join(project, ".gitattributes"), GITATTRIBUTES);
	await writeFile(join(project, "sample.ts"), TS);
	await writeFile(join(home, "window.json"), JSON.stringify({ width: 1240, height: 900, x: 0, y: 0 }));
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
			// Light, and the theme the report is about.
			appearance: { theme: "light", codeLightTheme: "solarized-light", codeDarkTheme: "github-dark" },
		}),
	);
}

const app = await startApp({ port: 9479, seed });
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	await mkdir(dir, { recursive: true });
	await settle(2400);

	const open = async (name: string) =>
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
			await wait(1800);
			return Boolean(row);
		})()`);

	await open("sample.ts");
	await settle(2000);

	const state = await app.evaluate<{
		scheme: string;
		dark: boolean;
		editorBg: string;
		scrollerBg: string;
		gutterBg: string;
		content: string;
		spans: { text: string; colour: string }[];
		styleTag: string;
	}>(`(() => {
		const root = document.documentElement;
		const content = document.querySelector(".cm-content");
		const scroller = document.querySelector(".cm-scroller");
		const editor = document.querySelector(".cm-editor");
		const gutter = document.querySelector(".cm-gutters");
		const spans = [...(content?.querySelectorAll("span") ?? [])]
			.filter((s) => s.textContent?.trim())
			.slice(0, 14)
			.map((s) => ({ text: s.textContent.slice(0, 14), colour: getComputedStyle(s).color }));
		const tag = document.querySelector("style[data-dw-highlight]");
		return {
			scheme: getComputedStyle(root).colorScheme,
			dark: root.classList.contains("dark"),
			editorBg: editor ? getComputedStyle(editor).backgroundColor : "无",
			scrollerBg: scroller ? getComputedStyle(scroller).backgroundColor : "无",
			gutterBg: gutter ? getComputedStyle(gutter).backgroundColor : "无",
			content: content ? getComputedStyle(content).color : "无",
			spans,
			styleTag: (tag?.textContent ?? "").slice(0, 260),
		};
	})()`);

	process.stdout.write(`color-scheme：${state.scheme}   .dark class：${state.dark}\n\n`);
	process.stdout.write("── 表面 ──\n");
	process.stdout.write(`  编辑器背景  ${state.editorBg}\n`);
	process.stdout.write(`  滚动区背景  ${state.scrollerBg}\n`);
	process.stdout.write(`  行号槽背景  ${state.gutterBg}\n`);
	process.stdout.write(`  主题声明的  ${SOLARIZED_LIGHT.background} = ${hexToRgb(SOLARIZED_LIGHT.background)}\n`);
	const bgMatches = [state.editorBg, state.scrollerBg].some((c) => c === hexToRgb(SOLARIZED_LIGHT.background));
	process.stdout.write(`  → 背景用上主题了吗：${bgMatches ? "是" : "否"}\n\n`);

	process.stdout.write("── token 颜色 ──\n");
	for (const span of state.spans) {
		process.stdout.write(`  ${JSON.stringify(span.text).padEnd(18)} ${span.colour}\n`);
	}
	const painted = new Set(state.spans.map((s) => s.colour));
	const wanted = new Map(
		Object.entries(SOLARIZED_LIGHT)
			.filter(([key]) => key !== "background" && key !== "foreground")
			.map(([key, hex]) => [hexToRgb(hex), key]),
	);
	const hit = [...painted].filter((c) => wanted.has(c));
	process.stdout.write(`\n  画出来的颜色 ${painted.size} 种，其中属于 Solarized Light 的 ${hit.length} 种：\n`);
	for (const colour of hit) process.stdout.write(`    ${wanted.get(colour)} = ${colour}\n`);
	const strays = [...painted].filter((c) => !wanted.has(c));
	if (strays.length) process.stdout.write(`  不属于该主题的：${strays.join("  ")}\n`);
	process.stdout.write(`  → token 用上主题了吗：${hit.length >= 2 ? "是" : "否"}\n\n`);

	process.stdout.write(`── 注入的高亮样式表（前 260 字）──\n${state.styleTag}\n\n`);

	const shot = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(dir, "01-ts-light.png"), Buffer.from(shot.data, "base64"));

	// The user's own file, which is the one in the screenshot.
	await open(".gitattributes");
	await settle(1800);
	const git = await app.evaluate<{ spans: { text: string; colour: string }[]; bg: string }>(`(() => {
		const content = document.querySelector(".cm-content");
		const editor = document.querySelector(".cm-editor");
		return {
			bg: editor ? getComputedStyle(editor).backgroundColor : "无",
			spans: [...(content?.querySelectorAll("span") ?? [])].filter((s) => s.textContent?.trim()).slice(0, 10)
				.map((s) => ({ text: s.textContent.slice(0, 20), colour: getComputedStyle(s).color })),
		};
	})()`);
	process.stdout.write("── .gitattributes（截图里那个文件）──\n");
	process.stdout.write(`  背景 ${git.bg}\n`);
	for (const span of git.spans) process.stdout.write(`  ${JSON.stringify(span.text).padEnd(24)} ${span.colour}\n`);

	const shot2 = await app.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
	await writeFile(join(dir, "02-gitattributes-light.png"), Buffer.from(shot2.data, "base64"));
	process.stdout.write(`\n截图：${dir}\n`);
} finally {
	await app.stop();
}
