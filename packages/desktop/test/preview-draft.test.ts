import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import { morph } from "../src/lib/morph.ts";
import { draftArguments, draftDocument, draftPhase } from "../src/features/files/preview-draft.ts";

const draftOf = (args: Record<string, unknown>, raw: string | undefined) => draftDocument(draftArguments(args, raw));

test("草稿从还在流的参数里取 html", () => {
	assert.deepEqual(draftOf({}, '{"title":"t","html":"<body><p>hi'), { html: "<body><p>hi", css: [] });
	assert.equal(draftOf({}, '{"title":"t"'), null, "还没写到页面");
	assert.equal(draftOf({}, undefined), null);
});

test("参数解析完以后读解析好的那份，不再读原文", () => {
	assert.deepEqual(draftOf({ html: "<p>done</p>" }, '{"html":"<p>do'), { html: "<p>done</p>", css: [] });
});

test("多文件：入口那一页，样式文件原样带上；不是页面的调用没有草稿", () => {
	const raw = JSON.stringify({ files: [{ path: "style.css", content: "p{color:red}" }, { path: "main.html", content: "<p>x</p>" }], entry: "main.html" });
	assert.deepEqual(draftOf({}, raw), { html: "<p>x</p>", css: ["p{color:red}"] });
	assert.equal(draftOf({ path: "a.html" }, '{"path":"a.html"}'), null);
	assert.equal(draftOf({ id: "p1" }, '{"id":"p1"}'), null);
});

test("写到哪一部分：样式里、脚本里、页面上", () => {
	assert.equal(draftPhase("<html><head><style>body{"), "styles");
	assert.equal(draftPhase("<head><style>a{}</style></head><body><h1>"), "markup");
	assert.equal(draftPhase("<body><p>x</p><script>let a"), "script");
	assert.equal(draftPhase("<body><script>1</script><p>"), "markup");
	assert.equal(draftPhase("<STYLE>a{"), "styles");
});

function documentOf(html: string) {
	const window = new Window();
	window.document.body.innerHTML = html;
	return { window, body: window.document.body as unknown as Element };
}

test("morph：页面变长时已有的节点原地不动，只追加", () => {
	const { window, body } = documentOf('<h1 class="t">Hi</h1><p>one</p>');
	const heading = body.firstChild;
	const next = documentOf('<h1 class="t">Hi</h1><p>one two</p><ul><li>a</li></ul>');
	morph(body, next.body);
	assert.equal(body.innerHTML, '<h1 class="t">Hi</h1><p>one two</p><ul><li>a</li></ul>');
	assert.equal(body.firstChild, heading, "同一个元素，没有重建");
	void window.happyDOM.close();
	void next.window.happyDOM.close();
});

test("morph：属性跟着变，标签换了就整个换，多出来的去掉", () => {
	const { window, body } = documentOf('<div a="1" b="2"><span>x</span></div><p>gone</p>');
	const next = documentOf('<div a="3" c="4"><em>y</em></div>');
	morph(body, next.body);
	assert.equal(body.innerHTML, '<div a="3" c="4"><em>y</em></div>');
	void window.happyDOM.close();
	void next.window.happyDOM.close();
});
