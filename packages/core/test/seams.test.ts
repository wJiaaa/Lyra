/**
 * Every seam, replaced.
 *
 * A capability is only a seam if swapping it changes what the app does without the code that uses
 * it being edited. Each test here does exactly that and nothing else: bind a replacement, drive the
 * ordinary path, and check the replacement is what answered.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { QueuedTask } from "../src/agent/events.ts";
import { useAgentLoop, runTurn, type AgentLoop } from "../src/agent/runner.ts";
import { runConfig } from "./run-config.ts";
import { runTool } from "../src/agent/tool-pipeline.ts";
import {
	createContext,
	EVENTS,
	LOOP,
	SCHEDULER,
	SESSION,
	SKILLS,
	STORAGE,
	type AgentLoop as AgentLoopService,
	type SkillRegistry,
	type TaskScheduler,
	type TurnPipeline,
} from "../src/kernel/index.ts";
import { nextTask, useScheduler } from "../src/runtime/scheduling.ts";
import { prepareTurn, useTurnPipeline } from "../src/runtime/turn.ts";
import type { Skill } from "../src/skills/loader.ts";
import { registeredSkills, useSkillRegistry } from "../src/skills/registry.ts";
import type { SessionStorage } from "../src/session/storage.ts";
import { SessionStore } from "../src/session/store.ts";
import { emptyUsage, type AgentRunResult, type Tool, type ToolResult } from "../src/types.ts";

test("skills: a plugin's skills reach the session", () => {
	const skill = { name: "deploy", description: "Ship it", source: "user" } as unknown as Skill;
	const registry: SkillRegistry = { register: () => () => {}, all: () => [skill] };
	useSkillRegistry(registry);
	try {
		assert.deepEqual(
			registeredSkills().map((s) => s.name),
			["deploy"],
		);
	} finally {
		useSkillRegistry(null);
		assert.deepEqual(registeredSkills(), [], "and unbinding leaves none");
	}
});

test("session: middleware amends the turn, outermost first", async () => {
	const order: string[] = [];
	useTurnPipeline([
		async (turn, next) => {
			order.push("outer");
			const out = await next({ ...turn, systemPrompt: `${turn.systemPrompt}\n[outer]` });
			return { ...out, systemPrompt: `${out.systemPrompt}\n[outer done]` };
		},
		async (turn, next) => {
			order.push("inner");
			return next({ ...turn, systemPrompt: `${turn.systemPrompt}\n[inner]` });
		},
	]);

	try {
		const turn = await prepareTurn({ systemPrompt: "base", messages: [], tools: [], cwd: "/tmp" });
		assert.deepEqual(order, ["outer", "inner"]);
		assert.equal(turn.systemPrompt, "base\n[outer]\n[inner]\n[outer done]");
	} finally {
		useTurnPipeline(null);
	}

	const untouched = await prepareTurn({ systemPrompt: "base", messages: [], tools: [], cwd: "/tmp" });
	assert.equal(untouched.systemPrompt, "base", "an empty pipeline is a no-op");
});

test("scheduler: a replacement decides what runs next", () => {
	const queue = [
		{ id: "a", text: "first", status: "queued", priority: 1 },
		{ id: "b", text: "second", status: "queued", priority: 9 },
	] as unknown as QueuedTask[];

	assert.equal(nextTask(queue)?.id, "a", "the built-in order is the order they arrived");

	// Highest priority first — the point being that nothing in the session had to know.
	const byPriority: TaskScheduler = {
		next: (tasks) =>
			[...tasks]
				.filter((t) => t.status === "queued")
				.sort((x, y) => ((y as never as { priority: number }).priority ?? 0) - ((x as never as { priority: number }).priority ?? 0))[0],
	};
	useScheduler(byPriority);
	try {
		assert.equal(nextTask(queue)?.id, "b");
	} finally {
		useScheduler(null);
		assert.equal(nextTask(queue)?.id, "a");
	}
});

test("loop: a replacement drives the turn instead", async () => {
	const seen: string[] = [];
	const stub: AgentLoop = {
		async run(config) {
			seen.push(config.session.sessionId);
			return { messages: [], usage: emptyUsage(), stopReason: "stop" } as unknown as AgentRunResult;
		},
	};
	useAgentLoop(stub);
	try {
		const result = await runTurn(runConfig({ session: { sessionId: "s1" } }), () => {});
		assert.deepEqual(seen, ["s1"]);
		assert.deepEqual(result.messages, []);
	} finally {
		useAgentLoop(null);
	}
});

test("storage: the runtime accepts any store with the right shape", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-seam-"));
	try {
		// A real store satisfies the interface, which is the claim that makes it replaceable.
		const store: SessionStorage = new SessionStore(join(root, "sessions"));
		const meta = await store.create(root, "fake/model");
		const after = await store.append(meta, { type: "title", title: "renamed" });
		assert.equal(after.title, "renamed");
		assert.equal(after.seq > meta.seq, true, "append advances the sequence");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the default context provides every capability", async () => {
	const ctx = await createContext();
	try {
		assert.deepEqual(ctx.pending(), [], "nothing left waiting");
		assert.ok(ctx.require<SessionStorage>(STORAGE));
		assert.ok(ctx.require<TaskScheduler>(SCHEDULER));
		assert.ok(ctx.require<AgentLoopService>(LOOP));
		assert.ok(ctx.require<SkillRegistry>(SKILLS));

		/*
		 * The pipeline hands back one step whatever is registered.
		 *
		 * It dispatches to the bus rather than being a snapshot of the listeners, because the host
		 * binds it once at boot and plugins register afterwards — see the test below.
		 */
		const pipeline = ctx.require<TurnPipeline>(SESSION);
		assert.equal(pipeline.all().length, 1);
		const remove = pipeline.use(async (turn, next) => next(turn));
		assert.equal(pipeline.all().length, 1);
		remove();
	} finally {
		await ctx.dispose();
	}
});

test("plugins collaborate through the bus: a listener wraps every tool call", async () => {
	const ctx = await createContext();
	const seen: string[] = [];

	try {
		// A plugin that times every call, without knowing which tools exist.
		const off = ctx.onWaterfall<[{ tool: { name: string } }], ToolResult>(EVENTS.toolCall, async (call, next) => {
			seen.push(`in:${call.tool.name}`);
			const result = await next();
			seen.push(`out:${call.tool.name}`);
			return result;
		});

		const echo = {
			name: "echo",
			execute: async () => ({ content: [{ type: "text" as const, text: "hi" }] }),
		} as unknown as Tool;

		const result = await runTool({ tool: echo, args: {}, ctx: {} as never });
		assert.equal(result.content[0]?.type === "text" && result.content[0].text, "hi", "the call still happened");
		assert.deepEqual(seen, ["in:echo", "out:echo"], "and it was wrapped on both sides");

		off();
		seen.length = 0;
		await runTool({ tool: echo, args: {}, ctx: {} as never });
		assert.deepEqual(seen, [], "withdrawing the listener leaves the call unwrapped");
	} finally {
		await ctx.dispose();
	}
});

test("a turn-pipeline step registered after boot still runs", async () => {
	const ctx = await createContext();
	try {
		const pipeline = ctx.require<TurnPipeline>(SESSION);
		// The host binds once, at boot, before any plugin has registered anything.
		useTurnPipeline(pipeline.all());

		const before = await prepareTurn({ systemPrompt: "base", messages: [], tools: [], cwd: "/tmp" });
		assert.equal(before.systemPrompt, "base", "nothing registered, nothing changed");

		const off = pipeline.use(async (turn, next) => next({ ...turn, systemPrompt: `${turn.systemPrompt}\n[late]` }));
		const after = await prepareTurn({ systemPrompt: "base", messages: [], tools: [], cwd: "/tmp" });
		assert.equal(after.systemPrompt, "base\n[late]", "a step added later is not missed");

		off();
		const removed = await prepareTurn({ systemPrompt: "base", messages: [], tools: [], cwd: "/tmp" });
		assert.equal(removed.systemPrompt, "base");
	} finally {
		useTurnPipeline(null);
		await ctx.dispose();
	}
});
