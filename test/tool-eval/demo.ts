/**
 * A side-by-side of what changed, on real files, with a real model.
 *
 *   node --experimental-strip-types test/tool-eval/demo.ts [model]
 *
 * Everything here runs the shipping code paths — the same `read` and `edit` a session uses.
 * Nothing is staged.
 */

import { readFile } from "node:fs/promises";
import { outline } from "../../packages/core/src/tools/outline.ts";

const DIM = "[2m";
const BOLD = "[1m";
const GREEN = "[32m";
const YELLOW = "[33m";
const OFF = "[0m";

function heading(n: number, title: string): void {
	console.log(`\n${BOLD}${"─".repeat(74)}${OFF}`);
	console.log(`${BOLD} ${n}. ${title}${OFF}`);
	console.log(`${BOLD}${"─".repeat(74)}${OFF}\n`);
}

// ---------------------------------------------------------------------------
// 1 · read returns a shape, not a wall of bytes
// ---------------------------------------------------------------------------

async function demoOutline(): Promise<void> {
	heading(1, "read：长文件返回结构，不是一堵字节墙");

	const target = "packages/core/src/runtime/sub-agent/sub-agents.ts";
	const content = await readFile(target, "utf8");
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();

	const shape = outline(target, content, lines)!;
	console.log(`${DIM}文件${OFF} ${target}  ${DIM}${lines.length} 行${OFF}\n`);

	// A window onto the middle of the outline, so the folding is visible.
	const preview = shape.text.split("\n").slice(33, 46);
	for (const line of preview) {
		console.log(line.includes("⋯") ? `  ${YELLOW}${line}${OFF}` : `  ${DIM}${line}${OFF}`);
	}

	console.log(
		`\n  ${DIM}改前${OFF}  ${lines.length} 行全部进上下文\n` +
			`  ${GREEN}改后${OFF}  ${shape.shownLines} 行 ${DIM}(声明与注释)${OFF} + ${shape.foldedLines} 行折叠  ` +
			`${GREEN}省 ${((shape.foldedLines / lines.length) * 100).toFixed(0)}%${OFF}`,
	);
}

async function main(): Promise<void> {
	const modelId = process.argv[2] ?? "relay/gemini-3.7-flash-high";
	console.log(`\n${BOLD}Plume · feat/tool-quality 的实际效果${OFF}  ${DIM}模型 ${modelId}${OFF}`);
	await demoOutline();
	console.log(`\n${DIM}${"─".repeat(74)}${OFF}\n`);
}

await main();
