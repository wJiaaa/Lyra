import assert from "node:assert/strict";
import { test } from "node:test";
import { rankEntries, scoreEntry } from "../src/lib/palette.ts";

const labels = (entries: { label: string }[]) => entries.map((entry) => entry.label);

test("空查询保留全部，顺序不变", () => {
	const entries = [{ label: "b" }, { label: "a" }];
	assert.deepEqual(labels(rankEntries(entries, "  ")), ["b", "a"]);
});

test("名字整个对上 > 开头对上 > 名字里有 > 只有别名对上", () => {
	const entries = [
		{ label: "打开终端面板", keywords: ["terminal"] },
		{ label: "终端" },
		{ label: "终端设置" },
		{ label: "命令行", keywords: ["终端"] },
	];
	assert.deepEqual(labels(rankEntries(entries, "终端")), ["终端", "终端设置", "命令行", "打开终端面板"]);
});

test("不分大小写，多余空白不算", () => {
	assert.equal(scoreEntry({ label: "Git" }, "  git "), 140);
});

test("拆开的每个词都要在名字或别名里找到", () => {
	const entry = { label: "切换到深色主题", keywords: ["dark"] };
	assert.equal(scoreEntry(entry, "dark 主题"), 60);
	assert.equal(scoreEntry(entry, "dark 字体"), null);
});

test("都不匹配的被拿掉，同分的保持原来的先后", () => {
	const entries = [{ label: "设置 A" }, { label: "无关" }, { label: "设置 B" }];
	assert.deepEqual(labels(rankEntries(entries, "设置")), ["设置 A", "设置 B"]);
});
