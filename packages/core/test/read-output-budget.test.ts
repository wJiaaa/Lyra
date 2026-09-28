import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgedToolPruner } from "../src/runtime/aged-prune.ts";
import { readTool } from "../src/tools/read.ts";
import { readRecord, wasShown } from "../src/tools/read-state.ts";
import type { Message, ToolContext } from "../src/types.ts";

test("a large read is cut by the tool itself and marks only the lines it returned", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plume-read-budget-"));
	const file = join(dir, "data.txt");
	await writeFile(file, Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(100)}`).join("\n"), "utf8");
	const ctx: ToolContext = { cwd: dir, sessionId: "t", state: new Map() };
	const result = await readTool.execute({ path: file } as never, ctx);
	const text = result.content[0].type === "text" ? result.content[0].text : "";
	const shown = Number(/showing lines 1-(\d+) of 2000 \(output capped/.exec(text)?.[1]);
	assert.ok(shown > 100 && shown < 2000, `a continuation hint names where the output stopped: ${shown}`);
	assert.match(text, new RegExp(`offset=${shown + 1}`));

	// Nothing the loop does to a fresh result may take away what was marked as seen.
	const message: Message = { role: "toolResult", toolCallId: "r", toolName: "read", isError: false, content: result.content, timestamp: 0 };
	assert.equal(new AgedToolPruner().prepare([message])[0], message, "the fresh result reaches the model whole");

	const record = readRecord(ctx, await realpath(file))!;
	assert.ok(wasShown(record, 1, shown));
	assert.equal(wasShown(record, shown + 1, shown + 1), false, "lines past the cap were never shown");
});

test("compaction does not cut a result the model has not seen yet when it is within the fresh cap", async () => {
	const { compactIfNeeded } = await import("../src/runtime/compaction.ts");
	const { emptyUsage } = await import("../src/types.ts");
	const model = { id: "m", modelId: "m", providerId: "p", name: "m", contextWindow: 10_000, maxOutputTokens: 100, supportsThinking: false, supportsImages: false, supportsTools: true };
	const provider = { id: "p", name: "p", api: "openai-responses" as const, baseUrl: "http://localhost", apiKey: "", enabled: true, models: [model] };
	const fresh: Message = { role: "toolResult", toolCallId: "r", toolName: "read", isError: false, content: [{ type: "text", text: "l".repeat(30_000) }], timestamp: 0 };
	const history: Message[] = [
		{ role: "user", content: [{ type: "text", text: "read it" }], timestamp: 0 },
		{ role: "assistant", api: "openai-responses", provider: "p", model: "m", stopReason: "toolUse", usage: { ...emptyUsage(), input: 500 }, content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "a" } }], timestamp: 0 },
		fresh,
	];
	const result = await compactIfNeeded(history, model, provider, undefined, 0);
	assert.equal(result?.messages.find((message) => message.role === "toolResult") ?? fresh, fresh);
});
