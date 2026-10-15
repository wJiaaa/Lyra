import assert from "node:assert/strict";
import { test } from "node:test";

import { offsetIn, rangeIn } from "../../src/features/dock/panels/plan-anchor.ts";

test("划下的一段存成位置，再按位置找回同一段字，跨了元素也一样", () => {
	const root = document.createElement("div");
	root.innerHTML = "<h1>计划</h1><ol><li>改 <code>a.ts</code> 的导出</li><li>补测试</li></ol>";
	const code = root.querySelector("code")!.firstChild!;
	const second = root.querySelectorAll("li")[1]!.firstChild!;
	const start = offsetIn(root, code, 2);
	const end = offsetIn(root, second, 1);
	const range = rangeIn(root, start, end);
	assert.equal(range?.toString(), "ts 的导出补");
	assert.equal(rangeIn(root, 0, 2)?.toString(), "计划");
	assert.equal(rangeIn(root, 5, 999), null);
});
