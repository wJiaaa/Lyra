/**
 * Where a transcript image is drawn from.
 *
 * A reopened conversation hands the window `media` with `data` emptied; a live tool result hands it
 * `data`. A tool card that read only `data` showed nothing for every image in a reopened session.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageBlockSrc } from "../src/features/conversation/image-block.ts";

test("parked media: thumbnail at the asked edge, full picture without one", () => {
	const refs = imageBlockSrc({ type: "image", data: "", mimeType: "image/png", media: "abc.png" }, 320);
	assert.deepEqual(refs, { src: "ly-media://m/abc.png?thumb=320", full: "ly-media://m/abc.png" });
});

test("inline data: one data URL for both", () => {
	const refs = imageBlockSrc({ type: "image", data: "AAAA", mimeType: "image/jpeg" }, 320);
	assert.deepEqual(refs, { src: "data:image/jpeg;base64,AAAA", full: "data:image/jpeg;base64,AAAA" });
});

test("no pixels at all: nothing to draw", () => {
	assert.equal(imageBlockSrc({ type: "image", data: "", mimeType: "image/png" }, 320), null);
});
