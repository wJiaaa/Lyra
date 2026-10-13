/**
 * 存下来的图叫什么：从前是 `image-1760312345678.png`，下载文件夹里看不出是哪天存的。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { imageFileName } from "../src/features/image/image-out.ts";

test("a saved picture is named for the local time it was saved, keeping its type", () => {
	assert.equal(imageFileName("png", new Date(2026, 9, 3, 7, 5, 9)), "plume-image-2026-10-03-07-05-09.png");
	assert.equal(imageFileName("jpg", new Date(2026, 11, 31, 23, 59, 0)), "plume-image-2026-12-31-23-59-00.jpg");
});
