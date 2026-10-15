/**
 * 批准的计划就是任务清单：`submit_plan` 被批准的那条结果，和 `todo_write` 一样把整张清单写进右上角。
 *
 * 只认 `todo_write` 的时候，批准之后清单是空的，要等模型自己再写一次——core 那边步骤早已进了清单，
 * 界面上看不到。实时（`applyToolEvent`）和重开会话（`todosFrom`）是两条路，两条都要认。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, Message, TodoItem } from "@plume/core";
import { applyToolEvent } from "../src/store/apply-tool.ts";
import { todosFrom } from "../src/store/derive.ts";

const PLAN = { title: "改登录", steps: [{ what: "加 OAuth 回调", files: ["src/auth.ts"] }, { what: "补测试" }], risks: [], unknowns: [], approvedAt: 1 };
const STEPS: TodoItem[] = [{ content: "加 OAuth 回调", status: "pending" }, { content: "补测试", status: "pending" }];

function result(toolName: string, details: unknown, at: number, isError = false): Message {
	return { role: "toolResult", toolCallId: `call-${at}`, toolName, content: [], isError, details, timestamp: at } as Message;
}

test("an approved plan is the task list when the session is reopened", () => {
	assert.deepEqual(todosFrom([result("submit_plan", { kind: "plan", plan: PLAN }, 1)]), STEPS);
});

test("a later todo_write replaces the plan's list, and a sent-back or failed plan writes none", () => {
	const ticked: TodoItem[] = [{ content: "加 OAuth 回调", status: "completed" }, { content: "补测试", status: "in_progress" }];
	assert.deepEqual(todosFrom([result("submit_plan", { kind: "plan", plan: PLAN }, 1), result("todo_write", { kind: "todo", todos: ticked }, 2)]), ticked);
	assert.deepEqual(todosFrom([result("submit_plan", { kind: "plan-feedback", feedback: "第二步不要" }, 1)]), []);
	assert.deepEqual(todosFrom([result("submit_plan", { kind: "plan", plan: PLAN }, 1, true)]), []);
});

test("approving a plan puts its steps on the task list as the result arrives", () => {
	let state = { toolRuns: {}, todos: [] as TodoItem[] };
	const set = (next: Partial<typeof state>) => void (state = { ...state, ...next });
	const event = { type: "tool_end", toolCallId: "call-1", toolName: "submit_plan", isError: false, result: { content: [], details: { kind: "plan", plan: PLAN } } } as unknown as AgentEvent;
	applyToolEvent(event, set as never, (() => state) as never);
	assert.deepEqual(state.todos, STEPS);
});
