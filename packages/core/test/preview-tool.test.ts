import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectionNotes, previewTool, usePreviewInspector, type PreviewInspector } from "../src/tools/preview.ts";
import { writePreview } from "../src/runtime/previews.ts";
import type { ToolContext } from "../src/types.ts";

async function context(t: { after: (fn: () => unknown) => void }): Promise<ToolContext> {
	const home = await mkdtemp(join(tmpdir(), "ly-preview-tool-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	return { cwd: home, sessionId: "sess", writePreview: (input) => writePreview(home, { ...input, sessionId: "sess" }) } as ToolContext;
}

function text(result: Awaited<ReturnType<typeof previewTool.execute>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("新写的预览标记为跟随主题，旧页面不带这个标记", async (t) => {
	const ctx = await context(t);
	const result = await previewTool.execute({ html: "<p>hi</p>", title: "图" }, ctx);
	const record = (result.details as { preview: { themed?: boolean; dir: string } }).preview;
	assert.equal(record.themed, true);
	assert.equal(JSON.parse(await readFile(join(record.dir, ".preview.json"), "utf8")).themed, true);

	const legacy = await writePreview(join(record.dir, "..", ".."), { id: "old", sessionId: "s2", title: "旧", files: [{ path: "index.html", content: "x" }] });
	assert.equal(legacy.themed, undefined);
});

test("页面抛异常：不展示给用户，异常回给模型去修", async (t) => {
	const ctx = await context(t);
	let asked: Parameters<PreviewInspector>[0] | null = null;
	usePreviewInspector(async (preview) => {
		asked = preview;
		return { exceptions: ["Uncaught ReferenceError: chart is not defined (index.html:12)"], errors: [], height: 400, limit: 720 };
	});
	t.after(() => usePreviewInspector(null));

	const result = await previewTool.execute({ html: "<script>chart()</script>" }, ctx);
	assert.equal(result.isError, true);
	assert.equal((result.details as { preview?: unknown } | undefined)?.preview, undefined, "没有 preview 记录，卡片就不会画出来");
	assert.match(text(result), /chart is not defined \(index\.html:12\)/);
	assert.match(text(result), /重新调用 preview/);
	assert.equal(asked?.entry, "index.html");
	assert.equal(asked?.sessionId, "sess");
});

test("其他控制台报错照常展示、只是告诉模型；什么错都没有时不多说一句", async (t) => {
	const ctx = await context(t);
	usePreviewInspector(async () => ({ exceptions: [], errors: ["Failed to load resource: net::ERR_NAME_NOT_RESOLVED (chart.js)"] }));
	t.after(() => usePreviewInspector(null));
	const noisy = await previewTool.execute({ html: "<p>ok</p>" }, ctx);
	assert.equal(noisy.isError, undefined);
	assert.ok((noisy.details as { preview?: unknown }).preview);
	assert.match(text(noisy), /ERR_NAME_NOT_RESOLVED/);

	usePreviewInspector(async () => ({ exceptions: [], errors: [], height: 300, limit: 720 }));
	const fine = text(await previewTool.execute({ html: "<p>ok</p>" }, ctx));
	assert.doesNotMatch(fine, /报错|截掉|异常/);
});

test("检查本身失败不影响预览交付", async (t) => {
	const ctx = await context(t);
	usePreviewInspector(async () => {
		throw new Error("no browser");
	});
	t.after(() => usePreviewInspector(null));
	const result = await previewTool.execute({ html: "<p>ok</p>" }, ctx);
	assert.equal(result.isError, undefined);
	assert.ok((result.details as { preview?: unknown }).preview);
});

test("错误只回前几条，超高的页面提醒会被截掉", () => {
	const errors = Array.from({ length: 8 }, (_, index) => `e${index}`);
	const [note] = inspectionNotes({ exceptions: [], errors });
	assert.match(note, /- e4\n- ……另有 3 条/);
	assert.doesNotMatch(note, /e5/);

	assert.deepEqual(inspectionNotes({ exceptions: [], errors: [], height: 700, limit: 720 }), []);
	assert.match(inspectionNotes({ exceptions: [], errors: [], height: 1400, limit: 720 })[0], /1400px.*720px/);
	assert.deepEqual(inspectionNotes(null), []);
});

test("检查：截图回给模型，用户看不到；之后只传 id 发布", async (t) => {
	const ctx = await context(t);
	let asked: Parameters<PreviewInspector>[1];
	usePreviewInspector(async (_preview, options) => {
		asked = options;
		return { exceptions: [], errors: [], height: 900, limit: 720, screenshot: { data: "iVBOR", mimeType: "image/png" } };
	});
	t.after(() => usePreviewInspector(null));

	const check = await previewTool.execute({ html: "<p>ok</p>", title: "图", check: true }, ctx);
	assert.equal(asked?.screenshot, true);
	assert.equal(check.isError, undefined);
	assert.equal((check.details as { preview?: unknown }).preview, undefined, "检查不画卡片");
	assert.deepEqual(check.content[1], { type: "image", data: "iVBOR", mimeType: "image/png" });
	assert.match(text(check), /900px.*720px/);
	const id = (check.details as { id: string }).id;
	assert.match(text(check), new RegExp(`preview\\(\\{ id: "${id}" \\}\\)`));

	const published = await previewTool.execute({ id }, ctx);
	const record = (published.details as { preview: { id: string; themed?: boolean } }).preview;
	assert.equal(record.id, id);
	assert.equal(record.themed, true);
	assert.equal(published.content.length, 1, "发布时不再带截图");

	const again = await previewTool.execute({ id }, ctx);
	assert.equal(again.isError, true, "一个检查过的页面只发布一次");
	const elsewhere = await previewTool.execute({ id }, { ...ctx, sessionId: "other" });
	assert.equal(elsewhere.isError, true);
});

test("直接发布不要截图；检查时抛异常的页面，照原样发布会被拒", async (t) => {
	const ctx = await context(t);
	const asked: unknown[] = [];
	usePreviewInspector(async (_preview, options) => {
		asked.push(options?.screenshot);
		return { exceptions: ["Uncaught TypeError: x is undefined (index.html:3)"], errors: [] };
	});
	t.after(() => usePreviewInspector(null));

	const check = await previewTool.execute({ html: "<script>x.y</script>", check: true }, ctx);
	assert.equal(check.isError, undefined, "检查本身不算失败，异常照实说");
	assert.match(text(check), /x is undefined/);
	const publish = await previewTool.execute({ id: (check.details as { id: string }).id }, ctx);
	assert.equal(publish.isError, true);
	assert.match(text(publish), /x is undefined/);

	await previewTool.execute({ html: "<p>ok</p>" }, ctx);
	assert.deepEqual(asked, [true, false]);
});
