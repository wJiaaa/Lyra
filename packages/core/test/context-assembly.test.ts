import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPromptContext, buildSystemPrompt } from "../src/prompt/system.ts";
import { reconcilePrompt } from "../src/prompt/context.ts";
import { INSTRUCTION_BYTE_LIMIT } from "../src/prompt/budget.ts";
import { formatSkills } from "../src/prompt/skills.ts";
import { formatProjectMemorySources } from "../src/runtime/project-memory.ts";
import { buildContextBreakdown, textTokens, toolTokens } from "../src/runtime/context.ts";
import { DEFAULT_SETTINGS } from "../src/config/settings.ts";
import { AgentSession } from "../src/runtime/session.ts";
import { SessionLog } from "../src/runtime/session-log.ts";
import { SessionStore } from "../src/session/store.ts";
import { useTurnPipeline } from "../src/runtime/turn.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { Skill } from "../src/skills/loader.ts";
import { emptyUsage, type AssistantMessage, type LlmContext, type ModelConfig, type ProviderConfig } from "../src/types.ts";

const base = { cwd: "/fixture", tools: [], skills: [], projectInstructions: [], platform: "linux", modelName: "Fixture", isGitRepo: false };
const model: ModelConfig = { id: "fixture/model", providerId: "fixture", modelId: "model", name: "Fixture", contextWindow: 200_000, maxOutputTokens: 4096, supportsThinking: false, supportsImages: false, supportsTools: true };
const provider: ProviderConfig = { id: "fixture", name: "Fixture", baseUrl: "http://127.0.0.1:1", api: "openai-responses", apiKey: "fixture", enabled: true, models: [model] };
const reply = (): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: "done" }], api: provider.api, provider: provider.id, model: model.modelId, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });

test("sections cover the emitted prompt exactly and attribute bounded instruction bytes", async () => {
	const input = { ...base, projectInstructions: [{ path: "/fixture/AGENTS.md", content: "汉😀".repeat(30_000) }] };
	const context = await buildPromptContext(input);
	assert.equal(await buildSystemPrompt(input), context.systemPrompt);
	let end = 0;
	for (const section of context.sections) { assert.equal(section.start, end); end = section.end; }
	assert.equal(end, context.systemPrompt.length);
	const file = context.sections.find(section => section.path);
	assert.ok(file?.truncated);
	const rendered = context.systemPrompt.slice(file.start, file.end);
	assert.ok(!rendered.includes("�"));
	assert.match(rendered, /Instructions truncated at 100 KiB/);
	assert.match(rendered, /<\/project_instructions>/);
	assert.ok(Buffer.byteLength(rendered.split("\n\n[Instructions truncated")[0]) <= INSTRUCTION_BYTE_LIMIT + 100);
	const breakdown = buildContextBreakdown({ model, messages: [], ...context, builtinTools: [], mcpTools: [], skillCatalogue: "", projectInstructions: [] });
	assert.equal(breakdown.used, textTokens(context.systemPrompt));
	assert.equal(breakdown.sources?.reduce((sum, section) => sum + section.tokens, 0), breakdown.used);
	assert.equal(breakdown.memoryFiles?.[0].path, "/fixture/AGENTS.md");
});

test("skill budgets preserve discoverability, escaping and hidden-skill policy", () => {
	const skill = (index: number): Skill => ({ name: `skill-${index}`, description: "😀".repeat(300), path: `/fixture/${index}/SKILL.md`, dir: `/fixture/${index}`, content: "BODY_MUST_STAY_LAZY", source: "workspace", disableModelInvocation: false });
	const small = formatSkills([skill(0), { ...skill(1), disableModelInvocation: true }]);
	assert.equal([...small.match(/<description>(.*?)<\/description>/)![1]].length, 250);
	assert.ok(!small.includes("skill-1") && !small.includes("BODY_MUST_STAY_LAZY"));
	const catalogue = formatSkills(Array.from({ length: 150 }, (_, i) => skill(i)));
	assert.ok(!catalogue.includes("<description>"));
	assert.equal((catalogue.match(/<name>/g) ?? []).length, 150);
	assert.match(formatSkills([{ ...skill(0), name: "a&b", description: "<example>" }]), /a&amp;b/);
});

test("project memory budgets retain trust framing, closing tag and exact source attribution", async () => {
	const sources = formatProjectMemorySources([{ text: "deliberate lesson", at: 1 }], "inferred\n".repeat(500));
	assert.deepEqual(sources.map(source => source.file), ["learned.md", "MEMORY.md"]);
	const projectMemoryFiles = sources.map(source => ({ path: `/memory/${source.file}`, content: source.content }));
	const projectMemory = sources.map(source => source.content).join("");
	assert.ok(projectMemory.endsWith("</project_memory>"));
	assert.match(projectMemory, /可信度低于/);
	assert.match(projectMemory, /Memory excerpt/);
	assert.ok(projectMemory.length < 25_500 && projectMemory.split("\n").length < 210);
	const context = await buildPromptContext({ ...base, projectMemory, projectMemoryFiles });
	const detail = buildContextBreakdown({ model, messages: [], ...context, builtinTools: [], mcpTools: [], skillCatalogue: "", projectInstructions: [] });
	assert.equal(detail.projectMemory, projectMemory);
	assert.equal(detail.projectMemoryFiles?.reduce((sum, file) => sum + file.tokens, 0), detail.segments.find(segment => segment.key === "projectMemory")?.tokens);
	const oversized = formatProjectMemorySources([{ text: "x".repeat(30_000), at: 1 }], "inferred");
	assert.deepEqual(oversized.map(source => source.file), ["learned.md"]);
});

test("middleware replacement cannot keep provenance for content it removed", async () => {
	const prompt = await buildPromptContext({ ...base, projectInstructions: [{ path: "/fixture/AGENTS.md", content: "old rules" }] });
	const appended = reconcilePrompt(prompt, prompt.systemPrompt + "\nPLUGIN");
	assert.equal(appended.sections.at(-1)?.source, "extension");
	assert.deepEqual(appended.sections.slice(0, -1), prompt.sections);
	const replaced = reconcilePrompt(prompt, "PLUGIN ONLY");
	assert.deepEqual(replaced.sections.map(section => section.source), ["extension"]);
});

test("a disk read overlapping rewind cannot restore the discarded prompt", async () => {
	const root = await mkdtemp(join(tmpdir(), "lyra-context-rewind-"));
	const store = new SessionStore(root);
	const log = new SessionLog(store, () => {}, await store.create(root, model.id));
	let release!: () => void;
	const paused = new Promise<void>(resolve => { release = resolve; });
	let announce!: () => void;
	const reading = new Promise<void>(resolve => { announce = resolve; });
	try {
		await log.commit({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		await log.recordContext("FIRST", [], []);
		await log.commit(reply());
		await log.commit({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });
		await log.recordContext("SECOND", [], []);
		log.restore([...log.messages]);
		const originalRead = store.read.bind(store);
		let delay = true;
		store.read = async function* (...args) {
			const wait = delay;
			delay = false;
			yield* originalRead(...args);
			if (wait) { announce(); await paused; }
		};
		const snapshot = log.readContext();
		await reading;
		await log.truncateFrom(2);
		release();
		assert.equal((await snapshot)?.systemPrompt, "FIRST");
		assert.equal((await log.readContext())?.systemPrompt, "FIRST");
	} finally {
		release();
		await rm(root, { recursive: true, force: true });
	}
});

test("runtime statistics reuse filtered requests and recorded sources through restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "lyra-context-"));
	const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LYRA_HOME: process.env.LYRA_HOME };
	Object.assign(process.env, { HOME: root, USERPROFILE: root, LYRA_HOME: join(root, "home") });
	const settings = { ...DEFAULT_SETTINGS, providers: [provider], defaultModelId: model.id, subAgentDelegation: "off" as const, mcpServers: [], personalization: { enableMemory: false } };
	const store = new SessionStore(join(root, "sessions"));
	let sent!: LlmContext;
	let answer!: AssistantMessage;
	const session = new AgentSession({ cwd: root, store, settings, emit: () => {}, streamFn: async context => { sent = { ...context, messages: [...context.messages] }; answer = reply(); return answer; } });
	let reopened: AgentSession | undefined;
	try {
		await mkdir(join(root, ".lyra", "prompts"), { recursive: true });
		await writeFile(join(root, "AGENTS.md"), "RULES_BEFORE");
		await writeFile(join(root, ".lyra", "prompts", "identity.md"), "CUSTOM_IDENTITY");
		await session.initialize();
		await session.log.commit({ role: "user", content: [{ type: "text", text: "inspect output" }], timestamp: 1 });
		await session.log.commit({ ...reply(), content: [{ type: "toolCall", id: "large", name: "bash", arguments: { command: "fixture" } }], stopReason: "toolUse" });
		await session.log.commit({ role: "toolResult", toolName: "bash", toolCallId: "large", content: [{ type: "text", text: "x".repeat(80_000) }], isError: false, timestamp: 2 });
		useTurnPipeline([async (turn, next) => next({ ...turn, tools: [], systemPrompt: turn.systemPrompt + "\nPLUGIN_MARKER" })]);
		await session.prompt([{ type: "text", text: "hello" }]);
		assert.match(sent.systemPrompt, /CUSTOM_IDENTITY/);
		assert.match(sent.systemPrompt, /RULES_BEFORE/);
		assert.match(sent.systemPrompt, /PLUGIN_MARKER/);
		assert.equal(sent.tools.length, 0);
		assert.ok(JSON.stringify(sent.messages).length < 20_000, "statistics must see the pruned request, not the full transcript");
		const detail = await session.contextBreakdown();
		assert.ok(detail);
		assert.equal(detail.used, textTokens(sent.systemPrompt) + toolTokens(sent.tools) + estimateTokens([...sent.messages, answer]));
		assert.ok(!detail.segments.some(segment => segment.key === "systemTools"));
		assert.ok(detail.sources?.some(section => section.source === "extension"));
		await writeFile(join(root, "AGENTS.md"), "RULES_AFTER".repeat(100));
		assert.deepEqual(await session.contextBreakdown(), detail);
		const loaded = await store.load(session.meta.projectId, session.meta.id);
		assert.ok(loaded);
		reopened = new AgentSession({ cwd: root, store, settings, meta: loaded.meta, emit: () => {} });
		reopened.restore(loaded.messages, loaded.compaction, loaded.compactions);
		const restored = await reopened.contextBreakdown();
		assert.deepEqual(restored?.sources, detail.sources);
		assert.deepEqual(restored?.memoryFiles, detail.memoryFiles);
		assert.ok(!restored?.segments.some(segment => segment.key === "systemTools"));
		await session.prompt([{ type: "text", text: "next" }]);
		assert.match(sent.systemPrompt, /RULES_AFTER/);
		await session.log.truncateFrom(session.messages.length - 2);
		assert.deepEqual((await session.contextBreakdown())?.sources, detail.sources, "rewinding must discard the later prompt and request snapshot");
	} finally {
		useTurnPipeline(null);
		await session.dispose();
		await reopened?.dispose();
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});
