/**
 * The script injected into every generated page, run for real against a page's markup.
 *
 * The other half of each exchange — the card posting a theme, opening a link — is checked in the
 * real window (`e2e/preview-visualizer-demo.ts`). What is checked here is what only this side
 * decides: which theme gets onto the page, what survives the cleaning, and where the injection lands.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { Window } from "happy-dom";
import { previewFragment, readOpenRequest, OPEN_MESSAGE, type PreviewTheme } from "../shared/preview.ts";
import { readableOn } from "../src/features/files/preview-theme.ts";

// `preview-protocol.ts` registers Electron protocols; nothing here touches them, so a hollow module will do.
const electronStub = `data:text/javascript,${encodeURIComponent("export const nativeImage = {}; export const net = {}; export const protocol = {}; export const session = {};")}`;
const hooks = registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "electron") return { url: electronStub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { withPreviewBridge } = await import("../electron/preview-protocol.ts");
hooks.deregister();

const PAGE = `<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>`;

async function load(fragment: string, html = PAGE) {
	const window = new Window({
		url: `ly-preview://sess/page/index.html${fragment}`,
		settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } as never,
	});
	window.document.write(withPreviewBridge(html));
	const sheet = window.document.getElementById("ly-theme")?.textContent ?? "";
	const hash = window.location.hash;
	const inline = window.document.documentElement.classList.contains("ly-inline");
	await window.happyDOM.close();
	return { sheet, hash, inline };
}

const theme: PreviewTheme = {
	scheme: "light",
	vars: { "--foreground": "#123456", "--Bad Name": "red", "--chart-1": "red;}body{display:none", "--font-sans": `"PingFang SC", sans-serif` },
};

test("片段里的主题在页面自己的样式之前写进 :root", async () => {
	const { sheet } = await load(previewFragment({ inline: true, theme }));
	assert.match(sheet, /^:root\{color-scheme:light;--foreground:#123456;/);
	assert.match(sheet, /--font-sans:"PingFang SC", sans-serif;/);
	assert.match(sheet, /html\{color:var\(--foreground\)/, "带主题的页面从回复的字体和字色起步");
});

test("变量名只认 --小写，变量值里的 ; { } 被剥掉，逃不出 :root", async () => {
	const { sheet } = await load(previewFragment({ theme }));
	assert.doesNotMatch(sheet, /Bad Name/);
	assert.match(sheet, /--chart-1:redbodydisplay:none;/);
	assert.equal(sheet.split("{").length, sheet.split("}").length, "花括号必须成对：值里的 } 一旦留下就能关掉 :root 另起一条规则");
	assert.doesNotMatch(sheet, /body\{display:none/);
});

test("没有主题的旧页面什么样式都不加", async () => {
	const { sheet, inline } = await load(previewFragment({ inline: true }));
	assert.equal(sheet, "");
	assert.equal(inline, true, "ly-inline 照旧生效");
});

test("面板里的页面是顶层文档：自己铺底色，片段留着给刷新用", async () => {
	const fragment = previewFragment({ theme });
	const { sheet, hash } = await load(fragment);
	assert.match(sheet, /html\{background:var\(--background\)\}$/);
	assert.equal(hash, fragment);
});

test("<header> 不是 <head>，没有 head 的页面注入在 doctype 之后", () => {
	const withHeader = withPreviewBridge(`<!doctype html><html><head></head><body><header class="top">x</header></body></html>`);
	assert.ok(withHeader.includes(`<head><style>`), "注入在 head 里");
	assert.ok(withHeader.includes(`<header class="top">x</header>`), "header 原样留着");

	const headless = withPreviewBridge(`<!DOCTYPE html><body><header>x</header></body>`);
	assert.ok(headless.startsWith("<!DOCTYPE html><style>"), "doctype 之前不能有任何东西，否则页面进怪异模式");
});

test("页面请求打开的地址只放行网页和邮件", () => {
	assert.equal(readOpenRequest({ [OPEN_MESSAGE]: "https://example.com/a?b=1" }), "https://example.com/a?b=1");
	assert.equal(readOpenRequest({ [OPEN_MESSAGE]: "mailto:a@b.c" }), "mailto:a@b.c");
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ly-preview://s/p/x.html", "not a url", 42]) {
		assert.equal(readOpenRequest({ [OPEN_MESSAGE]: url }), null, String(url));
	}
	assert.equal(readOpenRequest(null), null);
	assert.equal(readOpenRequest("https://example.com"), null);
});

test("主色上的字色按亮度选黑或白", () => {
	assert.equal(readableOn("#339cff"), "#ffffff");
	assert.equal(readableOn("#f5d90a"), "#111111");
	assert.equal(readableOn("rgb(255, 255, 255)"), "#111111");
	assert.equal(readableOn("not a colour"), "#ffffff");
});
