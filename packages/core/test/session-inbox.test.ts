import assert from "node:assert/strict";
import test from "node:test";
import { SessionInbox } from "../src/runtime/session-inbox.ts";
import { lettersOnly, peerMessage } from "../src/runtime/peer-letters.ts";
import type { Message, PeerLetter, UserContent } from "../src/types.ts";

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

const letter = (text: string, id: string): PeerLetter => ({ id, sessionId: "a1b2c3d4", from: "修登录 [a1b2c3]", text });
const lettersOf = (message: Message | undefined) => (message?.role === "user" ? message.peer?.map((one) => one.id) : undefined);

test("letters queued back to back come out as one message; one queued from the person stops the merge", () => {
	const inbox = new SessionInbox();
	inbox.accept({ message: peerMessage([letter("我要改 log_types.go", "L1")]) }, "followUp", true);
	inbox.accept({ message: peerMessage([letter("typecheck 过了", "L2"), letter("准备提交", "L3")]) }, "followUp", true);
	inbox.accept({ message: said("after this") }, "followUp", true);
	inbox.accept({ message: peerMessage([letter("提交好了", "L4")]) }, "followUp", true);
	const first = inbox.next()?.message;
	assert.deepEqual(lettersOf(first), ["L1", "L2", "L3"]);
	assert.deepEqual(lettersOnly(first!)?.map((one) => one.text), ["我要改 log_types.go", "typecheck 过了", "准备提交"], "merged into a letters-only message again");
	assert.equal(text(inbox.next()?.message), "after this", "the person's message keeps its place");
	assert.deepEqual(lettersOf(inbox.next()?.message), ["L4"]);
	assert.equal(inbox.empty, true);
});

test("a letter that came with background results is not taken apart to merge", () => {
	const inbox = new SessionInbox();
	const plain = peerMessage([letter("a", "L1")]);
	const withResults: Message = { ...plain, content: [...(plain.content as UserContent[]), { type: "text", text: "<background-results>…</background-results>" }] };
	inbox.accept({ message: plain }, "followUp", true);
	inbox.accept({ message: withResults }, "followUp", true);
	assert.equal(inbox.next()?.message, plain);
	assert.equal(inbox.next()?.message, withResults);
});
