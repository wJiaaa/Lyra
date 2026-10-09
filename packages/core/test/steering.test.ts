import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "../src/agent/events.ts";
import { runAgent } from "../src/agent/loop.ts";
import { runConfig } from "./run-config.ts";
import type { AssistantMessage, Message, ModelConfig, ProviderConfig } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";

const MODEL: ModelConfig = {
	id: "fake/model",
	providerId: "fake",
	modelId: "model",
	name: "Fake",
	contextWindow: 100_000,
	maxOutputTokens: 4096,
	supportsThinking: false,
	supportsImages: false,
	supportsTools: true,
};

const PROVIDER: ProviderConfig = {
	id: "fake",
	name: "Fake",
	baseUrl: "http://localhost",
	api: "openai-responses",
	apiKey: "x",
	enabled: true,
	models: [MODEL],
};

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fake",
		model: "model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Runs the loop against a scripted provider so the steering path can be exercised without a
 * network call. Each entry is the assistant message for one turn.
 */
async function runScripted(replies: AssistantMessage[], steeringQueue: Message[], duringFirstTurn?: () => void) {
	const seen: { prompts: Message[][]; events: AgentEvent[] } = { prompts: [], events: [] };
	let turn = 0;

	const result = await runAgent(
		runConfig({
			session: {
				sessionId: "test",
				systemPrompt: "",
				messages: [{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 }],
			},
			model: {
				provider: PROVIDER,
				model: MODEL,
				// Capture what the loop would have sent, and answer from the script.
				streamFn: async (context) => {
					seen.prompts.push([...context.messages]);
					if (turn === 0) duringFirstTurn?.();
					return replies[Math.min(turn++, replies.length - 1)];
				},
			},
			tools: { available: [], env: { cwd: "/tmp" } },
			control: { maxTurns: 8, drainSteering: () => steeringQueue.splice(0, steeringQueue.length) },
		}),
		(event) => {
			seen.events.push(event);
		},
	);

	return { result, seen };
}

test("a steering message sent mid-turn is answered, not dropped", async () => {
	const queue: Message[] = [];
	const replies = [reply("done with the first thing"), reply("and 1+1 is 2")];

	// Arrives *during* the first turn's stream, so it is only drained after that turn ends.
	const { result, seen } = await runScripted(replies, queue, () => {
		queue.push({ role: "user", content: [{ type: "text", text: "also, what is 1+1?" }], timestamp: 2 });
	});

	assert.equal(result.reason, "done");
	// The second request must contain the steering message; before the fix it was drained
	// and thrown away, so the model was re-prompted with no new input.
	const secondPrompt = seen.prompts[1];
	assert.ok(secondPrompt, "a second turn should have run");
	assert.ok(
		secondPrompt.some((m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text.includes("1+1"))),
		"steering message must reach the model",
	);
	assert.ok(result.messages.some((m) => m.role === "user" && m.content.some((c) => c.type === "text" && c.text.includes("1+1"))));
});

test("the loop stops once the steering queue is empty", async () => {
	const { result, seen } = await runScripted([reply("all done")], []);
	assert.equal(result.reason, "done");
	assert.equal(seen.prompts.length, 1, "no extra request without new input");
});

test("a steering message keeps its place after the turn it interrupted", async () => {
	const queue: Message[] = [];
	const { result } = await runScripted([reply("first answer"), reply("second answer")], queue, () => {
		queue.push({ role: "user", content: [{ type: "text", text: "interjection" }], timestamp: 2 });
	});

	// Order matters: persisting the interjection when it arrives would place it before the
	// assistant turn that was still streaming, which is not what the user saw.
	const roles = result.messages.map((m) => m.role);
	assert.deepEqual(roles, ["assistant", "user", "assistant"]);
	assert.equal(
		(result.messages[1] as { content: { text?: string }[] }).content[0].text,
		"interjection",
	);
});

test("an interjection reaches the model with a note that the original task goes on, the transcript keeps the words as typed", async () => {
	const queue: Message[] = [];
	const delivery: Message = { role: "user", synthetic: true, content: [{ type: "text", text: "（运行时送达）" }], timestamp: 3 };
	const { result, seen } = await runScripted([reply("working"), reply("adjusted, carrying on")], queue, () => {
		queue.push({ role: "user", content: [{ type: "text", text: "use tabs" }], timestamp: 2 }, delivery);
	});

	const texts = (m: Message | undefined) => (m?.role === "user" ? m.content.map((c) => (c.type === "text" ? c.text : "")) : []);
	const sent = seen.prompts[1].filter((m) => m.role === "user");
	const said = texts(sent.find((m) => texts(m).includes("use tabs")));
	assert.equal(said.length, 3, "wrapped before and after, the person's own block untouched in between");
	assert.match(said[2], /接着把原来的任务做完/);
	assert.deepEqual(texts(sent.find((m) => m.role === "user" && m.synthetic)), ["（运行时送达）"], "runtime deliveries carry their own framing");
	assert.deepEqual(texts(result.messages.find((m) => texts(m).includes("use tabs"))), ["use tabs"], "the note is never written to the transcript");
});
