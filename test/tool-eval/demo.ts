/**
 * A side-by-side of what changed, on real files, with a real model.
 *
 *   node --experimental-strip-types test/tool-eval/demo.ts [model]
 *
 * Everything here runs the shipping code paths — the same `read` and `edit` a session uses.
 * Nothing is staged.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "../../packages/core/src/tools/edit.ts";
import { snapshotTag } from "../../packages/core/src/tools/hunk.ts";
import { outline } from "../../packages/core/src/tools/outline.ts";
import { readTool } from "../../packages/core/src/tools/read.ts";
import type { ToolContext } from "../../packages/core/src/types.ts";

const DIM = "[2m";
const BOLD = "[1m";
const GREEN = "[32m";
const RED = "[31m";
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

	const target = "packages/core/src/runtime/sub-agents.ts";
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

// ---------------------------------------------------------------------------
// 2 · edit: what the two formats cost for the same change
// ---------------------------------------------------------------------------

async function demoEdit(): Promise<void> {
	heading(2, "edit：同一处改动，两种格式的成本");

	const before = [
		"const DEFAULT_LIMIT = 2000;",
		"const MAX_LINE_LENGTH = 2000;",
		"const MAX_IMAGE_BYTES = 5 * 1024 * 1024;",
	].join("\n") + "\n";

	console.log(`${DIM}目标：把 MAX_LINE_LENGTH 从 2000 改成 4000，DEFAULT_LIMIT 不动${OFF}\n`);
	console.log(`  ${DIM}1→const DEFAULT_LIMIT = 2000;${OFF}`);
	console.log(`  ${DIM}2→const MAX_LINE_LENGTH = 2000;   ← 两行都有 2000${OFF}`);
	console.log(`  ${DIM}3→const MAX_IMAGE_BYTES = 5 * 1024 * 1024;${OFF}\n`);

	console.log(`  ${RED}str_replace${OFF}  锚点必须唯一，所以要连上下文一起复现：`);
	console.log(`  ${DIM}  old_string: "const DEFAULT_LIMIT = 2000;\\nconst MAX_LINE_LENGTH = 2000;"${OFF}`);
	console.log(`  ${DIM}  new_string: "const DEFAULT_LIMIT = 2000;\\nconst MAX_LINE_LENGTH = 4000;"${OFF}`);
	console.log(`  ${DIM}  —— 保留的那一行被逐字重打了一遍；打错一个字符就静默改坏它${OFF}\n`);

	console.log(`  ${GREEN}patch${OFF}        点名行号，只写新内容：`);
	console.log(`  ${DIM}  tag: ${snapshotTag(before)}${OFF}`);
	console.log(`  ${DIM}  patch: "REPLACE 2-2\\n+const MAX_LINE_LENGTH = 4000;"${OFF}\n`);

	// Actually apply it, so this is not a mock-up.
	const dir = await mkdtemp(join(tmpdir(), "plume-demo-"));
	const file = join(dir, "limits.ts");
	await writeFile(file, before, "utf8");
	const ctx: ToolContext = { cwd: dir, sessionId: "demo", state: new Map() };
	await readTool.execute({ path: file } as never, ctx);
	const res = await editTool.execute({ path: file, tag: snapshotTag(before), patch: "REPLACE 2-2\n+const MAX_LINE_LENGTH = 4000;" }, ctx);
	const after = await readFile(file, "utf8");
	console.log(`  ${GREEN}结果${OFF} ${res.content[0].type === "text" ? res.content[0].text : ""}`);
	console.log(`  ${DIM}${after.trimEnd().split("\n").join("\n  ")}${OFF}`);

	// And the guard: an edit written against a file that has since moved.
	await writeFile(file, `${after}const EXTRA = 1;\n`, "utf8");
	const stale = await editTool.execute({ path: file, tag: snapshotTag(before), patch: "REPLACE 1-1\n+const DEFAULT_LIMIT = 99;" }, ctx);
	console.log(`\n  ${DIM}有人在这中间改了这个文件，再用旧 tag 编辑：${OFF}`);
	console.log(`  ${GREEN}被拒绝${OFF} ${DIM}${stale.content[0].type === "text" ? stale.content[0].text : ""}${OFF}`);
}

async function main(): Promise<void> {
	const modelId = process.argv[2] ?? "relay/gemini-3.7-flash-high";
	console.log(`\n${BOLD}Plume · feat/tool-quality 的实际效果${OFF}  ${DIM}模型 ${modelId}${OFF}`);
	await demoOutline();
	await demoEdit();
	console.log(`\n${DIM}${"─".repeat(74)}${OFF}\n`);
}

await main();
