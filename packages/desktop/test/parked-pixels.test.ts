import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { withParkedPixels } from "../src/services/media.ts";

const scope = globalThis as { plume?: unknown };
/** 主进程那一侧：`files.media` 按地址交回字节，记下被问了哪些地址。 */
function media(answer: (url: string) => { data: Uint8Array; mimeType: string } | null): string[] {
	const asked: string[] = [];
	scope.plume = { files: { media: async (url: string) => (asked.push(url), answer(url)) } };
	return asked;
}
afterEach(() => {
	delete scope.plume;
});

test("withParkedPixels reads a parked image back through the main process before it goes into the draft", async () => {
	const asked = media(() => ({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: "image/png" }));
	const [parked, inline] = await withParkedPixels([
		{ id: "a", media: "5448dd02.png" },
		{ id: "b", data: "abc" },
	]);
	assert.deepEqual(asked, ["ly-media://m/5448dd02.png"]);
	assert.equal(parked.data, "iVBORw==");
	assert.equal(inline.data, "abc");
});

test("a parked file that is gone stays a name rather than failing the restore", async () => {
	media(() => null);
	const [gone] = await withParkedPixels([{ id: "a", media: "missing.png" }]);
	assert.equal(gone.data, undefined);
	assert.equal(gone.media, "missing.png");
});
