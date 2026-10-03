/**
 * `allowed-tools`, which was parsed and then enforced nowhere.
 *
 * A skill declaring `allowed-tools: [read]` could run `bash`. That is worse than the field not
 * existing: it is the line an author writes to say what their skill will not do, skills are
 * installable from a registry, and a guarantee nothing checks is a guarantee that reads as one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import { readAllowedTools } from "../src/skills/allowed-tools.ts";
import { ACTIVE_SKILL_KEY, clearActiveSkill, skillRefusal, skillTool, SKILLS_KEY, syncSkillContext } from "../src/skills/tool.ts";
import type { Skill } from "../src/skills/loader.ts";
import { builtinToolGroups } from "../src/tools/groups.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig, Tool, ToolContext } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

function skill(name: string, allowedTools?: string[]): Skill {
	return {
		name,
		description: name,
		content: `# ${name}`,
		path: `/skills/${name}/SKILL.md`,
		dir: `/skills/${name}`,
		source: "workspace",
		allowedTools,
		disableModelInvocation: false,
	};
}

function ctx(skills: Skill[]): ToolContext {
	return { cwd: "/", sessionId: "s", state: new Map<string, unknown>([[SKILLS_KEY, skills]]) } as unknown as ToolContext;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

test("duplicate skill loads are small, but compaction and changed arguments permit reloading", async () => {
	const context = ctx([skill("pdf", ["read"])]);
	const first = await skillTool.execute({ name: "pdf" }, context);
	const second = await skillTool.execute({ name: "pdf" }, context);
	assert.match(textOf(first), /# pdf/);
	assert.match(textOf(second), /already loaded/);
	assert.doesNotMatch(textOf(second), /# pdf/);
	assert.match(textOf(await skillTool.execute({ name: "pdf", args: "new task" }, context)), /# pdf/);
	syncSkillContext(context.state, []);
	assert.equal(textOf(await skillTool.execute({ name: "pdf" }, context)), textOf(first));
});

test("loading a restricted skill records what it allows", async () => {
	const context = ctx([skill("pdf", ["read", "bash"])]);
	await skillTool.execute({ name: "pdf" }, context);

	assert.deepEqual(context.state.get(ACTIVE_SKILL_KEY), { name: "pdf", allowedTools: ["read", "bash"] });
});

test("the restriction is stated in the tool result, so the model is not surprised by a refusal", async () => {
	const context = ctx([skill("pdf", ["read"])]);
	const result = await skillTool.execute({ name: "pdf" }, context);
	assert.match(textOf(result), /只用这些工具：read/);
});

test("a skill with no restriction says nothing extra and restricts nothing", async () => {
	const context = ctx([skill("open", undefined)]);
	const result = await skillTool.execute({ name: "open" }, context);

	assert.ok(!/只用这些工具/.test(textOf(result)));
	assert.equal(skillRefusal(context.state, "bash"), undefined);
});

test("an allowed tool passes", async () => {
	const context = ctx([skill("pdf", ["read"])]);
	await skillTool.execute({ name: "pdf" }, context);
	assert.equal(skillRefusal(context.state, "read"), undefined);
});

test("a tool outside the list is refused, and the refusal names the skill and the list", async () => {
	const context = ctx([skill("pdf", ["read"])]);
	await skillTool.execute({ name: "pdf" }, context);

	const refusal = skillRefusal(context.state, "bash");
	assert.ok(refusal);
	assert.match(refusal, /pdf/, "which skill did this");
	assert.match(refusal, /read/, "and what it does allow");
	assert.match(refusal, /先说明为什么/, "and what to do if the step genuinely needs it");
});

test("`skill` itself is always allowed, so a restriction is not a trap", async () => {
	/*
	 * A skill that restricted tools must not also be able to lock the session inside itself.
	 * Loading a different skill is how you leave, so that route stays open whatever the list says.
	 */
	const context = ctx([skill("pdf", ["read"])]);
	await skillTool.execute({ name: "pdf" }, context);
	assert.equal(skillRefusal(context.state, "skill"), undefined);
});

test("loading another skill replaces the restriction rather than adding to it", async () => {
	const context = ctx([skill("pdf", ["read"]), skill("shell", ["bash"])]);
	await skillTool.execute({ name: "pdf" }, context);
	await skillTool.execute({ name: "shell" }, context);

	assert.equal(skillRefusal(context.state, "bash"), undefined, "the new skill's list applies");
	assert.ok(skillRefusal(context.state, "read"), "and the old one's does not");
});

test("something the person says clears it", () => {
	/*
	 * Their message is a new instruction. A restriction left standing across it refuses work they
	 * just asked for, citing a skill they may not remember loading.
	 */
	const state = new Map<string, unknown>([[ACTIVE_SKILL_KEY, { name: "pdf", allowedTools: ["read"] }]]);
	assert.ok(skillRefusal(state, "bash"));
	clearActiveSkill(state);
	assert.equal(skillRefusal(state, "bash"), undefined);
});

test("an empty list restricts nothing, rather than everything", async () => {
	/*
	 * `allowed-tools: []` in frontmatter is far more likely to be a stub somebody left behind than
	 * a deliberate "this skill uses no tools at all". Reading it as the latter would make a skill
	 * that does nothing and explains itself with a refusal per call.
	 */
	const context = ctx([skill("stub", [])]);
	await skillTool.execute({ name: "stub" }, context);
	assert.equal(skillRefusal(context.state, "bash"), undefined);
});

test("a Claude Code list restricts to the tools it names, not to nothing", async () => {
	/*
	 * `[Read, Grep]` used to reach this check as written, and `Read` is not `read`: every tool but
	 * `skill` was refused, the two it named included.
	 */
	const context = ctx([skill("scan", readAllowedTools(["Read", "Grep"]).tools)]);
	await skillTool.execute({ name: "scan" }, context);
	assert.equal(skillRefusal(context.state, "read"), undefined);
	assert.equal(skillRefusal(context.state, "grep"), undefined);
	assert.ok(skillRefusal(context.state, "bash"));
});

test("a list that names nothing here still restricts, rather than lifting", async () => {
	/*
	 * The unmatched name is kept, not dropped. Dropped, the list would be empty — and an empty list
	 * restricts nothing (see above), which is the opposite of what a one-tool list asked for.
	 */
	const context = ctx([skill("notebook", readAllowedTools("NotebookEdit").tools)]);
	await skillTool.execute({ name: "notebook" }, context);
	assert.ok(skillRefusal(context.state, "bash"));
	assert.ok(skillRefusal(context.state, "edit"));
});

test("every built-in tool can be named the way Claude Code writes names", () => {
	/*
	 * The loader keeps its own copy of the built-in names; importing the tools would import this
	 * module's own importer. A tool added without a line there still works under its exact name, but
	 * its `WebFetch`-style spelling would be reported as matching nothing.
	 */
	for (const tool of builtinToolGroups().flat()) {
		const pascal = tool.name
			.split("_")
			.map((part) => part[0].toUpperCase() + part.slice(1))
			.join("");
		assert.deepEqual(readAllowedTools(pascal), { tools: [tool.name], problems: [] }, pascal);
	}
});

/*
 * The loop is where "the person said something new" is decided, so the lifetime of a restriction
 * is checked end to end: `runAgent` with the real `skill` tool and a `bash` that counts its runs.
 * Only the interjection drained at the top of a turn used to clear it — a new prompt starting the
 * next run and a message carried over from a finished reply both left the old skill refusing work
 * the person had just asked for.
 */
const LOOP_MODEL: ModelConfig = { id: "fake/model", providerId: "fake", modelId: "model", name: "Fake", contextWindow: 100_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const LOOP_PROVIDER: ProviderConfig = { id: "fake", name: "Fake", baseUrl: "http://l", api: "openai-responses", apiKey: "x", enabled: true, models: [LOOP_MODEL] };

function said(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "fake", model: "model", usage: emptyUsage(), stopReason, timestamp: Date.now(), content };
}
const loadSkill = (id: string) => said([{ type: "toolCall", id, name: "skill", arguments: { name: "readonly" }, argumentsText: "{}" }]);
const runBash = (id: string) => said([{ type: "toolCall", id, name: "bash", arguments: { command: "ls" }, argumentsText: "{}" }]);
const answer = (text: string) => said([{ type: "text", text }], "stop");
const person = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

function loopFixture() {
	const counts = { bash: 0 };
	const bash = {
		name: "bash",
		description: "bash",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			counts.bash += 1;
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as unknown as Tool;
	const state = new Map<string, unknown>([[SKILLS_KEY, [skill("readonly", ["read"])]]]);
	const run = async (messages: Message[], script: AssistantMessage[], options: { steering?: Message[]; duringTurn?: number } = {}) => {
		let at = 0;
		const queue: Message[] = [];
		const result = await runAgent(
			runConfig({
				session: { sessionId: "skill-lifetime", systemPrompt: "x", messages, state },
				model: {
					provider: LOOP_PROVIDER,
					model: LOOP_MODEL,
					streamFn: async () => {
						at += 1;
						if (at === options.duringTurn) queue.push(...(options.steering ?? []));
						return script[Math.min(at - 1, script.length - 1)];
					},
				},
				tools: { available: [skillTool, bash] as unknown as Tool[], env: { cwd: "/tmp" } },
				control: { maxTurns: 8, drainSteering: () => queue.splice(0, queue.length) },
			}),
			async () => {},
		);
		return [...messages, ...result.messages];
	};
	return { counts, state, run };
}

test("within one request the skill's restriction holds", async () => {
	const { counts, run } = loopFixture();
	await run([person("summarize the docs")], [loadSkill("s1"), runBash("b1"), answer("done")]);
	assert.equal(counts.bash, 0, "no new instruction arrived, so the skill still speaks for the work");
});

test("a new prompt starting the next run ends the previous skill's restriction", async () => {
	const { counts, run } = loopFixture();
	const history = await run([person("summarize the docs")], [loadSkill("s1"), answer("done")]);
	await run([...history, person("now run ls with bash")], [runBash("b1"), answer("listed")]);
	assert.equal(counts.bash, 1, "the person asked for bash in a new request");
});

test("a run resumed without anything new from the person keeps the restriction", async () => {
	/*
	 * Trailing runtime messages are not an instruction: a run that picks up after a tool result, or
	 * after a synthetic nudge, is still doing the work the skill was loaded for.
	 */
	const { counts, run } = loopFixture();
	const history = await run([person("summarize the docs")], [loadSkill("s1"), answer("done")]);
	const nudge: Message = { ...person("（自动继续）"), synthetic: true };
	await run([...history, nudge], [runBash("b1"), answer("still here")]);
	assert.equal(counts.bash, 0);
});

test("a message carried over from a finished reply ends the restriction", async () => {
	/*
	 * Queued while the model was writing a reply with no tool calls, it is drained at the bottom of
	 * that turn and injected at the top of the next — a path the interjection check never saw.
	 */
	const { counts, run } = loopFixture();
	await run([person("summarize the docs")], [loadSkill("s1"), answer("done"), runBash("b1"), answer("listed")], {
		steering: [person("now run ls with bash")],
		duringTurn: 2,
	});
	assert.equal(counts.bash, 1);
});
