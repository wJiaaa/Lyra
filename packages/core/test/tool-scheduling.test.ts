/**
 * What happens to a batch of tool calls before and around execution: which ones share a moment,
 * how their arguments are repaired, and what a failed call is told.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolContext } from "../src/agent/run-config.ts";
import { coerceArguments, resolveTool, withParameterHint } from "../src/agent/tool-args.ts";
import { batches, runTools } from "../src/agent/tool-run.ts";
import type { Context } from "../src/kernel/context.ts";
import { approvalPlugin } from "../src/kernel/plugins/approval.ts";
import { approvalPolicy, builtInApprovalPolicy } from "../src/runtime/approval-policy.ts";
import { bashTool } from "../src/tools/bash.ts";
import type { Tool, ToolResult } from "../src/types.ts";
import { parseToolArguments } from "../src/utils/sse.ts";
import { runConfig } from "./run-config.ts";

function toolGroup(tools: Tool[], extra: Partial<AgentToolContext> = {}): AgentToolContext {
	return runConfig({ tools: { available: tools, env: { cwd: "/tmp" }, ...extra } }).tools;
}

/** What the loop hands `runTools` beside the group: who asks, the stop, a fresh state map. */
const scope = (signal?: AbortSignal) => ({ sessionId: "s", signal, state: new Map<string, unknown>() });

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall" as const, id, name, arguments: args });
const text = (result: { content: ToolResult["content"] }) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** A tool that records when it starts and finishes, and takes a few ticks to do it. */
function timed(name: string, log: string[], mode?: "parallel" | "sequential"): Tool {
	return {
		name,
		snippet: name,
		description: name,
		parameters: { type: "object", properties: { n: { type: "number" } } },
		...(mode ? { executionMode: mode } : {}),
		execute: async (args) => {
			log.push(`start:${name}${args.n ?? ""}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			log.push(`end:${name}${args.n ?? ""}`);
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

test("batches: neighbouring parallel calls share a run, a sequential call stands alone", () => {
	const parallel = (item: string) => item.startsWith("r");
	assert.deepEqual(batches(["r1", "r2", "w1", "r3", "w2", "w3", "r4"], parallel), [["r1", "r2"], ["w1"], ["r3"], ["w2"], ["w3"], ["r4"]]);
	assert.deepEqual(batches([], parallel), []);
});

test("an edit no longer holds the reads around it hostage, and results keep call order", async () => {
	const log: string[] = [];
	const tools = [timed("read", log), timed("edit", log, "sequential")];
	const results = await runTools(
		[call("1", "read", { n: 1 }), call("2", "read", { n: 2 }), call("3", "edit"), call("4", "read", { n: 3 })],
		toolGroup(tools),
		scope(),
		async () => {},
	);
	assert.deepEqual(results.map((r) => r.toolCallId), ["1", "2", "3", "4"]);
	// The two reads overlap; the edit starts only after both end; the last read only after the edit.
	assert.deepEqual(log.slice(0, 2).sort(), ["start:read1", "start:read2"]);
	assert.ok(log.indexOf("start:edit") > log.indexOf("end:read1") && log.indexOf("start:edit") > log.indexOf("end:read2"));
	assert.ok(log.indexOf("start:read3") > log.indexOf("end:edit"));
});

test("bash overlaps only when the command provably writes nothing", () => {
	const mode = (command: string, extra: Record<string, unknown> = {}) => bashTool.executionModeFor?.({ command, ...extra } as never);
	assert.equal(mode("ls -la"), "parallel");
	assert.equal(mode("git status"), "parallel");
	assert.equal(mode("npm test"), "sequential");
	assert.equal(mode("ls > out.txt"), "sequential");
	assert.equal(mode("ls", { escalate: "workspace-write" }), "sequential");
});

test("calls not yet started when stop is pressed are answered, not dropped", async () => {
	const controller = new AbortController();
	const log: string[] = [];
	const stopper: Tool = {
		name: "stop",
		snippet: "stop",
		description: "stop",
		parameters: { type: "object", properties: {} },
		executionMode: "sequential",
		execute: async () => {
			controller.abort();
			return { content: [{ type: "text", text: "stopped" }] };
		},
	};
	const results = await runTools(
		[call("1", "stop"), call("2", "edit"), call("3", "edit")],
		toolGroup([stopper, timed("edit", log, "sequential")]),
		scope(controller.signal),
		async () => {},
	);
	assert.deepEqual(results.map((r) => r.toolCallId), ["1", "2", "3"]);
	assert.deepEqual(log, [], "nothing after the stop ran");
	assert.ok(results.slice(1).every((r) => r.isError && /was not executed/.test(text(r))));
});

test("a tool named with the wrong case runs as the tool that was meant", async () => {
	const log: string[] = [];
	const results = await runTools([call("1", "Read", { n: 1 })], toolGroup([timed("read", log)]), scope(), async () => {});
	assert.equal(results[0].isError, false);
	assert.equal(results[0].toolName, "read");
	assert.deepEqual(log, ["start:read1", "end:read1"]);
});

test("an unknown tool is answered with the list of tools that exist", async () => {
	const results = await runTools([call("1", "fetch")], toolGroup([timed("read", []), timed("edit", [])]), scope(), async () => {});
	assert.equal(results[0].isError, true);
	assert.match(text(results[0]), /Available tools: read, edit\./);
});

test("resolveTool: two case-insensitive matches is a guess, so neither is picked", () => {
	const a = timed("Grep", []);
	const b = timed("grep", []);
	assert.equal(resolveTool(new Map([["Grep", a], ["grep", b]]), "GREP"), undefined);
	assert.equal(resolveTool(new Map([["grep", b]]), "Grep"), b);
});

test("coerceArguments repairs stringified arrays, objects, numbers and booleans — and nothing else", () => {
	const schema = {
		type: "object",
		properties: {
			todos: { type: "array" },
			options: { type: "object" },
			offset: { type: "integer" },
			ratio: { type: "number" },
			all: { type: "boolean" },
			pattern: { type: "string" },
		},
	};
	assert.deepEqual(
		coerceArguments({ todos: '[{"id":"1"}]', options: '{"a":1}', offset: "10", ratio: "0.5", all: "true", pattern: "[a-z]" }, schema),
		{ todos: [{ id: "1" }], options: { a: 1 }, offset: 10, ratio: 0.5, all: true, pattern: "[a-z]" },
	);
	// Not cleanly convertible: left for the tool to judge.
	assert.deepEqual(coerceArguments({ todos: "[broken", offset: "1.5", all: "yes", options: "[1]" }, schema), { todos: "[broken", offset: "1.5", all: "yes", options: "[1]" });
	// Unknown keys (aliases) are never touched, and an unchanged call keeps its identity.
	const args = { query: "x", offset: 3 };
	assert.equal(coerceArguments(args, schema), args);
});

test("coerced arguments are what the hook and the tool both see", async () => {
	const seen: unknown[] = [];
	const todo: Tool = {
		name: "todo_write",
		snippet: "t",
		description: "t",
		parameters: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] },
		execute: async (args) => {
			seen.push(args.todos);
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const hooked: unknown[] = [];
	await runTools([call("1", "todo_write", { todos: '[{"id":"a"}]' })], toolGroup([todo], { beforeToolCall: async ({ args }) => void hooked.push(args.todos) }), scope(), async () => {});
	assert.deepEqual(hooked, [[{ id: "a" }]]);
	assert.deepEqual(seen, [[{ id: "a" }]]);
});

test("a failed call whose arguments missed the schema is told what the tool accepts", () => {
	const tool = timed("grep", []);
	tool.parameters = { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] };
	const failed: ToolResult = { content: [{ type: "text", text: "no pattern" }], isError: true };
	assert.match(text(withParameterHint(failed, tool, { regex: "x" })), /`grep` accepts: pattern \(required\), glob\. Missing: pattern\. Not a parameter: regex\./);
	// A success, or a failure with well-formed arguments, is left alone.
	assert.equal(withParameterHint({ content: [] }, tool, { regex: "x" }).content.length, 0);
	assert.equal(withParameterHint(failed, tool, { pattern: "x" }), failed);
});

test("arguments encoded twice are unwrapped rather than treated as broken", () => {
	assert.deepEqual(parseToolArguments(JSON.stringify(JSON.stringify({ path: "a.ts" }))), { path: "a.ts" });
	assert.equal(parseToolArguments('"just a string"'), null);
});

test("auto mode lets through an MCP tool its server marks read-only, and nothing else from MCP", () => {
	const request = { kind: "mcp" as const, title: "t", detail: "", subject: "mcp__s__t" };
	assert.equal(approvalPolicy().assess("mcp", "mcp__s__t", "/tmp", { ...request, readOnly: true }).risky, false);
	assert.equal(approvalPolicy().assess("mcp", "mcp__s__t", "/tmp", request).risky, true);
});

test("the app's approval plugin serves the same policy the runtime falls back to", () => {
	// Two copies drifted once: the MCP rule above reached tests and not the app.
	let provided: unknown;
	approvalPlugin.apply({ provide: (_name: string, value: unknown) => void (provided = value) } as unknown as Context);
	assert.equal(provided, builtInApprovalPolicy);
});
