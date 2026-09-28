import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUsage, type Message } from "@plume/core";
import { latestDeliveryTimestamp } from "../src/features/conversation/delivery-state.ts";

test("only the latest completed answer owns a delivery; a new question or active run retires it", () => {
	const answer: Message = { role: "assistant", api: "openai-responses", provider: "qa", model: "qa", content: [], timestamp: 2, stopReason: "stop", usage: emptyUsage() };
	const user: Message = { role: "user", content: [], timestamp: 1 };
	assert.equal(latestDeliveryTimestamp([user, answer], false), 2);
	assert.equal(latestDeliveryTimestamp([user, answer], true), null);
	assert.equal(latestDeliveryTimestamp([user, answer, { ...user, timestamp: 3 }], false), null);
	assert.equal(latestDeliveryTimestamp([user, { ...answer, stopReason: "toolUse" }], false), null);
	assert.equal(latestDeliveryTimestamp([user, answer, { ...user, synthetic: true }, { ...answer, timestamp: 4 }], false), 4);
});
