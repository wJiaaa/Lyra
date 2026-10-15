import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { globToRegExp, globTool } from "../src/tools/glob.ts";

test("a character class matches one of its members, a range, or anything but them", () => {
	const cases: [pattern: string, path: string, matches: boolean][] = [
		["*[Pp]review*", "PreviewCard.tsx", true],
		["*[Pp]review*", "ReviewCard.tsx", false],
		["f[0-9].ts", "f7.ts", true],
		["f[0-9].ts", "fa.ts", false],
		["f[!0-9].ts", "fa.ts", true],
		["f[!0-9].ts", "f7.ts", false],
		["f[^0-9].ts", "fa.ts", true],
		// 取反也不跨目录，和 `?` 一样。
		["a[!x]b", "a/b", false],
		// 紧跟 `[` 或 `[!` 的 `]` 是成员，不是收尾。
		["[]x].md", "].md", true],
		["[!]x].md", "].md", false],
		// 没有收尾的 `[` 只是一个字符。
		["a[b.ts", "a[b.ts", true],
		["{a,b}[12].ts", "b2.ts", true],
	];
	for (const [pattern, path, matches] of cases) {
		assert.equal(globToRegExp(pattern).test(path), matches, `${pattern} against ${path}`);
	}
});

test("glob finds a file through a character class", async (t) => {
	// 以前 `[` 被转义成字面字符，这条在真实会话里答了「No files match」，PreviewCard.tsx 明明就在。
	const dir = await mkdtemp(join(tmpdir(), "plume-glob-class-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "src", "files"), { recursive: true });
	await writeFile(join(dir, "src", "files", "PreviewCard.tsx"), "");
	await writeFile(join(dir, "src", "files", "Other.tsx"), "");

	const res = await globTool.execute({ pattern: "src/**/*[Pp]review*" }, { cwd: dir, sessionId: "s", state: new Map() });
	const text = res.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	assert.equal(text, "src/files/PreviewCard.tsx");
});
