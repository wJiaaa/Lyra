import assert from "node:assert/strict";
import { test } from "node:test";
import { promptBlocks } from "../electron/mobile-prompt.ts";

const jpeg = { data: "aGVsbG8=", mimeType: "image/jpeg" };

test("手机消息：字在前、图在后，只有图也能发", () => {
	assert.deepEqual(promptBlocks("  看看这个  ", [jpeg]), [{ type: "text", text: "看看这个" }, { type: "image", ...jpeg }]);
	assert.deepEqual(promptBlocks("", [jpeg]), [{ type: "image", ...jpeg }]);
	assert.deepEqual(promptBlocks("只有字"), [{ type: "text", text: "只有字" }]);
});

test("手机消息：空消息、太多图、不认识的格式、超大图都当坏请求", () => {
	assert.throws(() => promptBlocks("   ", []), /Invalid input/);
	assert.throws(() => promptBlocks("x", Array.from({ length: 5 }, () => jpeg)), /Invalid input/);
	assert.throws(() => promptBlocks("x", [{ data: "aGVsbG8=", mimeType: "image/svg+xml" }]), /Invalid input/, "SVG 能带脚本，模型也不认");
	assert.throws(() => promptBlocks("x", [{ data: "a".repeat(5 * 1024 * 1024 + 1), mimeType: "image/png" }]), /Invalid input/);
	assert.throws(() => promptBlocks("x", [null]), /Invalid input/);
	assert.throws(() => promptBlocks(42), /Invalid input/);
});
