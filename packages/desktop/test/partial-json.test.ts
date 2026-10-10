import assert from "node:assert/strict";
import { test } from "node:test";
import { partialJson } from "../src/lib/partial-json.ts";

test("完整的 JSON 原样读出", () => {
	const value = { title: "图", html: "<p>a \"b\" \\ c</p>\n", files: [{ path: "a.css", content: "x" }], n: 12.5, ok: true, none: null };
	assert.deepEqual(partialJson(JSON.stringify(value)), value);
});

test("写到一半的字符串读到写到的地方", () => {
	assert.deepEqual(partialJson('{"title":"鹈鹕","html":"<!doctype html><body><h1>Hel'), { title: "鹈鹕", html: "<!doctype html><body><h1>Hel" });
	assert.deepEqual(partialJson('{"html":"line\\nnext'), { html: "line\nnext" });
});

test("断在转义、\\u 中间、键里、冒号后：断掉的那一个字不算，前面的都在", () => {
	assert.deepEqual(partialJson('{"html":"a\\'), { html: "a" });
	assert.deepEqual(partialJson('{"html":"a\\u00'), { html: "a" });
	assert.deepEqual(partialJson('{"html":"a\\u00e9b"'), { html: "aéb" });
	assert.deepEqual(partialJson('{"title":"t","ht'), { title: "t" });
	assert.deepEqual(partialJson('{"title":"t","html":'), { title: "t" });
	assert.deepEqual(partialJson('{"title":"t","html": '), { title: "t" });
});

test("可能还在长的数字、没写完的字面量不算", () => {
	assert.deepEqual(partialJson('{"a":12'), {});
	assert.deepEqual(partialJson('{"a":12,'), { a: 12 });
	assert.deepEqual(partialJson('{"a":tr'), {});
	assert.deepEqual(partialJson('{"a":true'), { a: true });
});

test("数组里写到一半的那一项", () => {
	assert.deepEqual(partialJson('{"files":[{"path":"index.html","content":"<p>hi'), { files: [{ path: "index.html", content: "<p>hi" }] });
	assert.deepEqual(partialJson('{"files":[{"path":"a.css","content":"x"},{"pa'), { files: [{ path: "a.css", content: "x" }, {}] });
});

test("空的、坏的都不抛", () => {
	assert.equal(partialJson(""), undefined);
	assert.equal(partialJson("   "), undefined);
	assert.deepEqual(partialJson("{"), {});
	assert.deepEqual(partialJson('{"a":@'), {});
});
