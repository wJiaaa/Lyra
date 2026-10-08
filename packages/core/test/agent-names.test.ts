import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_AGENTS } from "../src/agents-builtin.ts";

test("内置智能体不再按模型速度命名", () => {
	/*
	 * `fast`/`deep` 说的是模型跑得多快，其余五个说的是它负责什么——同一张表里两套命名法。
	 * 这条拦住它长回来。
	 */
	for (const speed of ["fast", "deep", "slow", "quick"]) {
		assert.ok(!BUILTIN_AGENTS.some((agent) => agent.name === speed), `「${speed}」是模型有多快，不是这个智能体做什么`);
	}
});
