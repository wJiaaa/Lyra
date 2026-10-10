/**
 * 把文件拖进终端，打出来的是 shell 认得的路径。
 *
 * 引号是这件事的全部风险：一个带空格的路径没加引号，命令拿到的是两个参数；一个带 `$` 的文件名
 * 进了双引号，shell 会把它当变量展开掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { carriesPaths, dropText, droppedPaths, shellWord } from "../../src/features/terminal/drop.ts";
import { DRAGGED_PATHS } from "../../src/lib/paths.ts";

function transfer(types: string[], data: Record<string, string> = {}, files: File[] = []): DataTransfer {
	return { types, getData: (type: string) => data[type] ?? "", files } as unknown as DataTransfer;
}

test("a plain path is typed as it is, anything else in single quotes that keep it literal", () => {
	assert.equal(shellWord("/Users/me/src/app.ts", "darwin"), "/Users/me/src/app.ts");
	assert.equal(shellWord("/Users/me/My Files/a.txt", "darwin"), "'/Users/me/My Files/a.txt'");
	assert.equal(shellWord("/tmp/$HOME`x`", "linux"), "'/tmp/$HOME`x`'");
	assert.equal(shellWord("/tmp/it's", "darwin"), "'/tmp/it'\\''s'");
	assert.equal(shellWord("/Users/me/中文.txt", "darwin"), "'/Users/me/中文.txt'");
});

test("on Windows a path with a space is double-quoted, which cmd and PowerShell both read as one word", () => {
	assert.equal(shellWord("C:\\Users\\me\\a.txt", "win32"), "C:\\Users\\me\\a.txt");
	assert.equal(shellWord("C:\\Program Files\\Git", "win32"), "\"C:\\Program Files\\Git\"");
});

test("several paths are typed space-separated, with a space after to keep typing", () => {
	assert.equal(dropText(["/a", "/b c"], "darwin"), "/a '/b c' ");
	assert.equal(dropText([], "darwin"), "");
});

test("rows dragged from the file tree are read from their own type, before any files", () => {
	const drag = transfer([DRAGGED_PATHS, "text/plain"], { [DRAGGED_PATHS]: JSON.stringify(["/p/a.ts", "/p/dir"]) });
	assert.equal(carriesPaths(drag), true);
	assert.deepEqual(droppedPaths(drag), ["/p/a.ts", "/p/dir"]);
});

test("files from Finder are asked for their path the moment they are dropped", () => {
	Reflect.set(window, "plume", { files: { pathForDrop: (file: File) => `/Users/me/${file.name}` } });
	try {
		const drag = transfer(["Files"], {}, [new File(["x"], "a.txt"), new File(["y"], "b c.txt")]);
		assert.equal(carriesPaths(drag), true);
		assert.deepEqual(droppedPaths(drag), ["/Users/me/a.txt", "/Users/me/b c.txt"]);
	} finally {
		Reflect.deleteProperty(window, "plume");
	}
});

test("a drag of plain text is not this pane's to take", () => {
	assert.equal(carriesPaths(transfer(["text/plain"])), false);
});
