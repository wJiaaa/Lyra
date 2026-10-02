import assert from "node:assert/strict";
import test from "node:test";
import { SessionInbox } from "../src/runtime/session-inbox.ts";
import type { Message } from "../src/types.ts";

const said = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const text = (message: Message | undefined) => (message?.content[0] as { text: string } | undefined)?.text;

test("said mid-turn, a message steers the running turn; a follow-up, or nobody to take it, queues", () => {
	const inbox = new SessionInbox();
	assert.equal(inbox.accept({ message: said("wait, not like that") }, undefined, true), "steer");
	assert.equal(inbox.accept({ message: said("after this") }, "followUp", true), "queue");
	assert.equal(inbox.accept({ message: said("loop is winding down") }, "steer", false), "queue");
	assert.deepEqual(inbox.takeSteering().map(text), ["wait, not like that"]);
	assert.deepEqual(inbox.takeSteering(), [], "taken once");
});

test("steering nobody took comes out first after the turn, ahead of what was queued later", () => {
	const inbox = new SessionInbox();
	inbox.accept({ message: said("queued"), thinking: "high" }, "followUp", true);
	inbox.accept({ message: said("orphan") }, undefined, true);
	assert.equal(inbox.empty, false);
	assert.equal(text(inbox.next()?.message), "orphan");
	const queued = inbox.next();
	assert.equal(text(queued?.message), "queued");
	assert.equal(queued?.thinking, "high", "a queued message keeps the thinking level it was sent with");
	assert.equal(inbox.next(), undefined);
	assert.equal(inbox.empty, true);
});

test("stop drops both what would steer and what was queued", () => {
	const inbox = new SessionInbox();
	inbox.accept({ message: said("a") }, undefined, true);
	inbox.accept({ message: said("b") }, "followUp", true);
	inbox.clear();
	assert.equal(inbox.empty, true);
	assert.deepEqual(inbox.takeSteering(), []);
});
