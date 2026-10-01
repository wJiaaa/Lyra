import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_AGENTS } from "../src/agents-builtin.ts";

test("内置智能体不再按模型速度命名", () => {
	/*
	 * `fast`/`deep` 说的是模型跑得多快，其余五个说的是它负责什么——同一张表里两套命名法，读的人
	 * 得先知道 `@fast` 指的是哪一种「快」。而且它们和模型角色名重名，`fast` 的定义里写着
	 * `model: "@fast"`，自己引用自己的同名角色。这条拦住它长回来。
	 */
	for (const speed of ["fast", "deep", "slow", "quick"]) {
		assert.ok(!BUILTIN_AGENTS.some((agent) => agent.name === speed), `「${speed}」是模型有多快，不是这个智能体做什么`);
	}
});
