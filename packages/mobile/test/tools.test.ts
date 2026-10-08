import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@plume/client-runtime";
import { describeCalls, diffStat, latestTodos, sumStats, toolSubject } from "../src/tools.ts";
import { translate } from "../src/i18n.ts";

const t = translate("zh");

test("主语：文件只取文件名，命令和搜索词压成一行，认不出的工具取第一个字符串", () => {
	assert.equal(toolSubject("edit", { path: "packages/mobile/src/feed.ts" }), "feed.ts");
	assert.equal(toolSubject("read", { file_path: "C:\\repo\\a.ts" }), "a.ts", "Windows 路径");
	assert.equal(toolSubject("bash", { command: "pnpm  test\n--watch", description: "跑测试" }), "pnpm test --watch");
	assert.equal(toolSubject("web_fetch", { url: "https://example.com/a" }), "example.com/a");
	assert.equal(toolSubject("todo_write", { todos: [] }), "");
	assert.equal(toolSubject("mcp__github__get_issue", { limit: 3, repo: "a/b" }), "a/b");
	assert.equal(toolSubject("x", { text: "y".repeat(200) }).length, 120);
});

test("一串调用合成一句：一种动作一次就说主语，多了就数，不认识的工具用它自己的名字", () => {
	assert.equal(describeCalls([
		{ name: "read", args: { path: "a.ts" } }, { name: "read", args: { path: "b.ts" } },
		{ name: "edit", args: { path: "src/c.ts" } },
		{ name: "mcp__x", args: {} },
	], t), "读取文件 2 个、修改文件 c.ts、mcp__x");
});

test("行数：有才显示，多次编辑累加", () => {
	assert.equal(diffStat({ kind: "bash", exitCode: 0 }), null);
	assert.deepEqual(sumStats([{ added: 3, removed: 1 }, undefined, { added: 2, removed: 0 }]), { added: 5, removed: 1 });
	assert.equal(sumStats([undefined]), null);
});

test("当前计划取最近一次清单结果", () => {
	const todo = (content: string) => ({ role: "toolResult", toolCallId: content, toolName: "todo_write", content: [], details: { kind: "todo", todos: [{ content, status: "pending" }] }, timestamp: 1 }) as unknown as Message;
	assert.equal(latestTodos([]), null);
	assert.equal(latestTodos([todo("旧"), todo("新")])![0]!.content, "新");
});
