/**
 * Whether a settled preview card follows its page's later height reports.
 *
 * The case that went wrong: a side panel narrowed the column, the page rewrapped taller and the card
 * grew; the panel closed, the page reported its old height, and the card refused to shrink — a
 * stretch of blank conversation under the page until it was rerun.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { followHeight, MAX_ADJUSTMENTS } from "../src/features/files/preview-height.ts";

test("同一宽度下只跟着变高，不跟着变矮", () => {
	assert.equal(followHeight({ current: 415, next: 528, resized: false, adjustments: 0 }), 528);
	assert.equal(followHeight({ current: 528, next: 415, resized: false, adjustments: 0 }), null);
	// 差几像素是页面在附和卡片自己的高度，不是内容变了。
	assert.equal(followHeight({ current: 415, next: 421, resized: false, adjustments: 0 }), null);
});

test("宽度变了是一次新测量：变矮也跟", () => {
	assert.equal(followHeight({ current: 528, next: 415, resized: true, adjustments: 0 }), 415);
	assert.equal(followHeight({ current: 415, next: 528, resized: true, adjustments: 0 }), 528);
	assert.equal(followHeight({ current: 415, next: 415, resized: true, adjustments: 0 }), null);
});

test("同一宽度下调整次数到顶就停", () => {
	assert.equal(followHeight({ current: 415, next: 600, resized: false, adjustments: MAX_ADJUSTMENTS }), null);
});
