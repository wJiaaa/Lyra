import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatMemoryForPrompt, type MemoryEntry } from "../src/runtime/memory/memory.ts";
import { buildSystemPrompt } from "../src/prompt/system.ts";

test("formats memory correctly for prompt injection", () => {
	const entries: MemoryEntry[] = [
		{ id: "1", content: "Prefer bun over npm", createdAt: 1, updatedAt: 1 },
		{ id: "2", content: "Always use Chinese for explanations", createdAt: 2, updatedAt: 2 },
	];
	const formatted = formatMemoryForPrompt(entries);
	assert.ok(formatted.includes("<user_memory>"));
	assert.ok(formatted.includes("Prefer bun over npm"));
	assert.ok(formatted.includes("Always use Chinese for explanations"));
});

test("buildSystemPrompt incorporates custom instructions, memory, and tone", async () => {
	const prompt = await buildSystemPrompt({
		cwd: "/test",
		tools: [],
		skills: [],
		projectInstructions: [],
		customInstructions: "My custom rule: minimal diffs only.",
		memorySnippet: "<user_memory>\n- User likes Tailwind\n</user_memory>",
		tone: "concise",
		platform: "darwin",
		modelName: "test-model",
		isGitRepo: true,
		today: "2026-08-30",
	});

	assert.ok(prompt.includes("<global_user_instructions>"));
	assert.ok(prompt.includes("My custom rule: minimal diffs only."));
	assert.ok(prompt.includes("<user_memory>"));
	assert.ok(prompt.includes("User likes Tailwind"));
	assert.ok(prompt.includes("Tone and Style: Be extremely concise"));
});
