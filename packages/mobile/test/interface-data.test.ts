/**
 * 界面块在手机上的排法：网格放不下就少几列、表格里的数据不被当成 markdown、图表什么时候画条什么时候退成表。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chartView, gridColumns, MAX_BARS, tableMarkdown, tableOf } from "../src/interface-data.ts";

test("网格的 cols 是上限：手机宽度放两列，宽屏才放满", () => {
	assert.equal(gridColumns(3, 342, 10), 2);
	assert.equal(gridColumns(3, 600, 10), 3);
	assert.equal(gridColumns(1, 600, 10), 1);
	assert.equal(gridColumns(4, 140, 10), 1, "再窄也至少一列");
	assert.equal(gridColumns(undefined, 1000, 10), 3, "没写 cols 和桌面一样按 3");
});

test("表格两种写法读成同样的格子，数字列靠右", () => {
	const fromRows = tableOf(["城市", "气温"], [["厦门", 28], ["北京", 19]]);
	const fromData = tableOf(undefined, undefined, [{ 城市: "厦门", 气温: 28 }, { 城市: "北京", 气温: 19 }]);
	assert.deepEqual(fromRows, fromData);
	assert.deepEqual(fromRows?.numeric, [false, true]);
	assert.equal(tableOf([], []), null);
});

test("格子里是数据：标记字符转义、换行收成空格，竖线不会多切出一列", () => {
	const markdown = tableMarkdown({ header: ["名", "说明"], rows: [["a|b", "*重点*\n第二行"]], numeric: [false, false] });
	const lines = markdown.split("\n");
	assert.equal(lines[2], "| a\\|b | \\*重点\\* 第二行 |");
	assert.equal(lines[1], "| --- | --- |");
});

test("一个序列画成横条，饼图带占比；负数按绝对值算长度", () => {
	const view = chartView("pie", [{ name: "A", n: 3 }, { name: "B", n: 1 }], undefined, undefined);
	assert.equal(view?.kind, "bars");
	if (view?.kind !== "bars") return;
	assert.deepEqual(view.bars.map((bar) => [bar.label, bar.length, bar.share]), [["A", 1, 0.75], ["B", 1 / 3, 0.25]]);
	const signed = chartView("bar", [{ m: "1月", v: -4 }, { m: "2月", v: 2 }], "m", "v");
	assert.deepEqual(signed?.kind === "bars" ? signed.bars.map((bar) => bar.length) : null, [1, 0.5]);
});

test("多个序列、或点多到一屏放不下，改画成表", () => {
	const multi = chartView("line", [{ m: "1月", a: 1, b: 2 }], undefined, undefined);
	assert.deepEqual(multi?.kind === "table" ? multi.table.header : null, ["", "a", "b"]);
	const many = chartView("bar", Array.from({ length: MAX_BARS + 1 }, (_, at) => ({ day: String(at), v: at })), undefined, undefined);
	assert.equal(many?.kind, "table");
	assert.equal(chartView("bar", [{ name: "x" }], undefined, undefined), null, "没有数字列就什么也不画");
});
